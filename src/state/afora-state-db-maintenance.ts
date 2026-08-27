import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  assertSqliteSchemaContains,
  assertSqliteSchemaTablesPresent,
} from "../infra/sqlite-schema-contract.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import {
  AFORA_DATABASE_SCHEMA_DOCS_URL,
  LAZY_ADDITIVE_STATE_TABLES,
  AFORA_STATE_SCHEMA_VERSION,
  type AforaStateDatabaseOptions,
} from "./afora-state-db-contract.js";
import { resolveAforaStateSqlitePath } from "./afora-state-db.paths.js";
import { AFORA_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY } from "./afora-state-schema-compatibility.js";
import { AFORA_STATE_SCHEMA_SQL } from "./afora-state-schema.js";

const STATE_V6_ADDITIVE_TABLES = [
  ...LAZY_ADDITIVE_STATE_TABLES,
  "worker_session_tool_operations",
  "worker_turn_tool_authorities",
] as const;
const STATE_V5_ADDITIVE_TABLES = [
  "agent_database_leases",
  "agent_deletion_journal",
  "claw_cron_refs",
  "claw_installs",
  "claw_mcp_server_refs",
  "claw_package_refs",
  "claw_workspace_files",
  "config_machine_state",
  "cron_job_scratch",
  "meeting_transcript_sessions",
  "meeting_transcript_summaries",
  "meeting_transcript_utterances",
  "outbound_media_provenance",
  "worker_environment_credentials",
  "worker_transcript_commit_heads",
  "worker_transcript_commits",
  ...STATE_V6_ADDITIVE_TABLES,
] as const;
const STATE_MIGRATION_ALLOWED_MISSING_TABLES = {
  5: STATE_V5_ADDITIVE_TABLES,
  6: STATE_V6_ADDITIVE_TABLES,
  7: STATE_V6_ADDITIVE_TABLES,
  8: STATE_V6_ADDITIVE_TABLES,
} as const satisfies Record<number, readonly string[]>;
type AforaStateMigrationVersion = keyof typeof STATE_MIGRATION_ALLOWED_MISSING_TABLES;

/** Open shared SQLite database handle plus WAL maintenance lifecycle. */

export function createAforaDatabaseVerificationError(
  kind: "agent" | "state",
  pathname: string,
  storedError: string | null,
): Error {
  // Doctor's clearing hooks run after a full integrity assertion, so a still-
  // corrupt file cannot be cleared directly: the file must be healthy first.
  const error = new Error(
    `Afora ${kind} database ${pathname} is quarantined after integrity verification failed: ${storedError ?? "unknown integrity error"}. Restore the database from a backup or repair it, then run afora doctor --fix to clear the quarantine. See ${AFORA_DATABASE_SCHEMA_DOCS_URL}.`,
  );
  error.name = "SqliteIntegrityError";
  return error;
}

export function assertSupportedSchemaVersion(db: DatabaseSync, pathname: string): void {
  const userVersion = readSqliteUserVersion(db);
  if (userVersion > AFORA_STATE_SCHEMA_VERSION) {
    throw createNewerSqliteSchemaVersionError(
      "Afora state database",
      pathname,
      userVersion,
      AFORA_STATE_SCHEMA_VERSION,
    );
  }
}

/** Require canonical shared-state ownership without requiring the latest schema. */
export function assertAforaStateDatabaseOwner(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  const hasMetadataTable = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta' LIMIT 1")
    .get();
  const metadata = hasMetadataTable
    ? (database.prepare("SELECT role FROM schema_meta WHERE meta_key = 'primary' LIMIT 1").get() as
        | { role?: unknown }
        | undefined)
    : undefined;
  if (metadata?.role !== "global") {
    const role = typeof metadata?.role === "string" ? metadata.role : "missing";
    throw new Error(
      `Afora state database ${options.pathname} has schema role ${role}; expected global.`,
    );
  }
}

/** Require the canonical shared-state owner and schema before offline file maintenance. */
export function assertAforaStateDatabaseForMaintenance(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  const userVersion = readSqliteUserVersion(database);
  if (userVersion > AFORA_STATE_SCHEMA_VERSION) {
    throw createNewerSqliteSchemaVersionError(
      "Afora state database",
      options.pathname,
      userVersion,
      AFORA_STATE_SCHEMA_VERSION,
    );
  }
  if (userVersion !== AFORA_STATE_SCHEMA_VERSION) {
    throw new Error(
      `Afora state database ${options.pathname} uses schema version ${userVersion}; run afora doctor --fix before compacting it.`,
    );
  }

  assertAforaStateDatabaseOwner(database, options);
  const metadata = database
    .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1")
    .get() as { schema_version?: unknown } | undefined;
  if (metadata?.schema_version !== AFORA_STATE_SCHEMA_VERSION) {
    const schemaVersion =
      typeof metadata?.schema_version === "number" ? metadata.schema_version : "invalid";
    throw new Error(
      `Afora state database ${options.pathname} metadata schema version ${schemaVersion} does not match ${AFORA_STATE_SCHEMA_VERSION}; run afora doctor --fix before compacting it.`,
    );
  }
  assertSqliteSchemaContains(
    database,
    options.pathname,
    AFORA_STATE_SCHEMA_SQL,
    AFORA_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
  );
}

function assertAforaStateDatabaseVersionForMigration(
  database: DatabaseSync,
  options: { pathname: string; version: AforaStateMigrationVersion },
): void {
  const userVersion = readSqliteUserVersion(database);
  if (userVersion !== options.version) {
    throw new Error(
      `Afora state database ${options.pathname} uses schema version ${userVersion}; expected ${options.version} before migrating it.`,
    );
  }
  assertAforaStateDatabaseOwner(database, options);
  const metadata = database
    .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1")
    .get() as { schema_version?: unknown } | undefined;
  if (metadata?.schema_version !== options.version) {
    const schemaVersion =
      typeof metadata?.schema_version === "number" ? metadata.schema_version : "invalid";
    throw new Error(
      `Afora state database ${options.pathname} metadata schema version ${schemaVersion} does not match ${options.version}; repair the ownership metadata before migrating it.`,
    );
  }
  assertSqliteSchemaTablesPresent(database, options.pathname, AFORA_STATE_SCHEMA_SQL, {
    allowedMissingTables: STATE_MIGRATION_ALLOWED_MISSING_TABLES[options.version],
  });
}

/** Require every stable v5 table before the v6 additive migration can run. */
export function assertAforaStateDatabaseV5ForMigration(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  assertAforaStateDatabaseVersionForMigration(database, { ...options, version: 5 });
}

/** Require every stable v6 table before the v7 retirement migration can run. */
export function assertAforaStateDatabaseV6ForMigration(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  assertAforaStateDatabaseVersionForMigration(database, { ...options, version: 6 });
}

/** Require every stable v7 table before the v8 placement migration can run. */
export function assertAforaStateDatabaseV7ForMigration(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  assertAforaStateDatabaseVersionForMigration(database, { ...options, version: 7 });
}

/** Require every stable v8 table before the v9 registry migration can run. */
export function assertAforaStateDatabaseV8ForMigration(
  database: DatabaseSync,
  options: { pathname: string },
): void {
  assertAforaStateDatabaseVersionForMigration(database, { ...options, version: 8 });
}

export function resolveDatabasePath(options: AforaStateDatabaseOptions = {}): string {
  return path.resolve(options.path ?? resolveAforaStateSqlitePath(options.env ?? process.env));
}
