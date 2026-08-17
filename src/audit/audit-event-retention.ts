import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";

type AuditDatabase = Pick<OpenClawStateKyselyDatabase, "audit_events">;

export const AUDIT_EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const AUDIT_EVENT_MAX_ROWS = 100_000;
const AUDIT_EVENT_PRUNE_BATCH_ROWS = 1_024;
// The single audit writer owns one DB handle. Invalidate on out-of-band
// maintenance or rollback so the hot path avoids a 100k-row scan per message.
const auditEventRowCounts = new WeakMap<DatabaseSync, number>();

function getAuditKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<AuditDatabase>(db);
}

function countAuditEvents(db: DatabaseSync): number {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getAuditKysely(db)
      .selectFrom("audit_events")
      .select((expression) => expression.fn.countAll<number>().as("count")),
  );
  return normalizeSqliteNumber(row?.count ?? null) ?? 0;
}

function deleteExpiredAuditEvents(db: DatabaseSync, now: number) {
  const kysely = getAuditKysely(db);
  const expiredSequences = kysely
    .selectFrom("audit_events")
    .select("sequence")
    .where("occurred_at", "<", now - AUDIT_EVENT_RETENTION_MS)
    .orderBy("occurred_at", "asc")
    .orderBy("sequence", "asc")
    .limit(AUDIT_EVENT_PRUNE_BATCH_ROWS);
  return executeSqliteQuerySync(
    db,
    kysely.deleteFrom("audit_events").where("sequence", "in", expiredSequences),
  );
}

export function pruneAuditEventsAfterInsert(db: DatabaseSync, now: number): void {
  const kysely = getAuditKysely(db);
  const expired = deleteExpiredAuditEvents(db, now);
  const cachedCount = auditEventRowCounts.get(db);
  let rowCount =
    cachedCount === undefined
      ? countAuditEvents(db)
      : Math.max(0, cachedCount + 1 - Number(expired.numAffectedRows ?? 0n));
  if (rowCount <= AUDIT_EVENT_MAX_ROWS) {
    auditEventRowCounts.set(db, rowCount);
    return;
  }
  const retainedRows = Math.max(0, AUDIT_EVENT_MAX_ROWS - AUDIT_EVENT_PRUNE_BATCH_ROWS);
  const overflowRow = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("audit_events")
      .select("sequence")
      .orderBy("sequence", "desc")
      .offset(retainedRows)
      .limit(1),
  );
  const sequenceCutoff = overflowRow ? normalizeSqliteNumber(overflowRow.sequence) : undefined;
  if (sequenceCutoff !== undefined) {
    const pruned = executeSqliteQuerySync(
      db,
      kysely.deleteFrom("audit_events").where("sequence", "<=", sequenceCutoff),
    );
    rowCount = Math.max(0, rowCount - Number(pruned.numAffectedRows ?? 0n));
  }
  auditEventRowCounts.set(db, rowCount);
}

export function pruneExpiredAuditEventsBatch(db: DatabaseSync, now: number): number {
  const deleted = deleteExpiredAuditEvents(db, now);
  auditEventRowCounts.delete(db);
  return Number(deleted.numAffectedRows ?? 0n);
}

export function invalidateAuditEventRetentionCache(db: DatabaseSync): void {
  auditEventRowCounts.delete(db);
}
