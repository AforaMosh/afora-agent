import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  isNativeHookRelayBridgeStaleRegistrationError,
  NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
} from "./native-hook-relay-client.js";
import { nativeHookRelayState } from "./native-hook-relay-state.js";
import {
  clearNativeHookRelayBridgeRecordsForTests,
  claimNativeHookRelayBridgeRecord,
  deleteNativeHookRelayBridgeRecordIfOwned,
  pruneNativeHookRelayBridgeRecords,
  readNativeHookRelayBridgeRecord as readNativeHookRelayBridgeRecordFromStore,
  type NativeHookRelayBridgeRecord,
  type NativeHookRelayBridgeRecordOwner,
  type NativeHookRelayBridgeRecordRenewal,
} from "./native-hook-relay-store.js";
import type {
  ActiveNativeHookRelayRegistration,
  InvokeNativeHookRelayParams,
  NativeHookRelayBridgeRegistration,
  NativeHookRelayProcessResponse,
  NativeHookRelayProvider,
} from "./native-hook-relay-types.js";
import {
  isJsonObject,
  normalizePositiveInteger,
  readNonEmptyString,
} from "./native-hook-relay-utils.js";

const MAX_NATIVE_HOOK_BRIDGE_BODY_BYTES = 5_000_000;
const NATIVE_HOOK_RELAY_BRIDGE_RECOVERY_INITIAL_DELAY_MS = 25;
const NATIVE_HOOK_RELAY_BRIDGE_RECOVERY_MAX_DELAY_MS = 1_000;
const log = createSubsystemLogger("agents/harness/native-hook-relay");

export {
  isRetryableNativeHookRelayBridgeLookupError,
  NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS,
  NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
} from "./native-hook-relay-client.js";

const { relays, relayBridges } = nativeHookRelayState;

type InvokeNativeHookRelay = (
  params: InvokeNativeHookRelayParams,
) => Promise<NativeHookRelayProcessResponse>;

type NativeHookRelayBridgeRequestAuth = {
  provider: NativeHookRelayProvider;
  relayId: string;
  token: string;
  registration: ActiveNativeHookRelayRegistration;
  bridge: NativeHookRelayBridgeRegistration;
  invokeRelay: InvokeNativeHookRelay;
};

function isNativeHookRelayBridgePidDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
  }
}

export function registerNativeHookRelayBridge(
  registration: ActiveNativeHookRelayRegistration,
  stateDbPath: string,
  invokeRelay: InvokeNativeHookRelay,
  predecessor?: NativeHookRelayBridgeRecordOwner,
): void {
  // Liveness checks stay outside the write transaction. The store rereads each
  // authoritative row before deletion so renewal or replacement wins the race.
  try {
    const pruned = pruneNativeHookRelayBridgeRecords({
      currentPid: process.pid,
      isPidDead: isNativeHookRelayBridgePidDead,
      stateDbPath,
    });
    for (const row of pruned) {
      log.debug("pruned stale native hook relay bridge record", {
        relayId: row.relayId,
        stalePid: row.pid,
        currentPid: process.pid,
        reason: row.reason,
      });
    }
  } catch (error) {
    log.debug("native hook relay bridge record prune skipped", { error });
  }
  const localPredecessor = unregisterNativeHookRelayBridge(registration.relayId);
  const token = randomUUID();
  const server = createServer();
  let ownershipStatus: NativeHookRelayBridgeRegistration["ownershipStatus"];
  try {
    ownershipStatus = claimNativeHookRelayBridgeRecord({
      record: {
        relayId: registration.relayId,
        pid: process.pid,
        hostname: "127.0.0.1",
        port: 0,
        token,
        expiresAtMs: registration.expiresAtMs,
      },
      predecessor: predecessor ?? localPredecessor,
      stateDbPath,
    });
  } catch (error) {
    ownershipStatus = "unknown";
    log.debug("failed to claim native hook relay bridge record", {
      error,
      relayId: registration.relayId,
    });
  }
  const bridge: NativeHookRelayBridgeRegistration = {
    relayId: registration.relayId,
    stateDbPath,
    token,
    server,
    ownershipStatus,
    ...((predecessor ?? localPredecessor) ? { predecessor: predecessor ?? localPredecessor } : {}),
    listenerStatus: "idle",
    desiredExpiresAtMs: registration.expiresAtMs,
    recoveryAttempt: 0,
  };
  configureNativeHookRelayBridgeServer(registration, bridge, server, invokeRelay);
  relayBridges.set(registration.relayId, bridge);
  if (bridge.ownershipStatus === "renewed") {
    startNativeHookRelayBridgeServer(registration, bridge, invokeRelay);
  } else if (bridge.ownershipStatus === "unknown") {
    scheduleNativeHookRelayBridgeRecovery(registration, bridge, invokeRelay);
  }
}

function configureNativeHookRelayBridgeServer(
  registration: ActiveNativeHookRelayRegistration,
  bridge: NativeHookRelayBridgeRegistration,
  server: NativeHookRelayBridgeRegistration["server"],
  invokeRelay: InvokeNativeHookRelay,
): void {
  server.on("request", (req, res) => {
    void handleNativeHookRelayBridgeRequest(req, res, {
      provider: registration.provider,
      relayId: registration.relayId,
      token: bridge.token,
      registration,
      bridge,
      invokeRelay,
    });
  });
  server.on("error", (error) => {
    if (relayBridges.get(registration.relayId) !== bridge || bridge.server !== server) {
      return;
    }
    bridge.ownershipStatus = "unknown";
    bridge.listenerStatus = "failed";
    closeNativeHookRelayBridgeServer(server);
    scheduleNativeHookRelayBridgeRecovery(registration, bridge, invokeRelay);
    log.debug("native hook relay bridge server error", { error, relayId: registration.relayId });
  });
}

function isCurrentStartingNativeHookRelayBridgeServer(
  registration: ActiveNativeHookRelayRegistration,
  bridge: NativeHookRelayBridgeRegistration,
  server: NativeHookRelayBridgeRegistration["server"],
): boolean {
  return (
    relays.get(registration.relayId) === registration &&
    relayBridges.get(registration.relayId) === bridge &&
    bridge.server === server &&
    bridge.listenerStatus === "starting"
  );
}

function startNativeHookRelayBridgeServer(
  registration: ActiveNativeHookRelayRegistration,
  bridge: NativeHookRelayBridgeRegistration,
  invokeRelay: InvokeNativeHookRelay,
): void {
  if (bridge.listenerStatus === "starting" || bridge.listenerStatus === "listening") {
    return;
  }
  if (bridge.listenerStatus === "failed") {
    closeNativeHookRelayBridgeServer(bridge.server);
    const replacement = createServer();
    bridge.server = replacement;
    bridge.listenerStatus = "idle";
    configureNativeHookRelayBridgeServer(registration, bridge, replacement, invokeRelay);
  }
  bridge.listenerStatus = "starting";
  const { server } = bridge;
  server.listen(0, "127.0.0.1", () => {
    if (!isCurrentStartingNativeHookRelayBridgeServer(registration, bridge, server)) {
      closeNativeHookRelayBridgeServer(server);
      return;
    }
    try {
      bridge.listenerStatus = "listening";
      const renewal = renewNativeHookRelayBridgeRecord(
        registration,
        bridge,
        bridge.desiredExpiresAtMs,
        invokeRelay,
      );
      bridge.ownershipStatus = renewal === "unavailable" ? "unknown" : renewal;
      bridge.listenerStatus = bridge.ownershipStatus === "renewed" ? "listening" : "failed";
      if (bridge.listenerStatus === "listening") {
        resetNativeHookRelayBridgeRecovery(bridge);
      }
      if (bridge.listenerStatus === "failed") {
        closeNativeHookRelayBridgeServer(server);
        if (bridge.ownershipStatus === "unknown") {
          scheduleNativeHookRelayBridgeRecovery(registration, bridge, invokeRelay);
        }
      }
    } catch (error) {
      bridge.ownershipStatus = "unknown";
      bridge.listenerStatus = "failed";
      closeNativeHookRelayBridgeServer(server);
      scheduleNativeHookRelayBridgeRecovery(registration, bridge, invokeRelay);
      log.debug("failed to publish native hook relay bridge record", {
        error,
        relayId: registration.relayId,
      });
    }
  });
  server.unref();
}

function scheduleNativeHookRelayBridgeRecovery(
  registration: ActiveNativeHookRelayRegistration,
  bridge: NativeHookRelayBridgeRegistration,
  invokeRelay: InvokeNativeHookRelay,
): void {
  if (bridge.recoveryTimer || bridge.ownershipStatus === "foreign-owner") {
    return;
  }
  const delayMs = Math.min(
    NATIVE_HOOK_RELAY_BRIDGE_RECOVERY_MAX_DELAY_MS,
    NATIVE_HOOK_RELAY_BRIDGE_RECOVERY_INITIAL_DELAY_MS * 2 ** bridge.recoveryAttempt,
  );
  bridge.recoveryAttempt = Math.min(bridge.recoveryAttempt + 1, 6);
  const timer = setTimeout(() => {
    bridge.recoveryTimer = undefined;
    if (
      relays.get(registration.relayId) !== registration ||
      relayBridges.get(registration.relayId) !== bridge ||
      Date.now() > bridge.desiredExpiresAtMs ||
      bridge.listenerStatus === "starting" ||
      (bridge.listenerStatus === "listening" && bridge.ownershipStatus === "renewed")
    ) {
      return;
    }
    try {
      const record = resolveNativeHookRelayBridgeRecord(
        registration,
        bridge,
        bridge.desiredExpiresAtMs,
      );
      if (!record) {
        bridge.ownershipStatus = "unknown";
        scheduleNativeHookRelayBridgeRecovery(registration, bridge, invokeRelay);
        return;
      }
      bridge.ownershipStatus = claimNativeHookRelayBridgeRecord({
        record,
        predecessor: bridge.predecessor,
        stateDbPath: bridge.stateDbPath,
      });
      if (bridge.ownershipStatus === "renewed") {
        registration.expiresAtMs = record.expiresAtMs;
        if (record.port > 0) {
          resetNativeHookRelayBridgeRecovery(bridge);
        }
        startNativeHookRelayBridgeServer(registration, bridge, invokeRelay);
      } else if (bridge.ownershipStatus === "unknown") {
        scheduleNativeHookRelayBridgeRecovery(registration, bridge, invokeRelay);
      } else {
        resetNativeHookRelayBridgeRecovery(bridge);
      }
    } catch (error) {
      bridge.ownershipStatus = "unknown";
      log.debug("failed to recover native hook relay bridge listener", {
        error,
        relayId: registration.relayId,
      });
      scheduleNativeHookRelayBridgeRecovery(registration, bridge, invokeRelay);
    }
  }, delayMs);
  timer.unref();
  bridge.recoveryTimer = timer;
}

function resetNativeHookRelayBridgeRecovery(bridge: NativeHookRelayBridgeRegistration): void {
  if (bridge.recoveryTimer) {
    clearTimeout(bridge.recoveryTimer);
    bridge.recoveryTimer = undefined;
  }
  bridge.recoveryAttempt = 0;
}

function closeNativeHookRelayBridgeServer(
  server: NativeHookRelayBridgeRegistration["server"],
): void {
  if (server.listening) {
    server.close();
    return;
  }
  // A superseded server can still be between listen() and its callback. Close
  // it if that callback wins so stale recovery never leaves a hidden listener.
  server.once("listening", () => server.close());
}

function retryNativeHookRelayBridgePublication(
  registration: ActiveNativeHookRelayRegistration,
  bridge: NativeHookRelayBridgeRegistration,
  expiresAtMs: number,
  invokeRelay: InvokeNativeHookRelay,
): NativeHookRelayBridgeRecordRenewal {
  bridge.desiredExpiresAtMs = expiresAtMs;
  const record = resolveNativeHookRelayBridgeRecord(registration, bridge, expiresAtMs);
  if (!record) {
    return "unknown";
  }
  const renewal = claimNativeHookRelayBridgeRecord({
    record,
    predecessor: bridge.predecessor,
    stateDbPath: bridge.stateDbPath,
  });
  bridge.ownershipStatus = renewal;
  if (renewal === "unknown") {
    scheduleNativeHookRelayBridgeRecovery(registration, bridge, invokeRelay);
  } else if (renewal === "renewed") {
    registration.expiresAtMs = record.expiresAtMs;
    if (record.port > 0) {
      resetNativeHookRelayBridgeRecovery(bridge);
    }
  } else if (renewal === "foreign-owner") {
    resetNativeHookRelayBridgeRecovery(bridge);
  }
  if (renewal === "renewed") {
    startNativeHookRelayBridgeServer(registration, bridge, invokeRelay);
  }
  return renewal;
}

function resolveNativeHookRelayBridgeRecord(
  registration: ActiveNativeHookRelayRegistration,
  bridge: NativeHookRelayBridgeRegistration,
  expiresAtMs = registration.expiresAtMs,
): NativeHookRelayBridgeRecord | undefined {
  if (bridge.listenerStatus !== "listening") {
    return {
      relayId: registration.relayId,
      pid: process.pid,
      hostname: "127.0.0.1",
      port: 0,
      token: bridge.token,
      expiresAtMs,
    };
  }
  const address = bridge.server.address();
  if (!address || typeof address === "string") {
    log.debug("native hook relay bridge server address unavailable", {
      relayId: registration.relayId,
    });
    return undefined;
  }
  return {
    relayId: registration.relayId,
    pid: process.pid,
    hostname: "127.0.0.1",
    port: address.port,
    token: bridge.token,
    expiresAtMs,
  };
}

export function renewNativeHookRelayBridgeRecord(
  registration: ActiveNativeHookRelayRegistration,
  bridge: NativeHookRelayBridgeRegistration,
  expiresAtMs: number,
  invokeRelay: InvokeNativeHookRelay,
): NativeHookRelayBridgeRecordRenewal | "unavailable" {
  bridge.desiredExpiresAtMs = expiresAtMs;
  if (bridge.ownershipStatus === "foreign-owner") {
    return "foreign-owner";
  }
  if (bridge.ownershipStatus === "unknown") {
    return retryNativeHookRelayBridgePublication(registration, bridge, expiresAtMs, invokeRelay);
  }
  const record = resolveNativeHookRelayBridgeRecord(registration, bridge, expiresAtMs);
  if (!record) {
    bridge.ownershipStatus = "unknown";
    scheduleNativeHookRelayBridgeRecovery(registration, bridge, invokeRelay);
    return "unavailable";
  }
  try {
    const renewal = claimNativeHookRelayBridgeRecord({
      record,
      stateDbPath: bridge.stateDbPath,
    });
    bridge.ownershipStatus = renewal;
    if (renewal === "unknown") {
      scheduleNativeHookRelayBridgeRecovery(registration, bridge, invokeRelay);
    } else if (renewal === "renewed") {
      registration.expiresAtMs = record.expiresAtMs;
      if (record.port > 0) {
        resetNativeHookRelayBridgeRecovery(bridge);
      }
    } else if (renewal === "foreign-owner") {
      resetNativeHookRelayBridgeRecovery(bridge);
    }
    return renewal;
  } catch (error) {
    bridge.ownershipStatus = "unknown";
    scheduleNativeHookRelayBridgeRecovery(registration, bridge, invokeRelay);
    log.debug("failed to renew native hook relay bridge ownership", {
      error,
      relayId: registration.relayId,
    });
    return "unknown";
  }
}

export function unregisterNativeHookRelayBridge(
  relayId: string,
  options?: { deferBridgeRecordRemovalMs?: number },
): NativeHookRelayBridgeRecordOwner | undefined {
  const bridge = relayBridges.get(relayId);
  if (!bridge) {
    return undefined;
  }
  relayBridges.delete(relayId);
  resetNativeHookRelayBridgeRecovery(bridge);
  closeNativeHookRelayBridgeServer(bridge.server);
  const removeRecord = () => {
    try {
      deleteNativeHookRelayBridgeRecordIfOwned({ ...bridge, pid: process.pid });
    } catch (error) {
      log.debug("failed to remove native hook relay bridge record", { error, relayId });
    }
  };
  const deferBridgeRecordRemovalMs = normalizePositiveInteger(
    options?.deferBridgeRecordRemovalMs,
    0,
  );
  if (deferBridgeRecordRemovalMs > 0) {
    // During stable-id replacement, retain the old locator until the successor
    // upserts. The token-scoped timer cannot delete that successor.
    const timeout = setTimeout(removeRecord, deferBridgeRecordRemovalMs);
    timeout.unref();
    return { pid: process.pid, token: bridge.token };
  }
  removeRecord();
  return { pid: process.pid, token: bridge.token };
}

async function handleNativeHookRelayBridgeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  auth: NativeHookRelayBridgeRequestAuth,
): Promise<void> {
  try {
    if (req.method !== "POST" || req.url !== "/invoke") {
      writeNativeHookRelayBridgeJson(res, 404, { ok: false, error: "not found" });
      return;
    }
    if (req.headers.authorization !== `Bearer ${auth.token}`) {
      writeNativeHookRelayBridgeJson(res, 403, { ok: false, error: "forbidden" });
      return;
    }
    if (!isCurrentNativeHookRelayBridgeRequest(auth)) {
      writeNativeHookRelayBridgeJson(res, 410, {
        ok: false,
        error: NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
      });
      return;
    }
    const body = await readNativeHookRelayBridgeBody(req);
    const payload = readNativeHookRelayBridgePayload(JSON.parse(body));
    if (payload.provider !== auth.provider || payload.relayId !== auth.relayId) {
      writeNativeHookRelayBridgeJson(res, 403, {
        ok: false,
        error: "native hook relay bridge target mismatch",
      });
      return;
    }
    if (!isCurrentNativeHookRelayBridgeRequest(auth)) {
      writeNativeHookRelayBridgeJson(res, 410, {
        ok: false,
        error: NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
      });
      return;
    }
    const result = await auth.invokeRelay({ ...payload, requireGeneration: true });
    writeNativeHookRelayBridgeJson(res, 200, { ok: true, result });
  } catch (error) {
    writeNativeHookRelayBridgeJson(
      res,
      isNativeHookRelayBridgeStaleRegistrationError(error) ? 410 : 500,
      { ok: false, error: error instanceof Error ? error.message : String(error) },
    );
  }
}

function isCurrentNativeHookRelayBridgeRequest(auth: NativeHookRelayBridgeRequestAuth): boolean {
  return (
    relays.get(auth.relayId) === auth.registration && relayBridges.get(auth.relayId) === auth.bridge
  );
}

async function readNativeHookRelayBridgeBody(req: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_NATIVE_HOOK_BRIDGE_BODY_BYTES) {
      throw new Error("native hook relay bridge payload too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function readNativeHookRelayBridgePayload(value: unknown): InvokeNativeHookRelayParams {
  if (!isJsonObject(value)) {
    throw new Error("native hook relay bridge payload must be an object");
  }
  return {
    provider: value.provider,
    relayId: value.relayId,
    generation: readNonEmptyString(value.generation, "generation"),
    event: value.event,
    rawPayload: value.rawPayload,
  };
}

function writeNativeHookRelayBridgeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function readNativeHookRelayBridgeRecordIfExists(
  relayId: string,
  stateDbPath?: string,
): NativeHookRelayBridgeRecord | undefined {
  try {
    return readNativeHookRelayBridgeRecordFromStore({ relayId, stateDbPath });
  } catch (error) {
    log.debug("failed to read native hook relay bridge record", { error, relayId });
  }
  return undefined;
}

export function clearNativeHookRelayBridgesForTests(): void {
  for (const relayId of relayBridges.keys()) {
    unregisterNativeHookRelayBridge(relayId);
  }
  clearNativeHookRelayBridgeRecordsForTests();
}
