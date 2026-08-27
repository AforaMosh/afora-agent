import type { DatabaseSync } from "node:sqlite";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { AFORA_AGENT_SCHEMA_VERSION } from "./afora-agent-db-contract.js";
import {
  assertExistingAgentSchemaOwner,
  assertAforaAgentSchemaContains,
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./afora-agent-db-schema-helpers.js";
import { ensureAforaAgentDatabaseSchema } from "./afora-agent-db-schema.js";
import { AFORA_AGENT_SCHEMA_SQL } from "./afora-agent-schema.js";
import { AFORA_SQLITE_BUSY_TIMEOUT_MS } from "./afora-state-db.js";

/** Require exact agent ownership without requiring the latest schema. */
export function assertAforaAgentDatabaseOwner(
  database: DatabaseSync,
  options: { agentId: string; pathname: string },
): NonNullable<ReturnType<typeof readExistingAgentSchemaMeta>> {
  const agentId = normalizeAgentId(options.agentId);
  const metadata = readExistingAgentSchemaMeta(database);
  if (!metadata) {
    throw new Error(
      `Afora agent database ${options.pathname} has no schema ownership metadata.`,
    );
  }
  assertExistingAgentSchemaOwner(metadata, agentId, options.pathname);
  if (metadata.agentId !== agentId) {
    throw new Error(
      `Afora agent database ${options.pathname} belongs to agent ${metadata.agentId}; requested agent ${agentId}.`,
    );
  }
  return metadata;
}

/** Require the exact agent owner and schema before offline file maintenance. */
export function assertAforaAgentDatabaseForMaintenance(
  database: DatabaseSync,
  options: { agentId: string; pathname: string },
): void {
  const metadata = assertAforaAgentDatabaseOwner(database, options);

  const userVersion = readSqliteUserVersion(database);
  if (userVersion > AFORA_AGENT_SCHEMA_VERSION) {
    throw createNewerSqliteSchemaVersionError(
      "Afora agent database",
      options.pathname,
      userVersion,
      AFORA_AGENT_SCHEMA_VERSION,
    );
  }
  if (userVersion !== AFORA_AGENT_SCHEMA_VERSION) {
    throw new Error(
      `Afora agent database ${options.pathname} uses schema version ${userVersion}; run afora doctor --fix before compacting it.`,
    );
  }
  if (metadata.schemaVersion !== AFORA_AGENT_SCHEMA_VERSION) {
    throw new Error(
      `Afora agent database ${options.pathname} metadata schema version ${metadata.schemaVersion ?? "invalid"} does not match ${AFORA_AGENT_SCHEMA_VERSION}; run afora doctor --fix before compacting it.`,
    );
  }
  assertAforaAgentSchemaContains(database, options.pathname, AFORA_AGENT_SCHEMA_SQL);
}

/** Upgrade or repair a supported owned schema before strict offline maintenance. */
export function migrateAforaAgentDatabaseForMaintenance(options: {
  agentId: string;
  pathname: string;
}): void {
  const agentId = normalizeAgentId(options.agentId);
  const database = openNodeSqliteDatabase(options.pathname);
  try {
    database.exec(`PRAGMA busy_timeout = ${AFORA_SQLITE_BUSY_TIMEOUT_MS};`);
    const metadata = readExistingAgentSchemaMeta(database);
    if (!metadata) {
      return;
    }
    assertExistingAgentSchemaOwner(metadata, agentId, options.pathname);
    assertSupportedAgentSchemaVersion(database, options.pathname);
    const userVersion = readSqliteUserVersion(database);
    const metadataVersion = metadata.schemaVersion;
    const hasCurrentVersion =
      userVersion === AFORA_AGENT_SCHEMA_VERSION &&
      metadataVersion === AFORA_AGENT_SCHEMA_VERSION;
    const hasSupportedOlderVersion =
      userVersion >= 1 &&
      userVersion < AFORA_AGENT_SCHEMA_VERSION &&
      metadataVersion !== null &&
      metadataVersion === userVersion &&
      metadataVersion >= 1 &&
      metadataVersion < AFORA_AGENT_SCHEMA_VERSION;
    if (!hasCurrentVersion && !hasSupportedOlderVersion) {
      return;
    }
    ensureAforaAgentDatabaseSchema(database, {
      agentId,
      path: options.pathname,
    });
    assertAforaAgentDatabaseForMaintenance(database, {
      agentId,
      pathname: options.pathname,
    });
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(database);
    database.close();
  }
}
