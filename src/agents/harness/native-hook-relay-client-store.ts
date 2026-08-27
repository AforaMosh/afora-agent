import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../../infra/sqlite-user-version.js";
import {
  AFORA_SQLITE_BUSY_TIMEOUT_MS,
  AFORA_STATE_SCHEMA_VERSION,
} from "../../state/afora-state-db-contract.js";
import type { DB as AforaStateKyselyDatabase } from "../../state/afora-state-db.generated.js";
import { resolveAforaStateSqlitePath } from "../../state/afora-state-db.paths.js";
import {
  readNativeHookRelayBridgeRecordRow,
  type NativeHookRelayBridgeRecord,
} from "./native-hook-relay-bridge-record.js";

type NativeHookRelayBridgeDatabase = Pick<AforaStateKyselyDatabase, "native_hook_relay_bridges">;

function assertSupportedSchemaVersion(db: DatabaseSync, pathname: string): void {
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

/** Read one native relay locator without loading the shared-state writer lifecycle. */
export function readNativeHookRelayClientBridgeRecord(params: {
  relayId: string;
  stateDbPath?: string;
}): NativeHookRelayBridgeRecord | undefined {
  const pathname = path.resolve(params.stateDbPath ?? resolveAforaStateSqlitePath());
  const db = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${AFORA_SQLITE_BUSY_TIMEOUT_MS};`);
    assertSupportedSchemaVersion(db, pathname);
    const query = getNodeSqliteKysely<NativeHookRelayBridgeDatabase>(db)
      .selectFrom("native_hook_relay_bridges")
      .selectAll()
      .where("relay_id", "=", params.relayId);
    return readNativeHookRelayBridgeRecordRow(executeSqliteQueryTakeFirstSync(db, query));
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
  }
}
