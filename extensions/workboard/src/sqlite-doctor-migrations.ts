import fs from "node:fs";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { resolveWorkboardSqlitePath } from "./sqlite-store.js";

const BLANK_AGENT_PREDICATE = "agent_id IS NOT NULL AND trim(agent_id) = ''";
const DISPATCHER_AGENT_PREDICATE = "lower(trim(agent_id)) = 'workboard-dispatcher'";

function hasCardsTable(databasePath: string): boolean {
  const db = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    return Boolean(
      db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'workboard_cards'")
        .get(),
    );
  } finally {
    db.close();
  }
}

export function inspectAmbiguousWorkboardAgentIds(env: NodeJS.ProcessEnv = process.env): {
  blank: number;
  dispatcher: number;
} {
  const databasePath = resolveWorkboardSqlitePath(env);
  if (!fs.existsSync(databasePath) || !hasCardsTable(databasePath)) {
    return { blank: 0, dispatcher: 0 };
  }
  const db = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT
           sum(CASE WHEN ${BLANK_AGENT_PREDICATE} THEN 1 ELSE 0 END) AS blank,
           sum(CASE WHEN ${DISPATCHER_AGENT_PREDICATE} THEN 1 ELSE 0 END) AS dispatcher
         FROM workboard_cards`,
      )
      .get() as { blank?: number | bigint; dispatcher?: number | bigint } | undefined;
    return { blank: Number(row?.blank ?? 0), dispatcher: Number(row?.dispatcher ?? 0) };
  } finally {
    db.close();
  }
}

export function normalizeAmbiguousWorkboardAgentIds(
  env: NodeJS.ProcessEnv = process.env,
  options: { preserveDispatcherAgent?: boolean } = {},
): number {
  const databasePath = resolveWorkboardSqlitePath(env);
  if (!fs.existsSync(databasePath) || !hasCardsTable(databasePath)) {
    return 0;
  }
  const db = openNodeSqliteDatabase(databasePath);
  let transactionStarted = false;
  try {
    db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
    transactionStarted = true;
    const predicate = options.preserveDispatcherAgent
      ? BLANK_AGENT_PREDICATE
      : `(${BLANK_AGENT_PREDICATE} OR ${DISPATCHER_AGENT_PREDICATE})`;
    const result = db
      .prepare(`UPDATE workboard_cards SET agent_id = NULL WHERE ${predicate}`)
      .run();
    db.exec("COMMIT");
    return Number(result.changes);
  } catch (error) {
    if (transactionStarted) {
      db.exec("ROLLBACK");
    }
    throw error;
  } finally {
    db.close();
  }
}
