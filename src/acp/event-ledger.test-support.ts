import type { ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk";
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import type { AcpEventLedger, AcpEventLedgerReplay } from "./event-ledger.js";

const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_MAX_EVENTS_PER_SESSION = 5_000;
const DEFAULT_MAX_SERIALIZED_BYTES = 16 * 1024 * 1024;

type LedgerOptions = {
  maxSessions?: number;
  maxEventsPerSession?: number;
  maxSerializedBytes?: number;
  now?: () => number;
};

type LedgerEvent = AcpEventLedgerReplay["events"][number];

type LedgerSession = {
  sessionId: string;
  sessionKey: string;
  cwd: string;
  complete: boolean;
  createdAt: number;
  updatedAt: number;
  nextSeq: number;
  events: LedgerEvent[];
};

function cloneJsonValue<T>(value: T): T {
  return structuredClone(value);
}

/** Creates an isolated in-memory ledger for unit tests. */
export function createInMemoryAcpEventLedger(options: LedgerOptions = {}): AcpEventLedger {
  const sessions = new Map<string, LedgerSession>();
  const maxSessions = resolveIntegerOption(options.maxSessions, DEFAULT_MAX_SESSIONS, { min: 1 });
  const maxEventsPerSession = resolveIntegerOption(
    options.maxEventsPerSession,
    DEFAULT_MAX_EVENTS_PER_SESSION,
    { min: 1 },
  );
  const maxSerializedBytes = resolveIntegerOption(
    options.maxSerializedBytes,
    DEFAULT_MAX_SERIALIZED_BYTES,
    { min: 1_024 },
  );
  const now = options.now ?? Date.now;

  const getOrCreateSession = (params: {
    sessionId: string;
    sessionKey: string;
    cwd: string;
    complete: boolean;
    reset?: boolean;
  }) => {
    const existing = sessions.get(params.sessionId);
    const timestamp = now();
    if (!params.reset && existing) {
      existing.sessionKey = params.sessionKey;
      existing.cwd = params.cwd || existing.cwd;
      existing.complete ||= params.complete;
      existing.updatedAt = timestamp;
      return existing;
    }
    const session: LedgerSession = {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      cwd: params.cwd,
      complete: params.complete,
      createdAt: timestamp,
      updatedAt: timestamp,
      nextSeq: 1,
      events: [],
    };
    sessions.set(params.sessionId, session);
    return session;
  };

  const serializedByteLength = () =>
    Buffer.byteLength(JSON.stringify(Object.fromEntries(sessions)), "utf8");

  const trim = () => {
    for (const session of sessions.values()) {
      if (session.events.length > maxEventsPerSession) {
        session.events = session.events.slice(-maxEventsPerSession);
        session.complete = false;
      }
    }

    for (const session of [...sessions.values()]
      .toSorted((a, b) => b.updatedAt - a.updatedAt)
      .slice(maxSessions)) {
      sessions.delete(session.sessionId);
    }

    let bytes = serializedByteLength();
    while (bytes > maxSerializedBytes) {
      const session = [...sessions.values()]
        .filter((candidate) => candidate.events.length > 0)
        .toSorted((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!session) {
        break;
      }
      session.events.shift();
      session.complete = false;
      bytes = serializedByteLength();
    }
    while (bytes > maxSerializedBytes) {
      const session = [...sessions.values()].toSorted((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!session) {
        break;
      }
      sessions.delete(session.sessionId);
      bytes = serializedByteLength();
    }
  };

  const appendUpdate = (params: {
    sessionId: string;
    sessionKey: string;
    runId?: string;
    update: SessionUpdate;
  }) => {
    const session = getOrCreateSession({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      cwd: "",
      complete: false,
    });
    const timestamp = now();
    session.updatedAt = timestamp;
    session.events.push({
      seq: session.nextSeq,
      at: timestamp,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      ...(params.runId ? { runId: params.runId } : {}),
      update: cloneJsonValue(params.update),
    });
    session.nextSeq += 1;
    trim();
  };

  const buildReplay = (session: LedgerSession | undefined): AcpEventLedgerReplay => {
    if (!session) {
      return { complete: false, events: [] };
    }
    return {
      complete: session.complete,
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      events: session.complete ? cloneJsonValue(session.events) : [],
    };
  };

  return {
    async startSession(params) {
      getOrCreateSession(params);
      trim();
    },
    async recordUserPrompt(params) {
      if (params.shouldRecord && !params.shouldRecord()) {
        return;
      }
      for (const content of params.prompt as readonly ContentBlock[]) {
        appendUpdate({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          runId: params.runId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: cloneJsonValue(content),
          },
        });
      }
    },
    async recordUpdate(params) {
      appendUpdate(params);
    },
    async markIncomplete(params) {
      const session = sessions.get(params.sessionId);
      if (session?.sessionKey === params.sessionKey) {
        session.complete = false;
        session.updatedAt = now();
      }
    },
    async readReplay(params) {
      const session = sessions.get(params.sessionId);
      return buildReplay(session?.sessionKey === params.sessionKey ? session : undefined);
    },
    async readReplayBySessionId(params) {
      return buildReplay(sessions.get(params.sessionId));
    },
    async readReplayBySessionKey(params) {
      const matches = [...sessions.values()]
        .filter((candidate) => candidate.sessionKey === params.sessionKey)
        .toSorted((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));
      return buildReplay(matches[0]);
    },
  };
}
