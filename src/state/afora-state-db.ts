// Afora state database manages shared persisted state and migrations.
import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  enableNodeSqliteKyselyStatementCache,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import type { SqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import {
  repairCanonicalSqliteIndexes,
  verifyAndRepairCanonicalSqliteIndexes,
} from "../infra/sqlite-index-schema.js";
import {
  assertSqliteIntegrity,
  confirmSqliteFileIntegrity,
  isTerminalSqliteIntegrityError,
  type SqliteIntegrityConfirmation,
} from "../infra/sqlite-integrity.js";
import { prepareSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.js";
import { assertSqliteSchemaTablesPresent } from "../infra/sqlite-schema-contract.js";
import { migrateSqliteSchemaToStrictInTransaction } from "../infra/sqlite-strict.js";
import {
  isSqliteCorruptionError,
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import {
  configureSqliteConnectionPragmas,
  configureSqlitePreSchemaPragmas,
  type SqliteWalMaintenance,
} from "../infra/sqlite-wal.js";
import { migrateLegacyCronRunLogsToTaskRuns } from "../infra/state-migrations.cron-run-logs.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { VERSION } from "../version.js";
import { clearAforaDatabaseQuarantine } from "./afora-quarantine-store.js";
import { repairAuditEventsSchema } from "./afora-state-db-audit-migration.js";
import { aforaStateDatabaseCache as stateDbCache } from "./afora-state-db-cache.js";
import {
  AFORA_DATABASE_SCHEMA_DOCS_URL,
  LAZY_ADDITIVE_STATE_TABLES,
  AFORA_SQLITE_BUSY_TIMEOUT_MS,
  AFORA_STATE_SCHEMA_VERSION,
  AFORA_STATE_STRICT_SCHEMA_VERSION,
  type AforaStateDatabase,
  type AforaStateDatabaseOptions,
} from "./afora-state-db-contract.js";
import {
  assertAforaStateDatabaseForMaintenance,
  assertAforaStateDatabaseV5ForMigration,
  assertAforaStateDatabaseV6ForMigration,
  assertAforaStateDatabaseV7ForMigration,
  assertAforaStateDatabaseV8ForMigration,
  assertSupportedSchemaVersion,
  resolveDatabasePath,
} from "./afora-state-db-maintenance.js";
import * as operatorApprovalMigration from "./afora-state-db-operator-approval-migration.js";
import { ensureAforaStatePermissions } from "./afora-state-db-permissions.js";
import {
  ensureAdditiveStateColumns,
  ensureFirstUseAdditiveStateColumnsForStrictMigration,
} from "./afora-state-db-schema-additive.js";
import { tableExists } from "./afora-state-db-schema-helpers.js";
import {
  type AgentDatabasePathMigrationSummary as AgentPathSummary,
  assertCanonicalStateSchemaShape,
  detectAforaStateDatabaseSchemaMigrationsFromDatabase,
  dropLegacyStateTables,
  markCurrentStateSchemaVersion,
  migrateAgentDatabaseRelativePaths as migrateAgentPaths,
  migrateRetiredCommitmentsSchema,
  migrateWorkerPlacementExecutionModeSchema,
  repairAgentDatabasesCompositePrimaryKey,
  repairLegacyGatewayRestartHandoffsForStrictMigration,
} from "./afora-state-db-schema-repair.js";
import * as sessionWatchMigration from "./afora-state-db-session-watch-migration.js";
import type { DB as AforaStateKyselyDatabase } from "./afora-state-db.generated.js";
import { describeAgentPathMigration, warnAgentPathMigration } from "./afora-state-db.paths.js";
import {
  assertAforaStateWriteAllowed,
  AforaStateOwnershipError,
  runWithAforaStateWriteAccess,
} from "./afora-state-ownership.js";
import { getAforaStateRuntimeSchema } from "./afora-state-schema-compatibility.js";
import { AFORA_STATE_SCHEMA_SQL } from "./afora-state-schema.js";
export { registerAforaStateDatabaseLifecycleListener } from "./afora-state-db-cache.js";

const STATE_MIGRATION_ASSERTIONS = {
  5: assertAforaStateDatabaseV5ForMigration,
  6: assertAforaStateDatabaseV6ForMigration,
  7: assertAforaStateDatabaseV7ForMigration,
  8: assertAforaStateDatabaseV8ForMigration,
} as const;

export {
  AFORA_DATABASE_SCHEMA_DOCS_URL,
  AFORA_SQLITE_BUSY_TIMEOUT_MS,
  AFORA_STATE_SCHEMA_VERSION,
};
export type {
  AforaStateDatabase,
  AforaStateDatabaseOptions,
  AforaStateDatabaseSchemaMigration,
} from "./afora-state-db-contract.js";
export {
  assertAforaStateDatabaseForMaintenance,
  createAforaDatabaseVerificationError,
} from "./afora-state-db-maintenance.js";
export { ensureAforaStatePermissions } from "./afora-state-db-permissions.js";
export { detectAforaStateDatabaseSchemaMigrations } from "./afora-state-db-schema-repair.js";
export { withAforaStateStartupMigrationCheckpointDatabase } from "./afora-state-db-startup-checkpoint.js";

/** Reconfirm an advisory worker failure on the live owner connection. */
export function confirmAforaStateDatabaseIntegrity(
  pathname: string,
): SqliteIntegrityConfirmation {
  const resolvedPath = path.resolve(pathname);
  closeAforaStateDatabaseByPath(resolvedPath);
  return confirmSqliteFileIntegrity(resolvedPath, resolvedPath);
}

/** Latch background verification damage so later opens fail without rescanning. */
export function recordAforaStateDatabaseOpenFailure(
  pathname: string,
  error: Error,
  generation?: SqliteFileGeneration,
): boolean {
  return stateDbCache.recordAforaStateDatabaseOpenFailure(pathname, error, generation);
}

/** Clear a terminal open failure after doctor rewrites the database file. */
export function clearAforaStateDatabaseOpenFailure(pathname: string): void {
  stateDbCache.clearAforaStateDatabaseOpenFailure(pathname);
}

/** Reject a fresh shared-state open after known corruption until repair clears it. */
export function assertAforaStateDatabaseFreshOpenAllowed(
  options: AforaStateDatabaseOptions = {},
): void {
  const env = options.env ?? process.env;
  stateDbCache.assertAforaStateDatabaseFreshOpenAllowedAtPath(resolveDatabasePath(options), env);
}

type AforaStateMetadataDatabase = Pick<AforaStateKyselyDatabase, "schema_meta">;
const stateDbLog = createSubsystemLogger("state/db");

function executeCanonicalStateSchema(
  database: DatabaseSync,
  options: { includeVersionLazyAdditiveTables: boolean },
): void {
  database.exec(getAforaStateRuntimeSchema(options));
}

function repairAforaStateDatabaseSchemaWithWriteAccess(
  pathname: string,
  env: NodeJS.ProcessEnv,
): {
  changes: string[];
  warnings: string[];
} {
  ensureAforaStatePermissions(pathname, env);
  const db = openNodeSqliteDatabase(pathname);
  const rebuiltIndexNames = new Set<string>();
  let ownershipRefused = false;
  try {
    db.exec(`PRAGMA busy_timeout = ${AFORA_SQLITE_BUSY_TIMEOUT_MS};`);
    assertSupportedSchemaVersion(db, pathname);
    db.exec("PRAGMA foreign_keys = OFF;");
    const changes = runSqliteImmediateTransactionSync(
      db,
      () => {
        assertAforaStateWriteAllowed({ database: db, databasePath: pathname, env });
        const applied: string[] = [];
        const previousVersion = readSqliteUserVersion(db);
        if (previousVersion === AFORA_STATE_SCHEMA_VERSION) {
          for (const name of repairCanonicalSqliteIndexes(db, pathname, AFORA_STATE_SCHEMA_SQL, {
            allowMissingColumns: true,
          })) {
            rebuiltIndexNames.add(name);
          }
          // Current-schema doctor repair may normalize recognized columns or
          // table options, but it must never recreate a missing table empty.
          assertSqliteSchemaTablesPresent(db, pathname, AFORA_STATE_SCHEMA_SQL, {
            allowedMissingTables: LAZY_ADDITIVE_STATE_TABLES,
          });
        } else if (
          previousVersion === 5 ||
          previousVersion === 6 ||
          previousVersion === 7 ||
          previousVersion === 8
        ) {
          STATE_MIGRATION_ASSERTIONS[previousVersion](db, { pathname });
        }
        if (rebuiltIndexNames.size === 0) {
          assertSqliteIntegrity(db, pathname);
        }
        dropLegacyStateTables(db);
        if (migrateRetiredCommitmentsSchema(db, previousVersion)) {
          applied.push("Retired shared state commitments table and indexes");
        }
        if (migrateWorkerPlacementExecutionModeSchema(db, previousVersion)) {
          applied.push("Migrated cloud worker placements to execution modes");
        }
        applied.push(
          ...describeAgentPathMigration(migrateAgentPaths(db, previousVersion, pathname)),
        );
        if (repairAgentDatabasesCompositePrimaryKey(db)) {
          applied.push(`Migrated shared state agent database registry primary key → agent_id,path`);
        }
        if (repairAuditEventsSchema(db)) {
          applied.push(
            `Migrated shared state audit event ledger → versioned message lifecycle schema`,
          );
        }
        applied.push(...operatorApprovalMigration.repairOperatorApprovalSchema(db));
        const needsSessionWatchMigration =
          sessionWatchMigration.needsSessionWatchCursorProvenanceMigration(db, previousVersion);
        const sessionWatchResult = sessionWatchMigration.migrateSessionWatchCursorProvenance(db);
        if (needsSessionWatchMigration) {
          applied.push(
            `Migrated shared state session watch cursors → provenance column (${sessionWatchResult.migratedAmbientWatches} ambient, ${sessionWatchResult.removedLegacySentinels} sentinels removed)`,
          );
        }
        assertCanonicalStateSchemaShape(db, pathname);
        if (tableExists(db, "audit_events")) {
          ensureAdditiveStateColumns(db);
          executeCanonicalStateSchema(db, {
            includeVersionLazyAdditiveTables: previousVersion !== AFORA_STATE_SCHEMA_VERSION,
          });
          if (previousVersion < AFORA_STATE_STRICT_SCHEMA_VERSION) {
            repairLegacyGatewayRestartHandoffsForStrictMigration(db);
            ensureFirstUseAdditiveStateColumnsForStrictMigration(db);
          }
          const strictMigration = migrateSqliteSchemaToStrictInTransaction(
            db,
            getAforaStateRuntimeSchema({
              includeVersionLazyAdditiveTables: previousVersion !== AFORA_STATE_SCHEMA_VERSION,
            }),
            { databaseLabel: pathname },
          );
          if (strictMigration.migratedTables.length > 0) {
            applied.push(
              `Migrated shared state tables to SQLite STRICT typing (${strictMigration.migratedTables.length})`,
            );
          }
          for (const name of repairCanonicalSqliteIndexes(db, pathname, AFORA_STATE_SCHEMA_SQL, {
            verifyPhysicalIntegrity: false,
          })) {
            rebuiltIndexNames.add(name);
          }
        }
        markCurrentStateSchemaVersion(db, {
          createMetadataIfMissing: previousVersion < AFORA_STATE_SCHEMA_VERSION,
        });
        if (readSqliteUserVersion(db) === AFORA_STATE_SCHEMA_VERSION) {
          assertCurrentStateRuntimeSchema(db, pathname);
        }
        if (rebuiltIndexNames.size > 0) {
          applied.push(`Rebuilt canonical shared-state SQLite indexes (${rebuiltIndexNames.size})`);
        }
        return applied;
      },
      {
        busyTimeoutMs: AFORA_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: pathname,
        operationLabel: "state.schema.repair",
      },
    );
    const quarantineCleared = clearAforaDatabaseQuarantine(pathname, { env });
    clearAforaStateDatabaseOpenFailure(pathname);
    return {
      changes,
      warnings: quarantineCleared
        ? []
        : [
            `Persisted quarantine record for ${pathname} could not be cleared; rerun afora doctor --fix so the repaired database is not refused again.`,
          ],
    };
  } catch (err) {
    if (err instanceof AforaStateOwnershipError) {
      ownershipRefused = true;
      throw err;
    }
    // Reaching this catch inside doctor means repair itself refused or failed,
    // so the runtime asserts' "run afora doctor --fix" advice is circular here.
    const reason = String(err).replace(
      /has a legacy ([a-z ]+) schema; run afora doctor --fix to migrate it\./u,
      "has a legacy $1 schema; automatic repair refused the unrecognized schema shape.",
    );
    return {
      changes: [],
      warnings: [`Failed migrating shared state database schema at ${pathname}: ${reason}`],
    };
  } finally {
    if (db.isOpen) {
      db.exec("PRAGMA foreign_keys = ON;");
    }
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
    if (!ownershipRefused) {
      ensureAforaStatePermissions(pathname, env);
    }
  }
}

export function repairAforaStateDatabaseSchema(options: AforaStateDatabaseOptions = {}): {
  changes: string[];
  warnings: string[];
} {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return { changes: [], warnings: [] };
  }
  return runWithAforaStateWriteAccess(
    { databasePath: pathname, env },
    "state schema repair",
    () => repairAforaStateDatabaseSchemaWithWriteAccess(pathname, env),
  );
}

function needsAforaStateDatabaseSchemaRepair(pathname: string): boolean {
  let database: DatabaseSync | undefined;
  try {
    database = openNodeSqliteDatabase(pathname, { readOnly: true });
    assertSupportedSchemaVersion(database, pathname);
    const needsRepair =
      readSqliteUserVersion(database) !== AFORA_STATE_SCHEMA_VERSION ||
      detectAforaStateDatabaseSchemaMigrationsFromDatabase(database, pathname).length > 0;
    if (!needsRepair) {
      assertCurrentStateRuntimeSchema(database, pathname);
    }
    return needsRepair;
  } catch {
    // Preserve the repair path's existing diagnostics for unreadable or noncanonical databases.
    return true;
  } finally {
    database?.close();
  }
}

/** Skip the exclusive doctor repair when automatic migration sees a canonical current schema. */
export function repairAforaStateDatabaseSchemaIfNeeded(
  options: AforaStateDatabaseOptions = {},
): {
  changes: string[];
  warnings: string[];
} {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return { changes: [], warnings: [] };
  }

  return runWithAforaStateWriteAccess(
    { databasePath: pathname, env },
    "state schema repair preflight/repair",
    () =>
      needsAforaStateDatabaseSchemaRepair(pathname)
        ? repairAforaStateDatabaseSchemaWithWriteAccess(pathname, env)
        : { changes: [], warnings: [] },
  );
}

function ensureSchema(db: DatabaseSync, pathname: string, env: NodeJS.ProcessEnv): void {
  const now = Date.now();
  const kysely = getNodeSqliteKysely<AforaStateMetadataDatabase>(db);
  // Rebuilding referenced tables requires disabling FK enforcement before BEGIN.
  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    runSqliteImmediateTransactionSync(
      db,
      () => {
        // Recheck ownership after BEGIN IMMEDIATE so no current-schema repair
        // can race a durable external ownership claim.
        assertAforaStateWriteAllowed({ database: db, databasePath: pathname, env });
        assertSupportedSchemaVersion(db, pathname);
        const previousVersion = readSqliteUserVersion(db);
        if (previousVersion === AFORA_STATE_SCHEMA_VERSION) {
          verifyAndRepairCanonicalSqliteIndexes(db, pathname, AFORA_STATE_SCHEMA_SQL, {
            allowMissingColumns: true,
            validateAfterRepair: () => assertCurrentStateRuntimeSchema(db, pathname),
          });
          ensureAdditiveStateColumns(db);
          assertCurrentStateRuntimeSchema(db, pathname);
        } else if (
          previousVersion === 5 ||
          previousVersion === 6 ||
          previousVersion === 7 ||
          previousVersion === 8
        ) {
          STATE_MIGRATION_ASSERTIONS[previousVersion](db, { pathname });
        }
        dropLegacyStateTables(db);
        migrateRetiredCommitmentsSchema(db, previousVersion);
        migrateWorkerPlacementExecutionModeSchema(db, previousVersion);
        const pathMigration: AgentPathSummary = migrateAgentPaths(db, previousVersion, pathname);
        ensureAdditiveStateColumns(db);
        sessionWatchMigration.migrateSessionWatchCursorProvenance(db);
        assertCanonicalStateSchemaShape(db, pathname);
        executeCanonicalStateSchema(db, {
          includeVersionLazyAdditiveTables: previousVersion !== AFORA_STATE_SCHEMA_VERSION,
        });
        migrateLegacyCronRunLogsToTaskRuns(db);
        if (previousVersion < AFORA_STATE_STRICT_SCHEMA_VERSION) {
          repairLegacyGatewayRestartHandoffsForStrictMigration(db);
          ensureFirstUseAdditiveStateColumnsForStrictMigration(db);
          migrateSqliteSchemaToStrictInTransaction(
            db,
            getAforaStateRuntimeSchema({
              includeVersionLazyAdditiveTables: previousVersion !== AFORA_STATE_SCHEMA_VERSION,
            }),
            { databaseLabel: pathname },
          );
        }
        repairCanonicalSqliteIndexes(db, pathname, AFORA_STATE_SCHEMA_SQL, {
          verifyPhysicalIntegrity: false,
        });
        db.exec(`PRAGMA user_version = ${AFORA_STATE_SCHEMA_VERSION};`);
        executeSqliteQuerySync(
          db,
          kysely
            .insertInto("schema_meta")
            .values({
              meta_key: "primary",
              role: "global",
              schema_version: AFORA_STATE_SCHEMA_VERSION,
              agent_id: null,
              app_version: VERSION,
              created_at: now,
              updated_at: now,
            })
            .onConflict((conflict) =>
              conflict
                .column("meta_key")
                .doUpdateSet({
                  role: "global",
                  schema_version: AFORA_STATE_SCHEMA_VERSION,
                  agent_id: null,
                  app_version: VERSION,
                  updated_at: now,
                })
                // updated_at records when schema metadata last changed, not when
                // the database was last opened; unconditional bumps make every
                // open dirty the row and defeat no-change backup detection.
                .where((eb) =>
                  eb.or([
                    eb("schema_meta.schema_version", "!=", AFORA_STATE_SCHEMA_VERSION),
                    eb("schema_meta.app_version", "!=", VERSION),
                    eb("schema_meta.role", "!=", "global"),
                  ]),
                ),
            ),
        );
        assertAforaStateDatabaseForMaintenance(db, { pathname });
        warnAgentPathMigration(stateDbLog, pathMigration, pathname);
      },
      {
        busyTimeoutMs: AFORA_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: pathname,
        operationLabel: "state.schema.ensure",
      },
    );
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

/** Open existing shared state without creating, migrating, chmodding, or configuring it. */
export async function openExistingAforaStateDatabaseReadOnly(
  options: AforaStateDatabaseOptions = {},
): Promise<AforaStateDatabase | undefined> {
  const pathname = resolveDatabasePath(options);
  if (!existsSync(pathname)) {
    return undefined;
  }
  assertAforaStateDatabaseFreshOpenAllowed(options);
  const prepared = await prepareSqliteReadOnlyLocation(pathname);
  let db: DatabaseSync;
  try {
    db = openNodeSqliteDatabase(prepared.location, {
      readOnly: true,
    });
  } catch (error) {
    prepared.cleanup();
    throw error;
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${AFORA_SQLITE_BUSY_TIMEOUT_MS};`);
    assertSupportedSchemaVersion(db, pathname);
    assertSqliteIntegrity(db, pathname);
    if (readSqliteUserVersion(db) === AFORA_STATE_SCHEMA_VERSION) {
      assertAforaStateDatabaseForMaintenance(db, { pathname });
    }
  } catch (error) {
    try {
      clearNodeSqliteKyselyCacheForDatabase(db);
      db.close();
    } catch {
      // Preserve the verification failure that explains why the database was refused.
    }
    prepared.cleanup();
    throw error;
  }
  let cleanupComplete = false;
  return {
    db,
    path: pathname,
    walMaintenance: {
      checkpoint: () => false,
      // Cleanup can fail transiently after the database closes. Keep the
      // close contract retryable until one call finishes both responsibilities.
      close: () => {
        const wasOpen = db.isOpen;
        if (!wasOpen && cleanupComplete) {
          return false;
        }
        try {
          if (wasOpen) {
            clearNodeSqliteKyselyCacheForDatabase(db);
            db.close();
          }
        } finally {
          cleanupComplete = prepared.cleanup();
        }
        return cleanupComplete;
      },
    },
  };
}

function assertCurrentStateRuntimeSchema(database: DatabaseSync, pathname: string): void {
  assertCanonicalStateSchemaShape(database, pathname);
  assertAforaStateDatabaseForMaintenance(database, { pathname });
}

function assertStateDatabaseIntegrityBeforeMutation(
  database: DatabaseSync,
  pathname: string,
): void {
  database.exec(`PRAGMA busy_timeout = ${AFORA_SQLITE_BUSY_TIMEOUT_MS};`);
  const userVersion = readSqliteUserVersion(database);
  const hasApplicationSchema = database
    .prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1")
    .get();
  const migrationPending =
    (userVersion === 0 && hasApplicationSchema) ||
    (userVersion > 0 && userVersion < AFORA_STATE_SCHEMA_VERSION);
  if (migrationPending) {
    stateDbLog.info("state database schema migration pending; verifying integrity first", {
      fromVersion: userVersion,
      path: pathname,
      toVersion: AFORA_STATE_SCHEMA_VERSION,
    });
  }
  if (userVersion !== AFORA_STATE_SCHEMA_VERSION) {
    // Every physical open proves the full file before schema mutation or exposure.
    assertSqliteIntegrity(database, pathname);
  }
}

function openUnpublishedAforaStateDatabase(
  pathname: string,
  env: NodeJS.ProcessEnv,
): AforaStateDatabase {
  ensureAforaStatePermissions(pathname, env);
  const db = openNodeSqliteDatabase(pathname);
  enableNodeSqliteKyselyStatementCache(db);
  const walMaintenance = (() => {
    let maintenance: SqliteWalMaintenance | undefined;
    try {
      db.exec(`PRAGMA busy_timeout = ${AFORA_SQLITE_BUSY_TIMEOUT_MS};`);
      assertSupportedSchemaVersion(db, pathname);
      assertStateDatabaseIntegrityBeforeMutation(db, pathname);
      configureSqlitePreSchemaPragmas(db, {
        busyTimeoutMs: AFORA_SQLITE_BUSY_TIMEOUT_MS,
      });
      maintenance = configureSqliteConnectionPragmas(db, {
        busyTimeoutMs: AFORA_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: "afora-state",
        databasePath: pathname,
        foreignKeys: true,
        synchronous: "NORMAL",
      });
      ensureSchema(db, pathname, env);
      return maintenance;
    } catch (err) {
      maintenance?.close();
      db.close();
      if (
        err instanceof Error &&
        (err.name === "SqliteSchemaVersionError" || isTerminalSqliteIntegrityError(err))
      ) {
        recordAforaStateDatabaseOpenFailure(pathname, err);
      }
      throw err;
    }
  })();
  ensureAforaStatePermissions(pathname, env);
  return { db, path: pathname, walMaintenance };
}

/** Open or return a cached shared state database after schema and migration checks. */

export function openAforaStateDatabase(
  options: AforaStateDatabaseOptions = {},
): AforaStateDatabase {
  const env = options.env ?? process.env;
  if (options.database) {
    assertAforaStateWriteAllowed({
      database: options.database.db,
      databasePath: options.database.path,
      env,
    });
    return options.database;
  }
  const pathname = resolveDatabasePath(options);
  // Latched paths are quarantined: the recorder closed any live handle, and
  // every open fails fast here until doctor repairs the file and clears it.
  try {
    stateDbCache.assertAforaStateDatabaseOpenAllowed(pathname);
  } catch (error) {
    stateDbCache.recordAforaStateDatabaseLifecycleOpenError(pathname, error);
    throw error;
  }
  const cached = stateDbCache.getCachedAforaStateDatabase(pathname);
  if (cached?.db.isOpen) {
    assertAforaStateWriteAllowed({ database: cached.db, databasePath: pathname, env });
    return cached;
  }
  try {
    assertAforaStateDatabaseFreshOpenAllowed(options);
  } catch (error) {
    stateDbCache.recordAforaStateDatabaseLifecycleOpenError(pathname, error);
    throw error;
  }
  let unpublished: AforaStateDatabase | undefined;
  try {
    unpublished = runWithAforaStateWriteAccess(
      { databasePath: pathname, env },
      "fresh state database open",
      () => {
        if (cached) {
          // A closed handle can leave Kysely and WAL helpers cached; clear both under access.
          stateDbCache.closeStaleCachedAforaStateDatabase(cached);
        }
        return (unpublished = openUnpublishedAforaStateDatabase(pathname, env));
      },
    );
  } catch (error) {
    stateDbCache.recordAforaStateDatabaseLifecycleOpenError(pathname, error);
    if (!unpublished) {
      throw error;
    }
    const cleanup = stateDbCache.closeAforaStateDatabaseHandle(unpublished);
    if (cleanup.caught) {
      throw createSqliteLifecycleAggregateError(
        [error, ...cleanup.errors],
        `Fresh Afora state database open failed releasing access and closing its unpublished handle for ${pathname}.`,
        error,
      );
    }
    throw error;
  }
  return stateDbCache.publishAforaStateDatabase(unpublished);
}

/** Run a synchronous immediate transaction against the shared state database. */
export function runAforaStateWriteTransaction<T>(
  operation: (database: AforaStateDatabase) => T,
  options: AforaStateDatabaseOptions = {},
  transactionOptions: Pick<
    SqliteTransactionOptions,
    "busyTimeoutMs" | "operationLabel" | "slowTransactionHoldMs"
  > = {},
): T {
  const cachedBeforeOpen = options.database ?? getAforaStateDatabaseIfOpen(options);
  let database: AforaStateDatabase;
  try {
    database = openAforaStateDatabase(options);
  } catch (error) {
    if (cachedBeforeOpen && isSqliteCorruptionError(error)) {
      stateDbCache.evictCachedAforaStateDatabase(cachedBeforeOpen);
    }
    throw error;
  }
  let result: T;
  try {
    result = runSqliteImmediateTransactionSync(
      database.db,
      () => {
        assertAforaStateWriteAllowed({
          database: database.db,
          databasePath: database.path,
          env: options.env ?? process.env,
        });
        return operation(database);
      },
      {
        busyTimeoutMs: transactionOptions.busyTimeoutMs ?? AFORA_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: database.path,
        ...transactionOptions,
        operationLabel: transactionOptions.operationLabel ?? "state.write",
      },
    );
  } catch (error) {
    if (isSqliteCorruptionError(error)) {
      stateDbCache.evictCachedAforaStateDatabase(database);
    }
    throw error;
  }
  try {
    ensureAforaStatePermissions(database.path, options.env ?? process.env);
  } catch {
    // The write already committed; permission hardening is best-effort here so
    // callers never retry an operation that is durable in SQLite.
  }
  return result;
}

/**
 * Return a shared state handle this process already holds open, if any.
 *
 * Read-only callers use this to avoid opening a connection per call; it never
 * creates, repairs, or registers a handle.
 */
export function getAforaStateDatabaseIfOpen(
  options: AforaStateDatabaseOptions = {},
): AforaStateDatabase | undefined {
  return stateDbCache.getAforaStateDatabaseIfOpenAtPath(resolveDatabasePath(options));
}

/** Evict an exact cached shared-state owner after a proven corruption read. */
export function evictAforaStateDatabaseAfterCorruption(
  database: AforaStateDatabase,
  error: unknown,
): boolean {
  return stateDbCache.evictAforaStateDatabaseAfterCorruption(database, error);
}

/** Close one cached shared state database handle by exact pathname. */
export function closeAforaStateDatabaseByPath(pathname: string): boolean {
  return stateDbCache.closeAforaStateDatabaseByPath(pathname);
}

/** Close all cached shared state database handles. */
export function closeAforaStateDatabase(
  options?: Parameters<typeof stateDbCache.closeAforaStateDatabase>[0],
): void {
  stateDbCache.closeAforaStateDatabase(options);
}

/** Test whether any cached shared state database handle is still open. */
export function isAforaStateDatabaseOpen(): boolean {
  return stateDbCache.isAforaStateDatabaseOpen();
}

/** Close shared state handles and clear terminal failure latches for test isolation. */
export function closeAforaStateDatabaseForTest(): void {
  stateDbCache.closeAforaStateDatabaseForTest();
}
