import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type {
  AforaAgentDatabase,
  AforaAgentDatabaseOptions,
} from "./afora-agent-db-contract.js";
import {
  assertCanonicalAgentMediaPersistenceVersion,
  assertExistingAgentSchemaOwner,
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./afora-agent-db-schema-helpers.js";
import { getAforaAgentDatabaseIfOpen } from "./afora-agent-db.js";
import {
  isIncognitoAforaAgentSqlitePath,
  resolveAforaAgentSqlitePath,
} from "./afora-agent-db.paths.js";
import { AFORA_SQLITE_BUSY_TIMEOUT_MS } from "./afora-state-db.js";

type AforaAgentReadOnlyDatabase = {
  agentId: string;
  db: DatabaseSync;
  path: string;
};

type AforaAgentDatabaseReadOnlyResult<T> =
  | { found: true; value: T }
  | { found: false; reason: "database-missing" | "schema-missing" | "table-missing" };

function isMissingTableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" &&
    /\bno such table:/iu.test(error.message)
  );
}

/**
 * Look up a process-held handle without adopting writer-side failures.
 *
 * Read-only reads are meant to survive a latched open failure or an ownership
 * mismatch that only the writable lifecycle cares about; those callers fall
 * back to a fresh connection, which reports the precise reason.
 */
function findOpenAgentDatabase(
  options: AforaAgentDatabaseOptions,
): AforaAgentDatabase | undefined {
  try {
    return getAforaAgentDatabaseIfOpen(options);
  } catch {
    return undefined;
  }
}

/** Read agent state without creating, registering, migrating, or joining its writable lifecycle. */
export function withAforaAgentDatabaseReadOnly<T>(
  operation: (database: AforaAgentReadOnlyDatabase) => T,
  options: AforaAgentDatabaseOptions,
): AforaAgentDatabaseReadOnlyResult<T> {
  const agentId = normalizeAgentId(options.agentId);
  const pathname = resolveAforaAgentSqlitePath({ ...options, agentId });
  if (isIncognitoAforaAgentSqlitePath(pathname, { agentId, env: options.env })) {
    // Read-only misses must not create process-lifetime handles; only creation and
    // write paths may materialize the process-held incognito database.
    const database = getAforaAgentDatabaseIfOpen({ ...options, agentId });
    return database
      ? { found: true, value: operation(database) }
      : { found: false, reason: "database-missing" };
  }
  // Reusing a handle this process already holds is what keeps row loops cheap:
  // opening and closing a connection per call made reads scale with row count.
  // An in-flight transaction is skipped so callers never observe uncommitted
  // rows that a fresh read-only connection could not have seen.
  const opened = findOpenAgentDatabase({ ...options, agentId });
  if (opened && !opened.db.isTransaction) {
    // A newer build can migrate this file while the handle stays open, so the
    // forward-compatibility gate still runs before any reused read.
    assertSupportedAgentSchemaVersion(opened.db, pathname);
    try {
      return { found: true, value: operation(opened) };
    } catch (error) {
      if (isMissingTableError(error)) {
        return { found: false, reason: "table-missing" };
      }
      throw error;
    }
  }
  if (!fs.existsSync(pathname)) {
    return { found: false, reason: "database-missing" };
  }
  const db = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${AFORA_SQLITE_BUSY_TIMEOUT_MS};`);
    assertSupportedAgentSchemaVersion(db, pathname);
    assertCanonicalAgentMediaPersistenceVersion(db, pathname);
    const schemaMeta = readExistingAgentSchemaMeta(db);
    if (!schemaMeta) {
      return { found: false, reason: "schema-missing" };
    }
    assertExistingAgentSchemaOwner(schemaMeta, agentId, pathname);
    try {
      return { found: true, value: operation({ agentId, db, path: pathname }) };
    } catch (error) {
      if (isMissingTableError(error)) {
        return { found: false, reason: "table-missing" };
      }
      throw error;
    }
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
  }
}
