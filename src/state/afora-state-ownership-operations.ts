import type { DatabaseSync } from "node:sqlite";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { configureSqliteWalMaintenance, type SqliteWalMaintenance } from "../infra/sqlite-wal.js";
import { AFORA_SQLITE_BUSY_TIMEOUT_MS } from "./afora-state-db-contract.js";
import {
  assertAforaStateDatabaseForMaintenance,
  resolveDatabasePath,
} from "./afora-state-db-maintenance.js";
import type { DB as AforaStateKyselyDatabase } from "./afora-state-db.generated.js";
import {
  openAforaStateDatabase,
  runAforaStateWriteTransaction,
  type AforaStateDatabaseOptions,
} from "./afora-state-db.js";
import {
  inspectAforaStateOwnershipFromDatabase,
  normalizeAforaStateManagerId,
  AforaStateOwnershipMetadataError,
  STATE_SUPERVISION_KEY,
  type AforaExternalStateOwnership,
  runWithAforaStateOwnershipCoordinator,
} from "./afora-state-ownership.js";

type AforaStateOwnershipOptions = Omit<AforaStateDatabaseOptions, "database" | "readOnly">;
type OwnershipDatabase = Pick<AforaStateKyselyDatabase, "config_machine_state">;

function requireOwnershipCheckpoint(
  walMaintenance: SqliteWalMaintenance,
  databasePath: string,
): void {
  if (!walMaintenance.checkpoint()) {
    throw new Error(
      `External ownership was committed for ${databasePath}, but its WAL checkpoint failed. Retry the same ownership claim before activating the supervisor.`,
    );
  }
}

function claimOwnershipRow(
  database: DatabaseSync,
  databasePath: string,
  managerId: string,
  repairMalformed: boolean,
): AforaExternalStateOwnership {
  let current: AforaExternalStateOwnership | null = null;
  try {
    current = inspectAforaStateOwnershipFromDatabase(database, databasePath);
  } catch (error) {
    if (!repairMalformed || !(error instanceof AforaStateOwnershipMetadataError)) {
      throw error;
    }
  }
  if (current) {
    if (current.managerId !== managerId) {
      throw new Error(
        `Afora shared state is already claimed by external manager ${current.managerId}; ` +
          `manager ${managerId} cannot replace that durable ownership.`,
      );
    }
    return current;
  }
  const ownership: AforaExternalStateOwnership = {
    version: 1,
    mode: "external",
    managerId,
    claimedAt: Date.now(),
  };
  const valueJson = JSON.stringify(ownership);
  const stateDb = getNodeSqliteKysely<OwnershipDatabase>(database);
  executeSqliteQuerySync(
    database,
    stateDb
      .insertInto("config_machine_state")
      .values({
        state_key: STATE_SUPERVISION_KEY,
        value_json: valueJson,
        updated_at_ms: ownership.claimedAt,
      })
      .onConflict((conflict) =>
        conflict.column("state_key").doUpdateSet({
          value_json: valueJson,
          updated_at_ms: ownership.claimedAt,
        }),
      ),
  );
  return ownership;
}

function repairMalformedOwnershipClaim(
  databasePath: string,
  managerId: string,
): AforaExternalStateOwnership {
  return runWithAforaStateOwnershipCoordinator(
    databasePath,
    "malformed state ownership repair/checkpoint",
    () => {
      const database = openNodeSqliteDatabase(databasePath);
      let walMaintenance: SqliteWalMaintenance | undefined;
      try {
        database.exec(`PRAGMA busy_timeout = ${AFORA_SQLITE_BUSY_TIMEOUT_MS};`);
        assertSqliteIntegrity(database, databasePath);
        assertAforaStateDatabaseForMaintenance(database, { pathname: databasePath });
        walMaintenance = configureSqliteWalMaintenance(database, {
          busyTimeoutMs: AFORA_SQLITE_BUSY_TIMEOUT_MS,
          checkpointIntervalMs: 0,
          checkpointMode: "TRUNCATE",
          databaseLabel: "Afora shared state ownership",
          databasePath,
        });
        const ownership = runSqliteImmediateTransactionSync(
          database,
          () => {
            assertAforaStateDatabaseForMaintenance(database, { pathname: databasePath });
            return claimOwnershipRow(database, databasePath, managerId, true);
          },
          {
            busyTimeoutMs: AFORA_SQLITE_BUSY_TIMEOUT_MS,
            databaseLabel: databasePath,
            operationLabel: "state.ownership.repair",
          },
        );
        requireOwnershipCheckpoint(walMaintenance, databasePath);
        return ownership;
      } finally {
        walMaintenance?.close({ checkpointMode: "PASSIVE" });
        clearNodeSqliteKyselyCacheForDatabase(database);
        database.close();
      }
    },
  );
}

/** Claim durable shared-state write ownership for the active external supervisor. */
export function claimAforaStateOwnership(
  managerId: string,
  options: AforaStateOwnershipOptions = {},
): AforaExternalStateOwnership {
  const env = options.env ?? process.env;
  if (!isGatewayExternallySupervised(env)) {
    throw new Error(
      "Claiming external shared-state ownership requires AFORA_SUPERVISOR_MODE=external.",
    );
  }
  const normalizedManagerId = normalizeAforaStateManagerId(managerId);
  try {
    const database = openAforaStateDatabase(options);
    return runWithAforaStateOwnershipCoordinator(
      database.path,
      "state ownership claim/checkpoint",
      () => {
        const ownership = runAforaStateWriteTransaction(
          ({ db, path: databasePath }) =>
            claimOwnershipRow(db, databasePath, normalizedManagerId, false),
          { ...options, database },
          { operationLabel: "state.ownership.claim" },
        );
        requireOwnershipCheckpoint(database.walMaintenance, database.path);
        return ownership;
      },
    );
  } catch (error) {
    if (!(error instanceof AforaStateOwnershipMetadataError)) {
      throw error;
    }
    const ownership = repairMalformedOwnershipClaim(
      resolveDatabasePath(options),
      normalizedManagerId,
    );
    openAforaStateDatabase(options);
    return ownership;
  }
}
