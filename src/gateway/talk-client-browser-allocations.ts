import { randomUUID } from "node:crypto";
import { retryAsync } from "../infra/retry.js";
import { CLIENT_VOICE_TERMINAL_ACK_GRACE_MS } from "../talk/voice-transcript.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import {
  acquireTalkConnectionLease,
  assertTalkConnectionActive,
  registerTalkConnectionCleanup,
} from "./talk-session-registry.js";
type Identity = { agentId: string; sessionKey: string; voiceSessionId: string };
type Mutation = Identity & { allocationId: string; connId: string };
type Close = Identity & { allocationId?: string; connId?: string };
type Slot = "candidate" | "active";
type BrowserAllocationDurableState = "ephemeral" | "existing" | "created";
type BrowserAllocationTerminal = { outcome: "completed" | "error"; message?: string };
type BrowserAllocationMutationResult =
  | { state: "committed" | "aborted" }
  | { state: "terminal"; terminal: BrowserAllocationTerminal };
type BrowserAllocation = Identity & {
  allocationId: string;
  connId: string;
  legacyAutoCommit?: true;
  cancel: () => Promise<void>;
  activateEffects: () => void;
  retireEffects?: () => void;
  durableState: BrowserAllocationDurableState;
  claimDurable: () => boolean;
  closeDurable: () => Promise<void>;
  broadcast: GatewayBroadcastToConnIdsFn;
  warn: (message: string) => void;
  released?: boolean;
  retirement?: Promise<void>;
  terminal?: BrowserAllocationTerminal;
};
type Owner = Partial<Record<Slot, BrowserAllocation>> & {
  durableState: BrowserAllocationDurableState;
  closeDurable?: () => Promise<void>;
  retirements: Set<Promise<void>>;
  closing?: Promise<void>;
};
type Prepare = Omit<BrowserAllocation, "released" | "retirement" | "terminal">;
type BrowserAllocationCloseResult = "settled" | "ownerless-exact" | "ownerless-legacy";
const owners = new Map<string, Owner>();
const slots = ["candidate", "active"] as const;
export const allocateBrowserAllocationId = randomUUID;
const durableStateRank: Record<BrowserAllocationDurableState, number> = {
  ephemeral: 0,
  existing: 1,
  created: 2,
};
const keyOf = (value: Identity) => `${value.agentId}\0${value.sessionKey}\0${value.voiceSessionId}`;
const slotOf = (owner: Owner, allocationId: string) =>
  slots.find((slot) => owner[slot]?.allocationId === allocationId);
function requireConn(allocation: BrowserAllocation, connId: string): void {
  if (allocation.connId !== connId) {
    throw new Error("browser Talk allocation belongs to another connection");
  }
}
const viable = (owner: Owner) => slots.some((slot) => owner[slot] && !owner[slot]?.released);
const warnCleanup = (allocation: BrowserAllocation, phase: string, error: unknown) =>
  allocation.warn(`browser Talk ${phase} cleanup failed: ${String(error)}`);
const cancel = (allocation: BrowserAllocation) =>
  allocation.cancel().catch((error: unknown) => warnCleanup(allocation, "allocation", error));
function retireEffects(allocation: BrowserAllocation): void {
  const retire = allocation.retireEffects;
  allocation.retireEffects = undefined;
  retire?.();
}
function promoteDurableState(owner: Owner, allocation: BrowserAllocation, committed = false): void {
  if (durableStateRank[allocation.durableState] > durableStateRank[owner.durableState]) {
    owner.durableState = allocation.durableState;
  }
  if (
    (allocation.durableState === "created" && (!owner.closeDurable || committed)) ||
    (allocation.durableState === "existing" && committed)
  ) {
    owner.closeDurable = allocation.closeDurable;
  }
}
function retire(allocation?: BrowserAllocation): Promise<void> | undefined {
  if (!allocation) {
    return undefined;
  }
  if (allocation.retirement) {
    return allocation.retirement;
  }
  allocation.released = true;
  retireEffects(allocation);
  allocation.retirement = allocation.terminal ? Promise.resolve() : cancel(allocation);
  return allocation.retirement;
}
function trackRetirement(owner: Owner, allocation?: BrowserAllocation): Promise<void> | undefined {
  const retirement = retire(allocation);
  if (!retirement || owner.retirements.has(retirement)) {
    return retirement;
  }
  owner.retirements.add(retirement);
  void retirement.then(
    () => owner.retirements.delete(retirement),
    () => owner.retirements.delete(retirement),
  );
  return retirement;
}
async function drainRetirements(owner: Owner): Promise<void> {
  while (owner.retirements.size > 0) {
    await Promise.all(owner.retirements);
  }
}
function close(owner: Owner): Promise<void> {
  const closeDurable = owner.closeDurable;
  if (!closeDurable) {
    return Promise.resolve();
  }
  owner.closing ??= retryAsync(closeDurable, {
    attempts: 3,
    delayMs: ({ attempt }) => [500, 2_000][attempt - 1] ?? 0,
    jitter: 0,
    sleep: (delayMs) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs).unref();
      }),
  }).catch((error: unknown) => {
    owner.closing = undefined;
    throw error;
  });
  return owner.closing;
}
async function closeIfEmpty(key: string, owner: Owner): Promise<void> {
  await drainRetirements(owner);
  if (viable(owner)) {
    return;
  }
  if (owner.closeDurable) {
    await close(owner);
  }
  if (owners.get(key) === owner && !viable(owner)) {
    owners.delete(key);
  }
}
function ensureBrowserConnectionCleanup(connId: string): void {
  registerTalkConnectionCleanup(connId, "browser-allocation", () =>
    closeBrowserAllocationsForConnection(connId),
  );
}
export function acquireBrowserCreationLease(connId: string) {
  ensureBrowserConnectionCleanup(connId);
  return acquireTalkConnectionLease(connId, "browser Talk connection closed during startup");
}
async function release(key: string, owner: Owner, slot: Slot): Promise<void> {
  const allocation = owner[slot];
  if (!allocation) {
    return;
  }
  await trackRetirement(owner, allocation);
  if (viable(owner)) {
    if (owner[slot] === allocation) {
      owner[slot] = undefined;
    }
    return;
  }
  await closeIfEmpty(key, owner);
}
export async function prepareBrowserAllocation(params: Prepare) {
  const key = keyOf(params);
  const owner = owners.get(key) ?? {
    durableState: "ephemeral",
    retirements: new Set<Promise<void>>(),
  };
  const allocation: BrowserAllocation = params;
  ensureBrowserConnectionCleanup(params.connId);
  if (owner.closing) {
    await trackRetirement(owner, allocation);
    throw new Error("browser Talk session is closing");
  }
  promoteDurableState(owner, allocation);
  owners.set(key, owner);
  try {
    assertTalkConnectionActive(params.connId, "browser Talk connection closed during startup");
  } catch (error) {
    await trackRetirement(owner, allocation);
    await closeIfEmpty(key, owner);
    throw error;
  }
  void trackRetirement(owner, owner.candidate);
  owner.candidate = allocation;
  return allocation;
}
export function commitBrowserAllocation(params: Mutation): BrowserAllocationMutationResult {
  const owner = owners.get(keyOf(params));
  const slot = owner && slotOf(owner, params.allocationId);
  if (!owner || !slot) {
    throw new Error("browser Talk allocation is no longer a candidate");
  }
  const allocation = owner[slot]!;
  requireConn(allocation, params.connId);
  if (allocation.released) {
    throw new Error("browser Talk allocation is no longer a candidate");
  }
  if (allocation.terminal) {
    return { state: "terminal", terminal: allocation.terminal };
  }
  if (slot === "active") {
    return { state: "committed" };
  }
  if (!allocation.claimDurable()) {
    throw new Error("voice session browser allocation changed during startup");
  }
  allocation.activateEffects();
  const previous = owner.active;
  owner.active = allocation;
  owner.candidate = undefined;
  promoteDurableState(owner, allocation, true);
  void trackRetirement(owner, previous);
  return { state: "committed" };
}
export async function abortBrowserAllocation(params: Mutation) {
  const key = keyOf(params);
  const owner = owners.get(key);
  if (!owner || owner.candidate?.allocationId !== params.allocationId) {
    return { state: "aborted" };
  }
  const allocation = owner.candidate;
  requireConn(allocation, params.connId);
  if (allocation.terminal) {
    return { state: "terminal", terminal: allocation.terminal };
  }
  await release(key, owner, "candidate");
  return { state: "aborted" };
}
export async function closeBrowserAllocation(params: Close) {
  const key = keyOf(params);
  const owner = owners.get(key);
  if (!params.allocationId && owner) {
    const active = owner.active;
    // Missing ids belong only to the legacy auto-commit path. Once an owner
    // exists, never fall through to durable close without connection ownership.
    if (!active?.legacyAutoCommit || !params.connId || active.connId !== params.connId) {
      return "settled" satisfies BrowserAllocationCloseResult;
    }
    await release(key, owner, "active");
    return "settled";
  }
  if (!owner || !params.allocationId) {
    return params.allocationId ? "ownerless-exact" : "ownerless-legacy";
  }
  const slot = slotOf(owner, params.allocationId);
  if (!slot) {
    return "ownerless-exact";
  }
  const allocation = owner[slot]!;
  if (params.connId) {
    requireConn(allocation, params.connId);
  }
  await release(key, owner, slot);
  return "settled";
}
export function terminateBrowserAllocation(
  allocation: BrowserAllocation,
  outcome: BrowserAllocationTerminal,
): void {
  const key = keyOf(allocation);
  const owner = owners.get(key);
  const slot = owner && slotOf(owner, allocation.allocationId);
  if (!owner || !slot || allocation.released || allocation.terminal) {
    return;
  }
  allocation.terminal = outcome;
  retireEffects(allocation);
  const timer = setTimeout(() => {
    if (owner[slot] === allocation) {
      void release(key, owner, slot).catch((error: unknown) =>
        warnCleanup(allocation, "terminal", error),
      );
    }
  }, CLIENT_VOICE_TERMINAL_ACK_GRACE_MS);
  timer.unref?.();
  allocation.broadcast(
    "talk.client.allocation.terminal",
    {
      ...outcome,
      sessionKey: allocation.sessionKey,
      voiceSessionId: allocation.voiceSessionId,
      allocationId: allocation.allocationId,
    },
    new Set([allocation.connId]),
  );
}
async function closeBrowserAllocationsForConnection(connId: string) {
  for (const [key, owner] of owners) {
    for (const slot of slots) {
      const allocation = owner[slot];
      if (allocation?.connId !== connId) {
        continue;
      }
      try {
        await release(key, owner, slot);
      } catch (error) {
        warnCleanup(allocation, "disconnect", error);
      }
    }
  }
}
