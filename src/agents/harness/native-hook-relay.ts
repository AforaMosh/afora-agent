/**
 * Bridges native harness hook events through registered relay processes.
 */
import { randomUUID } from "node:crypto";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  clearNativeHookRelayBridgesForTests,
  NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS,
  NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
  readNativeHookRelayBridgeRecordIfExists,
  registerNativeHookRelayBridge,
  renewNativeHookRelayBridgeRecord,
  unregisterNativeHookRelayBridge,
  isRetryableNativeHookRelayBridgeLookupError,
} from "./native-hook-relay-bridge.js";
import {
  getNativeHookRelayProviderAdapter,
  normalizeNativeHookInvocation,
  normalizeNativeHookToolName,
  readNativeHookRelayApprovalMode,
} from "./native-hook-relay-codec.js";
import {
  buildNativeHookRelayCommandWithStateDatabase,
  resolveNativeHookRelayCommandTimeoutMs,
} from "./native-hook-relay-command.js";
import {
  nativeHookRelayEventHasLocalWork,
  nativeHookRelayEventToolMatcher,
  processNativeHookRelayInvocation,
} from "./native-hook-relay-events.js";
import {
  clearNativeHookRelayPermissionsForTests,
  formatPermissionApprovalDescriptionForTests as formatPermissionApprovalDescriptionForTestsImpl,
  permissionRequestContentFingerprintForTests as permissionRequestContentFingerprintForTestsImpl,
  permissionRequestToolInputKeyFingerprintForTests as permissionRequestToolInputKeyFingerprintForTestsImpl,
  pruneNativeHookRelayPermissionAllowAlways,
  removeNativeHookRelayPermissionState,
  removeNativeHookRelayPreToolUseApprovals,
  setNativeHookRelayDeferredToolApprovalRequesterForTests as setNativeHookRelayDeferredToolApprovalRequesterForTestsImpl,
  setNativeHookRelayPermissionApprovalRequesterForTests as setNativeHookRelayPermissionApprovalRequesterForTestsImpl,
} from "./native-hook-relay-permissions.js";
import type { NativeHookRelayDeferredToolApprovalRequester } from "./native-hook-relay-permissions.js";
import {
  MAX_NATIVE_HOOK_RELAY_INVOCATIONS,
  nativeHookRelayState,
} from "./native-hook-relay-state.js";
import type {
  ActiveNativeHookRelayRegistration,
  ActiveNativeHookRelayRegistrationHandle,
  InvokeNativeHookRelayParams,
  NativeHookRelayAttemptBinding,
  NativeHookRelayBridgeRegistration,
  NativeHookRelayEvent,
  NativeHookRelayInvocation,
  NativeHookRelayInvocationBinding,
  NativeHookRelayPermissionApprovalRequest,
  NativeHookRelayPermissionApprovalRequester,
  NativeHookRelayProcessResponse,
  NativeHookRelayRegistration,
  NativeHookRelayRenewalStatus,
  RegisterNativeHookRelayParams,
} from "./native-hook-relay-types.js";
import { NATIVE_HOOK_RELAY_EVENTS } from "./native-hook-relay-types.js";
import {
  isJsonValue,
  normalizePositiveInteger,
  readNativeHookRelayEvent,
  readNativeHookRelayProvider,
  readNonEmptyString,
  snapshotNativeHookRelayPayload,
} from "./native-hook-relay-utils.js";

export { buildNativeHookRelayCommand } from "./native-hook-relay-command.js";
export { resolveNativeHookRelayDeferredToolApproval } from "./native-hook-relay-permissions.js";
export type {
  NativeHookRelayEvent,
  NativeHookRelayProcessResponse,
  NativeHookRelayProvider,
  NativeHookRelayRegistrationHandle,
} from "./native-hook-relay-types.js";

const DEFAULT_RELAY_TTL_MS = 30 * 60 * 1000;
const log = createSubsystemLogger("agents/harness/native-hook-relay");

const { relays, relayBridges, invocations } = nativeHookRelayState;

function resolveNativeHookRelayExpiresAtMs(ttlMs: number | undefined): number | undefined {
  return resolveExpiresAtMsFromDurationMs(normalizePositiveInteger(ttlMs, DEFAULT_RELAY_TTL_MS));
}

export function registerNativeHookRelay(
  params: RegisterNativeHookRelayParams,
): ActiveNativeHookRelayRegistrationHandle {
  pruneExpiredNativeHookRelays();
  pruneNativeHookRelayPermissionAllowAlways();
  const relayId = normalizeRelayId(params.relayId) ?? randomUUID();
  const generation = normalizeRelayGeneration(params.generation) ?? randomUUID();
  const generationMismatchGraceMs = normalizePositiveInteger(params.generationMismatchGraceMs, 0);
  const now = Date.now();
  const expiresAtMs = resolveNativeHookRelayExpiresAtMs(params.ttlMs);
  if (expiresAtMs === undefined) {
    throw new Error("Native hook relay expiry is outside the supported Date range");
  }
  const allowedEvents = normalizeAllowedEvents(params.allowedEvents);
  const stateDbPath = resolveOpenClawStateSqlitePath();
  const predecessor = unregisterNativeHookRelay(relayId, undefined, {
    deferBridgeRecordRemovalMs: NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS,
  });
  const registration: ActiveNativeHookRelayRegistration = {
    relayId,
    provider: params.provider,
    generation,
    ...(generationMismatchGraceMs > 0
      ? { generationMismatchGraceExpiresAtMs: now + generationMismatchGraceMs }
      : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.config ? { config: params.config } : {}),
    runId: params.runId,
    ...(params.channelId ? { channelId: params.channelId } : {}),
    ...(params.requester ? { requester: params.requester } : {}),
    ...(params.approvalContext ? { approvalContext: params.approvalContext } : {}),
    allowedEvents,
    preToolUseLoopDetection: params.preToolUseLoopDetection !== false,
    expiresAtMs,
    preToolUseFailureProjections: new Map(),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.runBeforeToolCall ? { runBeforeToolCall: params.runBeforeToolCall } : {}),
    ...(params.assertActive ? { assertActive: params.assertActive } : {}),
    ...(params.onPreToolUseFailure ? { onPreToolUseFailure: params.onPreToolUseFailure } : {}),
  };
  relays.set(relayId, registration);
  registerNativeHookRelayBridge(registration, stateDbPath, invokeNativeHookRelay, predecessor);
  const renewStatus = (ttlMs?: number): NativeHookRelayRenewalStatus => {
    const current = relays.get(relayId);
    if (current !== registration) {
      return "dead";
    }
    const renewedExpiresAtMs = resolveNativeHookRelayExpiresAtMs(ttlMs);
    if (renewedExpiresAtMs === undefined) {
      return "unknown";
    }
    const bridge = relayBridges.get(relayId);
    if (!bridge) {
      return "unknown";
    }
    if (bridge.ownershipStatus === "foreign-owner") {
      unregisterNativeHookRelay(relayId, current);
      return "foreign-owner";
    }
    try {
      const renewal = renewNativeHookRelayBridgeRecord(
        current,
        bridge,
        renewedExpiresAtMs,
        invokeNativeHookRelay,
      );
      if (renewal === "unavailable" || renewal === "unknown") {
        return "unknown";
      }
      if (renewal === "foreign-owner") {
        log.debug("native hook relay bridge record ownership changed", { relayId });
        unregisterNativeHookRelay(relayId, current);
        return "foreign-owner";
      }
      current.expiresAtMs = renewedExpiresAtMs;
      return "live";
    } catch (error) {
      log.debug("failed to renew native hook relay bridge record", { error, relayId });
      return "unknown";
    }
  };
  const handle: ActiveNativeHookRelayRegistrationHandle = {
    ...registration,
    get expiresAtMs() {
      return registration.expiresAtMs;
    },
    shouldRelayEvent: (event) => nativeHookRelayEventHasLocalWork(registration, event),
    toolMatcherForEvent: (event) => nativeHookRelayEventToolMatcher(registration, event),
    commandForEvent: (event, options) =>
      buildNativeHookRelayCommandWithStateDatabase({
        provider: params.provider,
        relayId,
        stateDbPath,
        generation: registration.generation,
        event,
        preToolUseUnavailable:
          event === "pre_tool_use" && !nativeHookRelayEventHasLocalWork(registration, event)
            ? "noop"
            : undefined,
        nice: params.command?.nice,
        timeoutMs: resolveNativeHookRelayCommandTimeoutMs(
          params.command?.timeoutMs,
          options?.timeoutMs,
        ),
        executable: params.command?.executable,
        nodeExecutable: params.command?.nodeExecutable,
      }),
    renew: (ttlMs) => {
      renewStatus(ttlMs);
    },
    renewStatus,
    rebindAttempt: (binding) => {
      if (relays.get(relayId) !== registration) {
        return false;
      }
      applyNativeHookRelayAttemptBinding(registration, binding);
      applyNativeHookRelayAttemptBinding(handle, binding);
      return true;
    },
    unregister: () => unregisterNativeHookRelay(relayId, registration),
  };
  return handle;
}

function applyNativeHookRelayAttemptBinding(
  target: NativeHookRelayRegistration & { preToolUseLoopDetection?: boolean },
  binding: NativeHookRelayAttemptBinding,
): void {
  target.preToolUseLoopDetection = binding.preToolUseLoopDetection !== false;
  target.runId = binding.runId;
  target.config = binding.config;
  target.channelId = binding.channelId;
  target.requester = binding.requester;
  target.approvalContext = binding.approvalContext;
  target.signal = binding.signal;
  target.runBeforeToolCall = binding.runBeforeToolCall;
  target.assertActive = binding.assertActive;
  target.onPreToolUseFailure = binding.onPreToolUseFailure;
}

function unregisterNativeHookRelay(
  relayId: string,
  expectedRegistration?: ActiveNativeHookRelayRegistration,
  options?: { deferBridgeRecordRemovalMs?: number },
): ReturnType<typeof unregisterNativeHookRelayBridge> {
  if (expectedRegistration && relays.get(relayId) !== expectedRegistration) {
    return undefined;
  }
  const bridgeOwner = unregisterNativeHookRelayBridge(relayId, options);
  relays.delete(relayId);
  removeNativeHookRelayInvocations(relayId);
  removeNativeHookRelayPreToolUseApprovals(relayId);
  removeNativeHookRelayPermissionState(relayId);
  return bridgeOwner;
}

function normalizeRelayId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > 160 || !/^[A-Za-z0-9._:-]+$/u.test(trimmed)) {
    throw new Error("native hook relay id must be non-empty, compact, and URL-safe");
  }
  return trimmed;
}

function normalizeRelayGeneration(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > 160 || !/^[A-Za-z0-9._:-]+$/u.test(trimmed)) {
    throw new Error("native hook relay generation must be non-empty, compact, and URL-safe");
  }
  return trimmed;
}

export async function invokeNativeHookRelay(
  params: InvokeNativeHookRelayParams,
): Promise<NativeHookRelayProcessResponse> {
  const provider = readNativeHookRelayProvider(params.provider);
  const relayId = readNonEmptyString(params.relayId, "relayId");
  const event = readNativeHookRelayEvent(params.event);
  const registration = relays.get(relayId);
  if (!registration) {
    pruneExpiredNativeHookRelays();
    throw new Error("native hook relay not found");
  }
  const bridge = relayBridges.get(relayId);
  if (Date.now() > nativeHookRelayEffectiveExpiresAtMs(registration, bridge)) {
    unregisterNativeHookRelay(relayId, registration);
    throw new Error("native hook relay expired");
  }
  const ownershipStatus = bridge?.ownershipStatus;
  if (relays.get(relayId) !== registration || relayBridges.get(relayId) !== bridge) {
    throw new Error(NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR);
  }
  if (ownershipStatus !== "renewed") {
    if (ownershipStatus === "foreign-owner") {
      unregisterNativeHookRelay(relayId, registration);
      throw new Error(NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR);
    }
    throw new Error("native hook relay bridge ownership is not authoritative");
  }
  if (registration.provider !== provider) {
    throw new Error("native hook relay provider mismatch");
  }
  if (params.requireGeneration) {
    const generation = readNonEmptyString(params.generation, "generation");
    if (generation !== registration.generation) {
      if (!canAcceptNativeHookRelayGenerationMismatch(registration, generation)) {
        throw new Error(NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR);
      }
      log.debug("native hook relay accepted bootstrap generation mismatch", {
        relayId,
        event,
        runId: registration.runId,
      });
    }
  }
  if (!registration.allowedEvents.includes(event)) {
    throw new Error("native hook relay event not allowed");
  }
  if (!isJsonValue(params.rawPayload)) {
    throw new Error("native hook relay payload must be JSON-compatible");
  }

  const binding: NativeHookRelayInvocationBinding = { ...registration };
  const normalized = normalizeNativeHookInvocation({
    binding,
    event,
    rawPayload: params.rawPayload,
  });
  if (event === "pre_tool_use" || event === "permission_request") {
    registration.assertActive?.();
  }
  recordNativeHookRelayInvocation(normalized);
  const startedAt = Date.now();
  const response = await processNativeHookRelayInvocation({
    binding,
    invocation: normalized,
    adapter: getNativeHookRelayProviderAdapter(provider),
  });
  // Policy and approval callbacks may yield while their admitted run closes.
  // Never let a late allow cross back into the native runtime.
  if (event === "pre_tool_use" || event === "permission_request") {
    registration.assertActive?.();
  }
  if (
    normalized.toolUseId &&
    response.failureDisposition &&
    readNativeHookRelayApprovalMode(normalized.rawPayload) !== "report"
  ) {
    projectNativeHookRelayPreToolUseFailure(registration, binding.onPreToolUseFailure, {
      toolName: normalizeNativeHookToolName(normalized.toolName),
      toolCallId: normalized.toolUseId,
      disposition: response.failureDisposition,
      durationMs: Date.now() - startedAt,
    });
  }
  return response;
}

function projectNativeHookRelayPreToolUseFailure(
  registration: ActiveNativeHookRelayRegistration,
  sink: NativeHookRelayInvocationBinding["onPreToolUseFailure"],
  failure: Parameters<NonNullable<NativeHookRelayRegistration["onPreToolUseFailure"]>>[0],
): void {
  if (!sink || registration.preToolUseFailureProjections.has(failure.toolCallId)) {
    return;
  }
  const record = {
    promise: Promise.resolve().then(() => sink(failure)),
    settled: false,
  };
  registration.preToolUseFailureProjections.set(failure.toolCallId, record);
  void record.promise.then(
    () => {
      record.settled = true;
    },
    (error: unknown) => {
      record.settled = true;
      if (registration.preToolUseFailureProjections.get(failure.toolCallId) === record) {
        registration.preToolUseFailureProjections.delete(failure.toolCallId);
      }
      log.debug("native pre-tool failure projection failed", {
        error,
        relayId: registration.relayId,
        toolCallId: failure.toolCallId,
      });
    },
  );
  if (registration.preToolUseFailureProjections.size > MAX_NATIVE_HOOK_RELAY_INVOCATIONS) {
    let oldestToolCallId: string | undefined;
    for (const [toolCallId, candidate] of registration.preToolUseFailureProjections) {
      oldestToolCallId ??= toolCallId;
      if (candidate.settled) {
        registration.preToolUseFailureProjections.delete(toolCallId);
        return;
      }
    }
    if (oldestToolCallId) {
      registration.preToolUseFailureProjections.delete(oldestToolCallId);
    }
  }
}

export function hasNativeHookRelayInvocation(params: {
  relayId: string;
  event: NativeHookRelayEvent;
  toolUseId?: string;
}): boolean {
  const toolUseId = params.toolUseId?.trim();
  if (!toolUseId) {
    return false;
  }
  return invocations.some(
    (invocation) =>
      invocation.relayId === params.relayId &&
      invocation.event === params.event &&
      invocation.toolUseId === toolUseId,
  );
}

function recordNativeHookRelayInvocation(invocation: NativeHookRelayInvocation): void {
  invocations.push({
    ...invocation,
    rawPayload: snapshotNativeHookRelayPayload(invocation.rawPayload),
  });
  if (invocations.length > MAX_NATIVE_HOOK_RELAY_INVOCATIONS) {
    invocations.splice(0, invocations.length - MAX_NATIVE_HOOK_RELAY_INVOCATIONS);
  }
}

function removeNativeHookRelayInvocations(relayId: string): void {
  for (let index = invocations.length - 1; index >= 0; index -= 1) {
    if (invocations[index]?.relayId === relayId) {
      invocations.splice(index, 1);
    }
  }
}

function canAcceptNativeHookRelayGenerationMismatch(
  registration: NativeHookRelayRegistration,
  generation: string,
): boolean {
  const expiresAtMs = registration.generationMismatchGraceExpiresAtMs;
  if (typeof expiresAtMs !== "number" || Date.now() > expiresAtMs) {
    return false;
  }
  if (registration.generationMismatchGraceAcceptedGeneration) {
    return registration.generationMismatchGraceAcceptedGeneration === generation;
  }
  // Pin the first legacy generation for the original grace window. Renewal and
  // attempt rebinding must not broaden or restart this compatibility boundary.
  registration.generationMismatchGraceAcceptedGeneration = generation;
  return true;
}

function pruneExpiredNativeHookRelays(now = Date.now()): void {
  for (const [relayId, registration] of relays) {
    if (now > nativeHookRelayEffectiveExpiresAtMs(registration, relayBridges.get(relayId))) {
      unregisterNativeHookRelay(relayId, registration);
    }
  }
}

function nativeHookRelayEffectiveExpiresAtMs(
  registration: NativeHookRelayRegistration,
  bridge: NativeHookRelayBridgeRegistration | undefined,
): number {
  return bridge?.ownershipStatus === "unknown"
    ? bridge.desiredExpiresAtMs
    : registration.expiresAtMs;
}

function normalizeAllowedEvents(
  events: readonly NativeHookRelayEvent[] | undefined,
): readonly NativeHookRelayEvent[] {
  if (!events?.length) {
    return NATIVE_HOOK_RELAY_EVENTS;
  }
  return [...new Set(events)];
}

export const testing = {
  clearNativeHookRelaysForTests(): void {
    clearNativeHookRelayBridgesForTests();
    relays.clear();
    invocations.length = 0;
    clearNativeHookRelayPermissionsForTests();
  },
  getNativeHookRelayInvocationsForTests(): NativeHookRelayInvocation[] {
    return [...invocations];
  },
  getNativeHookRelayRegistrationForTests(relayId: string): NativeHookRelayRegistration | undefined {
    return relays.get(relayId);
  },
  getNativeHookRelayBridgeDirForTests(): string {
    throw new Error("native hook relay bridge files were retired");
  },
  getNativeHookRelayBridgeRegistryPathForTests(relayId: string): string {
    void relayId;
    throw new Error("native hook relay bridge files were retired");
  },
  getNativeHookRelayBridgeRecordForTests(relayId: string): Record<string, unknown> | undefined {
    const record = readNativeHookRelayBridgeRecordIfExists(relayId);
    return record ? { ...record } : undefined;
  },
  isNativeHookRelayBridgeLookupRetryableForTests(error: unknown, elapsedMs = 0): boolean {
    return isRetryableNativeHookRelayBridgeLookupError({ error, elapsedMs });
  },
  formatPermissionApprovalDescriptionForTests(
    request: NativeHookRelayPermissionApprovalRequest,
  ): string {
    return formatPermissionApprovalDescriptionForTestsImpl(request);
  },
  permissionRequestContentFingerprintForTests(
    request: NativeHookRelayPermissionApprovalRequest,
  ): string {
    return permissionRequestContentFingerprintForTestsImpl(request);
  },
  permissionRequestToolInputKeyFingerprintForTests:
    permissionRequestToolInputKeyFingerprintForTestsImpl,
  setNativeHookRelayPermissionApprovalRequesterForTests(
    requester: NativeHookRelayPermissionApprovalRequester,
  ): void {
    setNativeHookRelayPermissionApprovalRequesterForTestsImpl(requester);
  },
  setNativeHookRelayDeferredToolApprovalRequesterForTests(
    requester: NativeHookRelayDeferredToolApprovalRequester,
  ): void {
    setNativeHookRelayDeferredToolApprovalRequesterForTestsImpl(requester);
  },
} as const;
