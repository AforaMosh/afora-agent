import { AsyncLocalStorage } from "node:async_hooks";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";

const transcriptReadFenceStorage = new AsyncLocalStorage<UserTurnTranscriptAdmissionReceipt>();

export class SessionTranscriptReadFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionTranscriptReadFenceError";
  }
}

export type SessionTranscriptReadFence = Readonly<{
  admission: UserTurnTranscriptAdmissionReceipt;
  beforeActiveMessagePosition: number;
  beforeRawSeq: number;
}>;

export function runWithSessionTranscriptReadFence<T>(
  receipt: UserTurnTranscriptAdmissionReceipt | undefined,
  run: () => T,
): T {
  return receipt ? transcriptReadFenceStorage.run(receipt, run) : run();
}

function resolveSessionTranscriptReadFence(session: {
  agentId: string;
  sessionId: string;
}): UserTurnTranscriptAdmissionReceipt | undefined {
  const receipt = transcriptReadFenceStorage.getStore();
  return receipt?.agentId === session.agentId && receipt.sessionId === session.sessionId
    ? receipt
    : undefined;
}

export function resolveSqliteSessionTranscriptReadFence(params: {
  database: OpenClawAgentDatabase;
  agentId: string;
  sessionId: string;
  sessionKey?: string;
}): SessionTranscriptReadFence | undefined {
  const receipt = resolveSessionTranscriptReadFence(params);
  if (!receipt) {
    return undefined;
  }
  const db = getSessionKysely(params.database.db);
  const boundary = executeSqliteQueryTakeFirstSync(
    params.database.db,
    db
      .selectFrom("transcript_event_identities as identity")
      .innerJoin("session_transcript_active_events as active", (join) =>
        join
          .onRef("active.session_id", "=", "identity.session_id")
          .onRef("active.event_seq", "=", "identity.seq"),
      )
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "identity.session_id")
          .onRef("event.seq", "=", "identity.seq"),
      )
      .select(["active.event_seq", "active.message_position", "event.event_json"])
      .where("identity.session_id", "=", params.sessionId)
      .where("identity.event_id", "=", receipt.entryId)
      .limit(1),
  );
  if (boundary?.message_position === null || boundary?.message_position === undefined) {
    throw new SessionTranscriptReadFenceError(
      `Current-turn transcript admission is no longer a visible message: ${receipt.entryId}`,
    );
  }
  const event = JSON.parse(boundary.event_json) as { type?: unknown; message?: { role?: unknown } };
  if (event.type !== "message" || event.message?.role !== "user") {
    throw new SessionTranscriptReadFenceError(
      `Current-turn transcript admission is not a user message: ${receipt.entryId}`,
    );
  }
  if (params.sessionKey !== undefined && params.sessionKey !== receipt.sessionKey) {
    throw new SessionTranscriptReadFenceError(
      "Current-turn transcript admission belongs to a different session key",
    );
  }
  return {
    admission: receipt,
    beforeActiveMessagePosition: boundary.message_position,
    beforeRawSeq: boundary.event_seq,
  };
}
