import { sql } from "kysely";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import {
  readActiveTranscriptEntryAnchor,
  readClosedTranscriptTurn,
  type TranscriptTurnBoundary,
} from "../../config/sessions/session-accessor.js";
import type { TranscriptTurnAdmission } from "../../config/sessions/transcript-entry-anchor.js";
import type { ContextEngine } from "../../context-engine/types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { ensureContextEngineTurnOutboxSchema } from "../../state/openclaw-agent-context-engine-turn-outbox-schema.js";
import type { DB as OpenClawAgentDatabaseSchema } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";

type ContextEngineTurnOutboxDatabase = Pick<
  OpenClawAgentDatabaseSchema,
  "context_engine_turn_outbox"
>;

type PendingContextEngineTurn = Readonly<{
  advancement_key: string;
  payload_json: string;
  session_id: string;
}>;

type AdmittedContextEngineTurnOutboxPayload = Readonly<{
  admission: TranscriptTurnAdmission;
  isHeartbeat: boolean;
  state: "admitted";
}>;

type ReadyContextEngineTurnOutboxPayload = Readonly<{
  boundary: TranscriptTurnBoundary;
  isHeartbeat: boolean;
  messages: AgentMessage[];
  prePromptMessageCount: number;
  state: "ready";
}>;

type ContextEngineTurnOutboxPayload =
  | AdmittedContextEngineTurnOutboxPayload
  | ReadyContextEngineTurnOutboxPayload;

const RECOVERED_TURN_MAX_EVENTS = 20_000;
const RECOVERED_TURN_MAX_BYTES = 8 * 1024 * 1024;

function outboxDb(database: OpenClawAgentDatabase) {
  ensureContextEngineTurnOutboxSchema(database.db);
  return getNodeSqliteKysely<ContextEngineTurnOutboxDatabase>(database.db);
}

function assertMatchingOutboxOwner(
  existing: { engine_id: string; owner_plugin_id: string | null },
  params: { engineId: string; ownerPluginId?: string },
  advancementKey: string,
): void {
  if (
    existing.engine_id !== params.engineId ||
    existing.owner_plugin_id !== (params.ownerPluginId ?? null)
  ) {
    throw new Error(`context-engine advancement key collision: ${advancementKey}`);
  }
}

function writeContextEngineTurnOutboxPayload(params: {
  database: OpenClawAgentDatabase;
  engineId: string;
  ownerPluginId?: string;
  payload: ContextEngineTurnOutboxPayload;
}): void {
  const db = outboxDb(params.database);
  const admission =
    params.payload.state === "admitted"
      ? params.payload.admission
      : params.payload.boundary.admission;
  const advancementKey = admission.logicalTurnId;
  const payloadJson = JSON.stringify(params.payload);
  const existing = executeSqliteQueryTakeFirstSync(
    params.database.db,
    db
      .selectFrom("context_engine_turn_outbox")
      .select(["engine_id", "owner_plugin_id", "payload_json"])
      .where("advancement_key", "=", advancementKey),
  );
  if (existing) {
    assertMatchingOutboxOwner(existing, params, advancementKey);
    const existingPayload = JSON.parse(existing.payload_json) as ContextEngineTurnOutboxPayload;
    if (
      params.payload.state === "ready" &&
      existingPayload.state === "admitted" &&
      existingPayload.admission.entryId === admission.entryId
    ) {
      executeSqliteQuerySync(
        params.database.db,
        db
          .updateTable("context_engine_turn_outbox")
          .set({
            attempt_count: 0,
            last_attempt_at: null,
            last_error: null,
            payload_json: payloadJson,
          })
          .where("advancement_key", "=", advancementKey),
      );
      return;
    }
    if (existing.payload_json !== payloadJson) {
      throw new Error(`context-engine advancement key collision: ${advancementKey}`);
    }
    return;
  }
  executeSqliteQuerySync(
    params.database.db,
    db
      .insertInto("context_engine_turn_outbox")
      .values({
        advancement_key: advancementKey,
        engine_id: params.engineId,
        owner_plugin_id: params.ownerPluginId ?? null,
        session_id: admission.sessionId,
        payload_json: payloadJson,
        created_at: Date.now(),
        last_attempt_at: null,
        last_error: null,
      })
      .onConflict((conflict) => conflict.column("advancement_key").doNothing()),
  );
}

export function enqueueContextEngineTurnIntent(params: {
  admission: TranscriptTurnAdmission;
  database: OpenClawAgentDatabase;
  engineId: string;
  isHeartbeat: boolean;
  ownerPluginId?: string;
}): void {
  writeContextEngineTurnOutboxPayload({
    ...params,
    payload: {
      admission: params.admission,
      isHeartbeat: params.isHeartbeat,
      state: "admitted",
    },
  });
}

export function enqueueContextEngineTurnCommit(params: {
  database: OpenClawAgentDatabase;
  engineId: string;
  ownerPluginId?: string;
  payload: Omit<ReadyContextEngineTurnOutboxPayload, "state">;
}): void {
  writeContextEngineTurnOutboxPayload({
    ...params,
    payload: { ...params.payload, state: "ready" },
  });
}

export function discardContextEngineTurnIntent(params: {
  admission: TranscriptTurnAdmission;
  database: OpenClawAgentDatabase;
  engineId: string;
  ownerPluginId?: string;
}): void {
  const db = outboxDb(params.database);
  executeSqliteQuerySync(
    params.database.db,
    db
      .deleteFrom("context_engine_turn_outbox")
      .where("advancement_key", "=", params.admission.logicalTurnId)
      .where("engine_id", "=", params.engineId)
      .where("owner_plugin_id", params.ownerPluginId ? "=" : "is", params.ownerPluginId ?? null),
  );
}

function readRecoveredTerminalAnchor(params: {
  admission: TranscriptTurnAdmission;
  currentAdmission: TranscriptTurnAdmission;
}) {
  const terminalEntryId = params.currentAdmission.effectiveParentId;
  if (!terminalEntryId) {
    return undefined;
  }
  const terminal = readActiveTranscriptEntryAnchor({
    agentId: params.admission.agentId,
    sessionId: params.admission.sessionId,
    sessionKey: params.admission.sessionKey,
    storePath: params.admission.storePath,
    entryId: terminalEntryId,
  });
  return terminal &&
    terminal.activeMessagePosition > params.admission.activeMessagePosition &&
    terminal.activeMessagePosition < params.currentAdmission.activeMessagePosition
    ? terminal
    : undefined;
}

export function recoverContextEngineTurnOutbox(params: {
  currentAdmission: TranscriptTurnAdmission;
  database: OpenClawAgentDatabase;
  engineId: string;
  ownerPluginId?: string;
  warn: (message: string) => void;
}): void {
  const db = outboxDb(params.database);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("context_engine_turn_outbox")
      .select(["advancement_key", "payload_json"])
      .where("engine_id", "=", params.engineId)
      .where("owner_plugin_id", params.ownerPluginId ? "=" : "is", params.ownerPluginId ?? null)
      .where("session_id", "=", params.currentAdmission.sessionId)
      .orderBy(sql<number>`context_engine_turn_outbox.rowid`, "asc"),
  ).rows;
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as ContextEngineTurnOutboxPayload;
    if (payload.state !== "admitted") {
      continue;
    }
    const terminal =
      payload.admission.entryId === params.currentAdmission.entryId
        ? undefined
        : readRecoveredTerminalAnchor({
            admission: payload.admission,
            currentAdmission: params.currentAdmission,
          });
    if (!terminal) {
      // The next admitted turn proves no accepted terminal survived on this active branch.
      discardContextEngineTurnIntent({
        admission: payload.admission,
        database: params.database,
        engineId: params.engineId,
        ownerPluginId: params.ownerPluginId,
      });
      continue;
    }
    const boundary = { admission: payload.admission, terminal };
    const closedTurn = readClosedTranscriptTurn({
      boundary,
      maxEvents: RECOVERED_TURN_MAX_EVENTS,
      maxBytes: RECOVERED_TURN_MAX_BYTES,
    });
    if (closedTurn.kind !== "ok") {
      if (closedTurn.kind === "projection-unavailable") {
        params.warn(
          `[context-engine] durable turn recovery remains queued: ${row.advancement_key}: transcript range is ${closedTurn.kind}`,
        );
        continue;
      }
      params.warn(
        `[context-engine] discarded unrecoverable turn advancement: ${row.advancement_key}: transcript range is ${closedTurn.kind}`,
      );
      discardContextEngineTurnIntent({
        admission: payload.admission,
        database: params.database,
        engineId: params.engineId,
        ownerPluginId: params.ownerPluginId,
      });
      continue;
    }
    enqueueContextEngineTurnCommit({
      database: params.database,
      engineId: params.engineId,
      ownerPluginId: params.ownerPluginId,
      payload: {
        boundary,
        isHeartbeat: payload.isHeartbeat,
        messages: closedTurn.messages,
        prePromptMessageCount: closedTurn.prePromptMessageCount,
      },
    });
  }
}

export async function drainContextEngineTurnOutbox(params: {
  database: OpenClawAgentDatabase;
  engine: ContextEngine;
  engineId: string;
  ownerPluginId?: string;
  sessionId?: string;
  limit?: number;
  warn: (message: string) => void;
}): Promise<{ pending: boolean }> {
  const commitTurn = params.engine.commitTurn;
  if (typeof commitTurn !== "function") {
    return { pending: false };
  }
  let remaining = Math.max(0, params.limit ?? 16);
  if (remaining === 0) {
    return { pending: hasPendingContextEngineTurn(params) };
  }
  const db = outboxDb(params.database);
  let pendingSessionsQuery = db
    .selectFrom("context_engine_turn_outbox")
    .select("session_id")
    // SQLite rowid preserves enqueue order among surviving pending rows.
    // Use it instead of wall-clock timestamps, which can collide.
    .select(sql<number>`MIN(context_engine_turn_outbox.rowid)`.as("oldest_enqueue_sequence"))
    .where("engine_id", "=", params.engineId)
    .where("owner_plugin_id", params.ownerPluginId ? "=" : "is", params.ownerPluginId ?? null);
  if (params.sessionId) {
    pendingSessionsQuery = pendingSessionsQuery.where("session_id", "=", params.sessionId);
  }
  const pendingSessions = executeSqliteQuerySync(
    params.database.db,
    pendingSessionsQuery
      .groupBy("session_id")
      .orderBy("oldest_enqueue_sequence", "asc")
      .limit(remaining),
  ).rows;
  let activeSessionIds = pendingSessions.map(({ session_id }) => session_id);
  while (remaining > 0 && activeSessionIds.length > 0) {
    const continuingSessionIds: string[] = [];
    for (const sessionId of activeSessionIds) {
      if (remaining === 0) {
        break;
      }
      const row = executeSqliteQueryTakeFirstSync(
        params.database.db,
        db
          .selectFrom("context_engine_turn_outbox")
          .select(["advancement_key", "payload_json", "session_id"])
          .where("engine_id", "=", params.engineId)
          .where("owner_plugin_id", params.ownerPluginId ? "=" : "is", params.ownerPluginId ?? null)
          .where("session_id", "=", sessionId)
          .orderBy(sql<number>`context_engine_turn_outbox.rowid`, "asc")
          .limit(1),
      );
      if (!row) {
        continue;
      }
      remaining -= 1;
      if (await commitPendingContextEngineTurn({ ...params, commitTurn, db, row })) {
        continuingSessionIds.push(sessionId);
      }
    }
    activeSessionIds = continuingSessionIds;
  }
  return { pending: hasPendingContextEngineTurn(params) };
}

function hasPendingContextEngineTurn(
  params: Pick<
    Parameters<typeof drainContextEngineTurnOutbox>[0],
    "database" | "engineId" | "ownerPluginId" | "sessionId"
  >,
): boolean {
  const db = outboxDb(params.database);
  let query = db
    .selectFrom("context_engine_turn_outbox")
    .select("advancement_key")
    .where("engine_id", "=", params.engineId)
    .where("owner_plugin_id", params.ownerPluginId ? "=" : "is", params.ownerPluginId ?? null);
  if (params.sessionId) {
    query = query.where("session_id", "=", params.sessionId);
  }
  return executeSqliteQueryTakeFirstSync(params.database.db, query.limit(1)) !== undefined;
}

async function commitPendingContextEngineTurn(
  params: Omit<Parameters<typeof drainContextEngineTurnOutbox>[0], "limit" | "sessionId"> & {
    commitTurn: NonNullable<ContextEngine["commitTurn"]>;
    db: ReturnType<typeof outboxDb>;
    row: PendingContextEngineTurn;
  },
): Promise<boolean> {
  const { row } = params;
  try {
    const payload = JSON.parse(row.payload_json) as ContextEngineTurnOutboxPayload;
    if (payload.state !== "ready") {
      return false;
    }
    const result = await params.commitTurn({
      advancementKey: row.advancement_key,
      admission: payload.boundary.admission,
      terminal: payload.boundary.terminal,
      messages: payload.messages,
      prePromptMessageCount: payload.prePromptMessageCount,
      sessionId: payload.boundary.admission.sessionId,
      sessionKey: payload.boundary.admission.sessionKey,
      sessionTarget: {
        agentId: payload.boundary.admission.agentId,
        sessionId: payload.boundary.admission.sessionId,
        sessionKey: payload.boundary.admission.sessionKey,
        storePath: payload.boundary.admission.storePath,
      },
      isHeartbeat: payload.isHeartbeat,
    });
    if (result.status !== "committed" && result.status !== "duplicate") {
      throw new Error(`invalid commitTurn result status: ${String(result.status)}`);
    }
    executeSqliteQuerySync(
      params.database.db,
      params.db
        .deleteFrom("context_engine_turn_outbox")
        .where("advancement_key", "=", row.advancement_key),
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    executeSqliteQuerySync(
      params.database.db,
      params.db
        .updateTable("context_engine_turn_outbox")
        .set((eb) => ({
          attempt_count: eb("attempt_count", "+", 1),
          last_attempt_at: Date.now(),
          last_error: message,
        }))
        .where("advancement_key", "=", row.advancement_key),
    );
    params.warn(
      `[context-engine] durable turn advancement remains queued: ${row.advancement_key}: ${message}`,
    );
    return false;
  }
}
