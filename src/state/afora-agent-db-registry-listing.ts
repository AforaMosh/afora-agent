import { lstatSync, statSync } from "node:fs";
import path from "node:path";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  AFORA_AGENT_SCHEMA_VERSION,
  type AforaRegisteredAgentDatabase,
} from "./afora-agent-db-contract.js";
import { withExistingAforaStateDatabaseReadOnly } from "./afora-state-db-readonly.js";
import { detectAforaStateDatabaseSchemaMigrationsFromDatabase } from "./afora-state-db-schema-repair.js";
import type { DB as AforaStateKyselyDatabase } from "./afora-state-db.generated.js";
import type { AforaStateDatabaseOptions } from "./afora-state-db.js";
import {
  resolveAforaRegisteredAgentDatabasePath,
  resolveAforaStateSqlitePath,
} from "./afora-state-db.paths.js";

type AforaAgentRegistryDatabase = Pick<AforaStateKyselyDatabase, "agent_databases">;

// Registry metadata is process-stable: registry writes invalidate after each commit;
// other-process changes take effect on restart. Polling here puts schema probes back on hot reads.
let registeredAgentDatabasesMemo:
  | {
      pathname: string;
      token: symbol;
      entries?: readonly AforaRegisteredAgentDatabase[];
    }
  | undefined;

function resolveAgentDatabaseRegistryPath(options: AforaStateDatabaseOptions): string {
  return path.resolve(options.path ?? resolveAforaStateSqlitePath(options.env ?? process.env));
}

function activateRegisteredAgentDatabasesMemo(
  options: AforaStateDatabaseOptions,
): NonNullable<typeof registeredAgentDatabasesMemo> {
  const pathname = resolveAgentDatabaseRegistryPath(options);
  if (registeredAgentDatabasesMemo?.pathname !== pathname) {
    // One active pathname keeps registry metadata process-stable without retaining
    // an unbounded generation map. Switching back creates a fresh generation.
    registeredAgentDatabasesMemo = { pathname, token: Symbol(pathname) };
  }
  return registeredAgentDatabasesMemo;
}

/** Return the process-stable generation for the active agent database registry. */
export function readAforaAgentDatabaseRegistryToken(
  options: AforaStateDatabaseOptions = {},
): symbol {
  return activateRegisteredAgentDatabasesMemo(options).token;
}

export function invalidateRegisteredAgentDatabasesMemo(
  options: AforaStateDatabaseOptions,
): void {
  const pathname = resolveAgentDatabaseRegistryPath(options);
  if (registeredAgentDatabasesMemo?.pathname === pathname) {
    registeredAgentDatabasesMemo = { pathname, token: Symbol(pathname) };
  }
}

function cloneRegisteredAgentDatabases(
  entries: readonly AforaRegisteredAgentDatabase[],
): AforaRegisteredAgentDatabase[] {
  return entries.map((entry) => ({ ...entry }));
}

function hasUnavailableMissingSqlitePath(pathname: string): boolean {
  for (const candidate of resolveSqliteDatabaseFilePaths(pathname)) {
    try {
      lstatSync(candidate);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return true;
      }
    }
  }

  let ancestor = path.dirname(pathname);
  while (true) {
    try {
      const stat = lstatSync(ancestor);
      if (!stat.isSymbolicLink()) {
        return !stat.isDirectory();
      }
      try {
        return !statSync(ancestor).isDirectory();
      } catch {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return true;
      }
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      return false;
    }
    ancestor = parent;
  }
}

/** List agent databases recorded in the shared Afora state registry. */
export function listAforaRegisteredAgentDatabases(
  options: AforaStateDatabaseOptions & {
    includeIncompatibleSchemaVersions?: boolean;
  } = {},
): AforaRegisteredAgentDatabase[] {
  const memo = activateRegisteredAgentDatabasesMemo(options);
  const { pathname } = memo;
  if (memo.entries) {
    const entries = cloneRegisteredAgentDatabases(memo.entries);
    return options.includeIncompatibleSchemaVersions
      ? entries
      : entries.filter((entry) => entry.schemaVersion === AFORA_AGENT_SCHEMA_VERSION);
  }
  // Discovery runs per row in list hot paths, so the legacy-schema gate and the
  // query share one process-held state handle instead of opening two connections.
  const entries = withExistingAforaStateDatabaseReadOnly(({ db: database }) => {
    if (detectAforaStateDatabaseSchemaMigrationsFromDatabase(database, pathname).length > 0) {
      throw new Error(
        `Afora state database ${pathname} has a legacy agent database registry schema; run afora doctor --fix to migrate it.`,
      );
    }
    const registryTable = database
      .prepare("SELECT type FROM sqlite_master WHERE name = 'agent_databases'")
      .get() as { type?: unknown } | undefined;
    if (!registryTable) {
      return [];
    }
    if (registryTable.type !== "table") {
      throw new Error(`Afora state database ${pathname} has an invalid agent registry.`);
    }
    const db = getNodeSqliteKysely<AforaAgentRegistryDatabase>(database);
    const rows = executeSqliteQuerySync(
      database,
      db
        .selectFrom("agent_databases")
        .selectAll()
        .orderBy("agent_id", "asc")
        .orderBy("path", "asc"),
    ).rows;
    return rows.map((row) => ({
      agentId: normalizeAgentId(row.agent_id),
      path: resolveAforaRegisteredAgentDatabasePath(pathname, row.path),
      schemaVersion: row.schema_version,
      lastSeenAt: row.last_seen_at,
      sizeBytes: row.size_bytes,
    }));
  }, options);
  if (entries === undefined) {
    if (hasUnavailableMissingSqlitePath(pathname)) {
      throw new Error(`Afora state database ${pathname} is unavailable.`);
    }
    memo.entries = [];
    return [];
  }
  memo.entries = entries;
  const cloned = cloneRegisteredAgentDatabases(entries);
  return options.includeIncompatibleSchemaVersions
    ? cloned
    : cloned.filter((entry) => entry.schemaVersion === AFORA_AGENT_SCHEMA_VERSION);
}
