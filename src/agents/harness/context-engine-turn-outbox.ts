import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import type { TranscriptTurnBoundary } from "../../config/sessions/transcript-entry-anchor.js";
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

export type ContextEngineTurnOutboxPayload = Readonly<{
  boundary: TranscriptTurnBoundary;
  isHeartbeat: boolean;
  messages: AgentMessage[];
  prePromptMessageCount: number;
  sessionId: string;
  sessionKey?: string;
}>;

function outboxDb(database: OpenClawAgentDatabase) {
  ensureContextEngineTurnOutboxSchema(database.db);
  return getNodeSqliteKysely<ContextEngineTurnOutboxDatabase>(database.db);
}

export function enqueueContextEngineTurnCommit(params: {
  database: OpenClawAgentDatabase;
  engineId: string;
  ownerPluginId?: string;
  payload: ContextEngineTurnOutboxPayload;
}): void {
  const db = outboxDb(params.database);
  const advancementKey = params.payload.boundary.admission.logicalTurnId;
  const payloadJson = JSON.stringify(params.payload);
  const existing = executeSqliteQueryTakeFirstSync(
    params.database.db,
    db
      .selectFrom("context_engine_turn_outbox")
      .select(["engine_id", "owner_plugin_id", "payload_json"])
      .where("advancement_key", "=", advancementKey),
  );
  if (
    existing &&
    (existing.engine_id !== params.engineId ||
      existing.owner_plugin_id !== (params.ownerPluginId ?? null) ||
      existing.payload_json !== payloadJson)
  ) {
    throw new Error(`context-engine advancement key collision: ${advancementKey}`);
  }
  if (existing) {
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
        session_id: params.payload.sessionId,
        payload_json: payloadJson,
        created_at: Date.now(),
        last_attempt_at: null,
        last_error: null,
      })
      .onConflict((conflict) => conflict.column("advancement_key").doNothing()),
  );
}

export async function drainContextEngineTurnOutbox(params: {
  database: OpenClawAgentDatabase;
  engine: ContextEngine;
  engineId: string;
  ownerPluginId?: string;
  limit?: number;
  warn: (message: string) => void;
}): Promise<void> {
  if (typeof params.engine.commitTurn !== "function") {
    return;
  }
  const db = outboxDb(params.database);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("context_engine_turn_outbox")
      .select(["advancement_key", "payload_json"])
      .where("engine_id", "=", params.engineId)
      .where("owner_plugin_id", params.ownerPluginId ? "=" : "is", params.ownerPluginId ?? null)
      .orderBy("created_at", "asc")
      .limit(params.limit ?? 16),
  ).rows;
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json) as ContextEngineTurnOutboxPayload;
      await params.engine.commitTurn({
        advancementKey: row.advancement_key,
        admission: payload.boundary.admission,
        terminal: payload.boundary.terminal,
        messages: payload.messages,
        prePromptMessageCount: payload.prePromptMessageCount,
        sessionId: payload.sessionId,
        sessionKey: payload.sessionKey,
        sessionTarget: {
          agentId: payload.boundary.admission.agentId,
          sessionId: payload.boundary.admission.sessionId,
          sessionKey: payload.boundary.admission.sessionKey,
          storePath: payload.boundary.admission.storePath,
        },
        isHeartbeat: payload.isHeartbeat,
      });
      executeSqliteQuerySync(
        params.database.db,
        db
          .deleteFrom("context_engine_turn_outbox")
          .where("advancement_key", "=", row.advancement_key),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      executeSqliteQuerySync(
        params.database.db,
        db
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
    }
  }
}
