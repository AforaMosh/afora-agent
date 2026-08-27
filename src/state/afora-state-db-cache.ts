import path from "node:path";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  registerNodeSqliteKyselyQueryErrorHandler,
} from "../infra/kysely-sync.js";
import type { SqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import { createSqliteTerminalOpenLatch } from "../infra/sqlite-terminal-open-latch.js";
import { isSqliteCorruptionError } from "../infra/sqlite-transaction.js";
import { readAforaDatabaseQuarantine } from "./afora-quarantine-store.js";
import type { AforaStateDatabase } from "./afora-state-db-contract.js";
import { createAforaDatabaseVerificationError } from "./afora-state-db-maintenance.js";

const cachedDatabases = new Map<string, AforaStateDatabase>();
type AforaStateDatabaseLifecycleEvent =
  | { kind: "opened"; database: AforaStateDatabase }
  | { kind: "closed"; path: string }
  | { kind: "open-error"; path: string; error: unknown };
const databaseLifecycleListeners = new Set<(event: AforaStateDatabaseLifecycleEvent) => void>();

function notifyAforaStateDatabaseLifecycle(event: AforaStateDatabaseLifecycleEvent): void {
  for (const listener of databaseLifecycleListeners) {
    listener(event);
  }
}

export function registerAforaStateDatabaseLifecycleListener(
  listener: (event: AforaStateDatabaseLifecycleEvent) => void,
): () => void {
  databaseLifecycleListeners.add(listener);
  for (const database of cachedDatabases.values()) {
    if (database.db.isOpen) {
      listener({ kind: "opened", database });
    }
  }
  return () => databaseLifecycleListeners.delete(listener);
}

type AforaStateDatabaseCloseResult = {
  caught: boolean;
  errors: unknown[];
};

/** Close both physical-handle owners while retaining every cleanup failure. */
function closeAforaStateDatabaseHandle(
  database: AforaStateDatabase,
  options?: Parameters<AforaStateDatabase["walMaintenance"]["close"]>[0],
): AforaStateDatabaseCloseResult {
  let caught = false;
  const errors: unknown[] = [];
  try {
    database.walMaintenance.close(options);
  } catch (error) {
    caught = true;
    errors.push(error);
  }
  clearNodeSqliteKyselyCacheForDatabase(database.db);
  try {
    if (database.db.isOpen) {
      database.db.close();
    }
  } catch (error) {
    caught = true;
    errors.push(error);
  }
  return { caught, errors };
}

function evictCachedAforaStateDatabase(database: AforaStateDatabase): boolean {
  if (cachedDatabases.get(database.path) !== database) {
    return false;
  }
  // Remove ownership before cleanup. A poisoned native handle can reject close,
  // but it must never remain discoverable as the process-wide shared handle.
  cachedDatabases.delete(database.path);
  notifyAforaStateDatabaseLifecycle({ kind: "closed", path: database.path });
  // A poisoned cache owner is not the database lifecycle owner. PASSIVE avoids
  // waiting on readers or resetting recovery frames another connection needs.
  closeAforaStateDatabaseHandle(database, { checkpointMode: "PASSIVE" });
  return true;
}

/** Evict an exact cached shared-state owner after a proven corruption read. */
function evictAforaStateDatabaseAfterCorruption(
  database: AforaStateDatabase,
  error: unknown,
): boolean {
  return isSqliteCorruptionError(error) && evictCachedAforaStateDatabase(database);
}

const terminalOpenLatch = createSqliteTerminalOpenLatch({
  closeByPath: (pathname) => {
    const cached = cachedDatabases.get(pathname);
    if (cached) {
      evictCachedAforaStateDatabase(cached);
    }
  },
});

/** Publish a fully opened handle and bind query corruption to its exact cache owner. */
function publishAforaStateDatabase(database: AforaStateDatabase): AforaStateDatabase {
  const { db, path: pathname } = database;
  cachedDatabases.set(pathname, database);
  notifyAforaStateDatabaseLifecycle({ kind: "opened", database });
  registerNodeSqliteKyselyQueryErrorHandler(db, (error) => {
    // Write transactions own rollback and evict at their outer boundary.
    if (!db.isTransaction && isSqliteCorruptionError(error)) {
      evictCachedAforaStateDatabase(database);
    }
  });
  terminalOpenLatch.clear(pathname);
  return database;
}

function getCachedAforaStateDatabase(pathname: string): AforaStateDatabase | undefined {
  return cachedDatabases.get(path.resolve(pathname));
}

function getAforaStateDatabaseIfOpenAtPath(pathname: string): AforaStateDatabase | undefined {
  const cached = getCachedAforaStateDatabase(pathname);
  return cached?.db.isOpen ? cached : undefined;
}

/** Remove a closed cached owner while fresh-open access is held. */
function closeStaleCachedAforaStateDatabase(database: AforaStateDatabase): void {
  if (cachedDatabases.get(database.path) !== database) {
    return;
  }
  database.walMaintenance.close();
  clearNodeSqliteKyselyCacheForDatabase(database.db);
  cachedDatabases.delete(database.path);
  notifyAforaStateDatabaseLifecycle({ kind: "closed", path: database.path });
}

/** Latch background verification damage so later opens fail without rescanning. */
function recordAforaStateDatabaseOpenFailure(
  pathname: string,
  error: Error,
  generation?: SqliteFileGeneration,
): boolean {
  return terminalOpenLatch.record(pathname, error, generation);
}

/** Clear a terminal open failure after doctor rewrites the database file. */
function clearAforaStateDatabaseOpenFailure(pathname: string): void {
  terminalOpenLatch.clear(pathname);
}

/** Reject shared-state access after a process-local terminal failure. */
function assertAforaStateDatabaseOpenAllowed(pathname: string): void {
  const terminalFailure = terminalOpenLatch.get(pathname);
  if (terminalFailure) {
    throw terminalFailure;
  }
}

function recordAforaStateDatabaseLifecycleOpenError(pathname: string, error: unknown): void {
  notifyAforaStateDatabaseLifecycle({ kind: "open-error", path: path.resolve(pathname), error });
}

/** Reject a fresh shared-state open after known corruption until repair clears it. */
function assertAforaStateDatabaseFreshOpenAllowedAtPath(
  pathname: string,
  env: NodeJS.ProcessEnv,
): void {
  assertAforaStateDatabaseOpenAllowed(pathname);
  let quarantineFailure: Error | undefined;
  try {
    const quarantine = readAforaDatabaseQuarantine(pathname, { env });
    if (quarantine) {
      quarantineFailure = createAforaDatabaseVerificationError(
        "state",
        pathname,
        quarantine.reason,
      );
    }
  } catch {
    // A broken quarantine store must not brick every state read.
    // The process latch and daily verifier still cover known damage.
  }
  if (quarantineFailure) {
    throw quarantineFailure;
  }
}

/** Close one cached shared state database handle by exact pathname. */
function closeAforaStateDatabaseByPath(pathname: string): boolean {
  const resolvedPath = path.resolve(pathname);
  const database = cachedDatabases.get(resolvedPath);
  if (!database) {
    return false;
  }
  database.walMaintenance.close();
  if (database.db.isOpen) {
    database.db.close();
  }
  cachedDatabases.delete(resolvedPath);
  notifyAforaStateDatabaseLifecycle({ kind: "closed", path: resolvedPath });
  return true;
}

/** Close all cached shared state database handles. */
function closeAforaStateDatabase(
  options?: Parameters<AforaStateDatabase["walMaintenance"]["close"]>[0],
): void {
  for (const database of cachedDatabases.values()) {
    database.walMaintenance.close(options);
    if (database.db.isOpen) {
      database.db.close();
    }
    notifyAforaStateDatabaseLifecycle({ kind: "closed", path: database.path });
  }
  cachedDatabases.clear();
}

/** Test whether any cached shared state database handle is still open. */
function isAforaStateDatabaseOpen(): boolean {
  return Array.from(cachedDatabases.values()).some((database) => database.db.isOpen);
}

/** Close shared state handles and clear terminal failure latches for test isolation. */
function closeAforaStateDatabaseForTest(): void {
  closeAforaStateDatabase();
  terminalOpenLatch.clearAll();
}

/** Process-wide owner for cached shared-state handles and terminal open failures. */
export const aforaStateDatabaseCache = {
  assertAforaStateDatabaseFreshOpenAllowedAtPath,
  assertAforaStateDatabaseOpenAllowed,
  clearAforaStateDatabaseOpenFailure,
  closeAforaStateDatabase,
  closeAforaStateDatabaseByPath,
  closeAforaStateDatabaseForTest,
  closeAforaStateDatabaseHandle,
  closeStaleCachedAforaStateDatabase,
  evictCachedAforaStateDatabase,
  evictAforaStateDatabaseAfterCorruption,
  getCachedAforaStateDatabase,
  getAforaStateDatabaseIfOpenAtPath,
  isAforaStateDatabaseOpen,
  publishAforaStateDatabase,
  recordAforaStateDatabaseOpenFailure,
  recordAforaStateDatabaseLifecycleOpenError,
};
