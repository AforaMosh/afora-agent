/**
 * Process-local registry that lets Talk protocol methods resolve opaque
 * `sessionId` values to the concrete relay or managed-room backend.
 */
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { formatError } from "./server-utils.js";

type TalkConnectionCleanupKind = "browser-allocation" | "realtime-relay" | "transcription-relay";
type TalkConnectionCleanup = () => void | Promise<void>;
type TalkConnectionLeaseState = {
  released: boolean;
  closedMessage: string;
};
type TalkConnectionLifecycle = {
  closing: boolean;
  cleanups: Map<TalkConnectionCleanupKind, TalkConnectionCleanup>;
  leases: Set<TalkConnectionLeaseState>;
  leaseWaiters: Set<() => void>;
  drain?: Promise<void>;
};
type TalkConnectionLease = {
  assertActive: () => void;
  release: () => void;
};

export type UnifiedTalkSessionRecord =
  | {
      kind: "realtime-relay";
      connId: string;
      relaySessionId: string;
    }
  | {
      kind: "transcription-relay";
      connId: string;
      transcriptionSessionId: string;
    }
  | {
      kind: "managed-room";
      handoffId: string;
      token: string;
      roomId: string;
    };

const unifiedTalkSessions = resolveGlobalMap<string, UnifiedTalkSessionRecord>(
  Symbol.for("openclaw.unifiedTalkSessions"),
  "close-and-restart",
);
const talkConnectionLifecycles = resolveGlobalMap<string, TalkConnectionLifecycle>(
  Symbol.for("openclaw.talkConnectionLifecycles"),
  "close-and-restart",
);

function ensureTalkConnectionLifecycle(connId: string): TalkConnectionLifecycle {
  const existing = talkConnectionLifecycles.get(connId);
  if (existing) {
    return existing;
  }
  const lifecycle: TalkConnectionLifecycle = {
    closing: false,
    cleanups: new Map(),
    leases: new Set(),
    leaseWaiters: new Set(),
  };
  talkConnectionLifecycles.set(connId, lifecycle);
  return lifecycle;
}

function assertTalkConnectionLeaseActive(
  lifecycle: TalkConnectionLifecycle,
  lease: TalkConnectionLeaseState,
): void {
  if (lifecycle.closing || lease.released) {
    throw new Error(lease.closedMessage);
  }
}

/** Prevents connection teardown from passing work that has already begun. */
export function acquireTalkConnectionLease(
  connId: string,
  closedMessage = "Talk connection closed during startup",
): TalkConnectionLease {
  const lifecycle = ensureTalkConnectionLifecycle(connId);
  if (lifecycle.closing) {
    throw new Error(closedMessage);
  }
  const lease: TalkConnectionLeaseState = { released: false, closedMessage };
  lifecycle.leases.add(lease);
  return {
    assertActive: () => assertTalkConnectionLeaseActive(lifecycle, lease),
    release: () => {
      if (lease.released) {
        return;
      }
      lease.released = true;
      lifecycle.leases.delete(lease);
      if (lifecycle.leases.size === 0) {
        for (const resolve of lifecycle.leaseWaiters) {
          resolve();
        }
        lifecycle.leaseWaiters.clear();
      }
    },
  };
}

/** Rejects publication after connection teardown has started. */
export function assertTalkConnectionActive(connId: string, closedMessage: string): void {
  if (ensureTalkConnectionLifecycle(connId).closing) {
    throw new Error(closedMessage);
  }
}

/**
 * Keeps one owner cleanup per Talk subsystem until the connection closes.
 * Replacing by kind stays bounded while the owner cleanup scans all live sessions.
 */
export function registerTalkConnectionCleanup(
  connId: string,
  kind: TalkConnectionCleanupKind,
  cleanup: TalkConnectionCleanup,
): void {
  ensureTalkConnectionLifecycle(connId).cleanups.set(kind, cleanup);
}

async function waitForTalkConnectionLeases(lifecycle: TalkConnectionLifecycle): Promise<void> {
  while (lifecycle.leases.size > 0) {
    await new Promise<void>((resolve) => {
      lifecycle.leaseWaiters.add(resolve);
    });
  }
}

async function runTalkConnectionCleanup(
  kind: TalkConnectionCleanupKind,
  cleanup: TalkConnectionCleanup,
  log: { warn: (message: string) => void },
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    log.warn(
      `failed to run ${kind} Talk cleanup after connection disconnect: ${formatError(error)}`,
    );
  }
}

async function drainTalkConnection(
  lifecycle: TalkConnectionLifecycle,
  log: { warn: (message: string) => void },
): Promise<void> {
  // Startup work owns a lease before its first await. Waiting here makes every
  // owner it publishes, including late relay owners, visible to this same drain.
  if (lifecycle.leases.size > 0) {
    await waitForTalkConnectionLeases(lifecycle);
  }
  while (lifecycle.cleanups.size > 0) {
    const cleanups = [...lifecycle.cleanups];
    lifecycle.cleanups.clear();
    await Promise.all(
      cleanups.map(([kind, cleanup]) => runTalkConnectionCleanup(kind, cleanup, log)),
    );
    if (lifecycle.leases.size > 0) {
      await waitForTalkConnectionLeases(lifecycle);
    }
  }
}

/** Runs every Talk owner registered before connection startup work has drained. */
export function cleanupTalkConnection(
  connId: string,
  log: { warn: (message: string) => void },
): Promise<void> {
  const lifecycle = talkConnectionLifecycles.get(connId);
  if (!lifecycle) {
    return Promise.resolve();
  }
  if (lifecycle.drain) {
    return lifecycle.drain;
  }
  lifecycle.closing = true;
  let finishDrain!: () => void;
  const drain = new Promise<void>((resolve) => {
    finishDrain = resolve;
  });
  lifecycle.drain = drain;
  void drainTalkConnection(lifecycle, log).finally(() => {
    if (talkConnectionLifecycles.get(connId) === lifecycle) {
      talkConnectionLifecycles.delete(connId);
    }
    finishDrain();
  });
  return drain;
}

/** Associates a public Talk session id with its concrete gateway backend. */
export function rememberUnifiedTalkSession(
  sessionId: string,
  session: UnifiedTalkSessionRecord,
): void {
  unifiedTalkSessions.set(sessionId, session);
}

/** Resolves a Talk session id or throws the protocol-facing unknown-session error. */
export function getUnifiedTalkSession(sessionId: string): UnifiedTalkSessionRecord {
  const session = unifiedTalkSessions.get(sessionId);
  if (!session) {
    throw new Error("Unknown Talk session");
  }
  return session;
}

/** Removes a Talk session id after the concrete backend closes. */
export function forgetUnifiedTalkSession(sessionId: string): void {
  unifiedTalkSessions.delete(sessionId);
}

/** Enforces that a relay-backed Talk session is controlled by its owner socket. */
export function requireUnifiedTalkSessionConn(
  session: Extract<UnifiedTalkSessionRecord, { connId: string }>,
  connId: string | undefined,
): string {
  if (!connId || session.connId !== connId) {
    throw new Error("Talk session is not owned by this connection");
  }
  return connId;
}
