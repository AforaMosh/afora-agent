// Afora agent database stores agent-scoped persisted runtime state.
import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { enableNodeSqliteKyselyStatementCache } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { SqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import { quarantineOrphanedSqliteSidecars } from "../infra/sqlite-files.js";
import {
  confirmSqliteFileIntegrity,
  isTerminalSqliteIntegrityError,
  type SqliteIntegrityConfirmation,
} from "../infra/sqlite-integrity.js";
import { createSqliteTerminalOpenLatch } from "../infra/sqlite-terminal-open-latch.js";
import {
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "../infra/sqlite-transaction.js";
import {
  configureSqliteConnectionPragmas,
  configureSqlitePreSchemaPragmas,
  registerSqliteCacheExitClose,
  type SqliteWalMaintenance,
} from "../infra/sqlite-wal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type {
  AforaAgentDatabase,
  AforaAgentDatabaseOptions,
  AforaAgentDatabaseOwnerInspection,
} from "./afora-agent-db-contract.js";
import {
  claimAforaAgentDatabaseLease,
  releaseAforaAgentDatabaseLease,
} from "./afora-agent-db-lease.js";
import { ensureAforaAgentDatabasePermissions } from "./afora-agent-db-permissions.js";
import {
  isSameAforaAgentDatabasePath,
  registerAforaAgentDatabase,
  unregisterAforaAgentDatabase,
} from "./afora-agent-db-registry.js";
import {
  assertCanonicalAgentMediaPersistenceVersion,
  assertExistingAgentSchemaOwner,
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./afora-agent-db-schema-helpers.js";
import {
  assertAgentDatabaseIntegrityBeforeMutation,
  ensureAforaAgentSchema,
} from "./afora-agent-db-schema.js";
import {
  isIncognitoAforaAgentSqlitePath,
  resolveAforaAgentSqlitePath,
} from "./afora-agent-db.paths.js";
import {
  clearAforaDatabaseQuarantine,
  readAforaDatabaseQuarantine,
} from "./afora-quarantine-store.js";
import {
  createAforaDatabaseVerificationError,
  AFORA_SQLITE_BUSY_TIMEOUT_MS,
  type AforaStateDatabaseOptions,
} from "./afora-state-db.js";

export {
  AFORA_AGENT_SCHEMA_VERSION,
  type AforaAgentDatabase,
  type AforaAgentDatabaseOptions,
  type AforaAgentDatabaseOwnerInspection,
  type AforaRegisteredAgentDatabase,
} from "./afora-agent-db-contract.js";
export {
  assertAforaAgentDatabaseForMaintenance,
  migrateAforaAgentDatabaseForMaintenance,
} from "./afora-agent-db-maintenance.js";
export { ensureAforaAgentDatabasePermissions } from "./afora-agent-db-permissions.js";
export {
  listAforaRegisteredAgentDatabases,
  readAforaAgentDatabaseRegistryToken,
} from "./afora-agent-db-registry.js";
export { ensureAforaAgentDatabaseSchema } from "./afora-agent-db-schema.js";
export {
  isIncognitoAforaAgentSqlitePath,
  resolveIncognitoAforaAgentSqlitePath,
  resolveAforaAgentSqlitePath,
} from "./afora-agent-db.paths.js";

/**
 * Per-agent SQLite database lifecycle and shared-state registration.
 *
 * Each opened agent database is schema-owned by one normalized agent id, cached
 * per pathname, protected with private file modes, and registered in the shared
 * Afora state database for discovery and maintenance.
 */
const AFORA_AGENT_DB_SLOW_OPEN_MS = 1_000;

export class IncognitoAgentDatabasePathCollisionError extends Error {
  readonly path: string;

  constructor(pathname: string) {
    super(
      `Incognito agent database sentinel path already exists: ${pathname}. This filename is reserved for in-memory incognito state; move or rename the file and retry.`,
    );
    this.name = "IncognitoAgentDatabasePathCollisionError";
    this.path = pathname;
  }
}
// Each WAL database consumes roughly three file descriptors, so the fixed cap
// satisfies the bounded-cache policy within a predictable FD budget, without config.
export const AFORA_AGENT_DB_OPEN_HANDLE_CAP = 64;
const agentDbLog = createSubsystemLogger("state/agent-db");
const cachedDatabases = new Map<string, AforaAgentDatabase>();
const incognitoDatabases = new WeakSet<AforaAgentDatabase>();
let incognitoDatabaseGeneration = 0;
const cachedDatabaseOpenFailures = new Map<string, unknown>();
const cachedDatabaseLeases = new Map<
  string,
  { leaseId: string; env: NodeJS.ProcessEnv | undefined }
>();
// External schema changes under a live process are unsupported: doctor migrations
// require restart, so successful owner/schema validation is process-stable.
const validatedAgentDatabasePaths = new Map<string, string>();
const terminalOpenLatch = createSqliteTerminalOpenLatch({
  closeByPath: closeAforaAgentDatabaseByPath,
});

/** Reconfirm an advisory worker failure on the live owner connection. */
export function confirmAforaAgentDatabaseIntegrity(
  pathname: string,
): SqliteIntegrityConfirmation {
  const resolvedPath = path.resolve(pathname);
  closeAforaAgentDatabaseByPath(resolvedPath);
  // Closing breaks process ownership of the pathname. A replacement must
  // revalidate and claim its schema before the path can become trusted again.
  validatedAgentDatabasePaths.delete(resolvedPath);
  return confirmSqliteFileIntegrity(resolvedPath, resolvedPath);
}

/** Latch background verification damage so later opens fail without rescanning. */
export function recordAforaAgentDatabaseOpenFailure(
  pathname: string,
  error: Error,
  generation?: SqliteFileGeneration,
): boolean {
  const recorded = terminalOpenLatch.record(pathname, error, generation);
  if (recorded) {
    // Quarantine revokes this process's trust because doctor may replace the file.
    validatedAgentDatabasePaths.delete(path.resolve(pathname));
  }
  return recorded;
}

/**
 * Clear a terminal open failure after doctor rewrites the database file.
 * Returns false when the persisted quarantine row survived; callers must
 * surface that, or the next open re-quarantines the repaired file.
 */
export function clearAforaAgentDatabaseOpenFailure(
  pathname: string,
  options: AforaStateDatabaseOptions = {},
): boolean {
  const resolvedPath = path.resolve(pathname);
  const cleared = clearAforaDatabaseQuarantine(resolvedPath, { env: options.env });
  terminalOpenLatch.clear(resolvedPath);
  return cleared;
}

function logSlowAgentDatabaseOpen(params: {
  agentId: string;
  elapsedMs: number;
  path: string;
}): void {
  if (params.elapsedMs < AFORA_AGENT_DB_SLOW_OPEN_MS) {
    return;
  }
  agentDbLog.warn("slow Afora agent database open", {
    agentId: params.agentId,
    elapsedMs: params.elapsedMs,
    path: params.path,
    thresholdMs: AFORA_AGENT_DB_SLOW_OPEN_MS,
  });
}

/** Read a database's durable role and agent owner without mutating it. */
export function inspectAforaAgentDatabaseOwner(
  pathname: string,
): AforaAgentDatabaseOwnerInspection {
  let db: DatabaseSync | undefined;
  try {
    // A handle this process holds was owner-validated when it was opened, and
    // ownership never changes afterwards. Answering from it keeps store
    // resolution off a fresh connection for every row it inspects.
    const opened = cachedDatabases.get(path.resolve(pathname));
    if (opened?.db.isOpen) {
      assertSupportedAgentSchemaVersion(opened.db, pathname);
      return { status: "owned", agentId: opened.agentId };
    }
    db = openNodeSqliteDatabase(pathname, { readOnly: true });
    db.exec(`PRAGMA busy_timeout = ${AFORA_SQLITE_BUSY_TIMEOUT_MS};`);
    assertSupportedAgentSchemaVersion(db, pathname);
    const existing = readExistingAgentSchemaMeta(db);
    if (!existing) {
      return { status: "unowned" };
    }
    if (existing.role !== "agent" || !existing.agentId) {
      return { status: "unreadable" };
    }
    return { status: "owned", agentId: normalizeAgentId(existing.agentId) };
  } catch {
    return { status: "unreadable" };
  } finally {
    db?.close();
  }
}

/** Open or return a cached per-agent database after schema and owner validation. */
export function openAforaAgentDatabase(
  options: AforaAgentDatabaseOptions,
): AforaAgentDatabase {
  const agentId = normalizeAgentId(options.agentId);
  const databaseOptions = { ...options, agentId };
  const pathname = resolveAforaAgentSqlitePath(databaseOptions);
  const incognito = isIncognitoAforaAgentSqlitePath(pathname, databaseOptions);
  // A live successful cache entry is authoritative; failed entries remain only for disposal.
  const cached = cachedDatabases.get(pathname);
  if (cached?.db.isOpen) {
    if (cachedDatabaseOpenFailures.has(pathname)) {
      throw cachedDatabaseOpenFailures.get(pathname);
    }
    if (cached.agentId !== agentId) {
      throw new Error(
        `Afora agent database ${pathname} is already open for agent ${cached.agentId}; requested agent ${agentId}.`,
      );
    }
    cachedDatabases.delete(pathname);
    cachedDatabases.set(pathname, cached);
    return cached;
  }
  if (incognito) {
    // The sentinel has no reachable durable owner, so doctor cannot safely migrate a collision.
    // Refuse operator-created state instead of silently shadowing it with volatile writes.
    if (existsSync(pathname)) {
      throw new IncognitoAgentDatabasePathCollisionError(pathname);
    }
    if (cached) {
      closeCachedAforaAgentDatabase(cached);
      cachedDatabases.delete(pathname);
      cachedDatabaseOpenFailures.delete(pathname);
    }
    // After the collision probe, this sentinel is only a cache key: SQLite opens :memory:,
    // and no directory, lease, registry row, WAL sidecar, or file write may be created.
    const db = openNodeSqliteDatabase(":memory:");
    configureSqlitePreSchemaPragmas(db, {
      busyTimeoutMs: AFORA_SQLITE_BUSY_TIMEOUT_MS,
    });
    const walMaintenance = configureSqliteConnectionPragmas(db, {
      busyTimeoutMs: AFORA_SQLITE_BUSY_TIMEOUT_MS,
      databaseLabel: `afora-agent-incognito:${agentId}`,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    ensureAforaAgentSchema(db, agentId, pathname);
    const database = { agentId, db, path: pathname, walMaintenance };
    incognitoDatabases.add(database);
    unregisterExitClose ??= registerSqliteCacheExitClose(closeAforaAgentDatabases);
    cachedDatabases.set(pathname, database);
    incognitoDatabaseGeneration += 1;
    return database;
  }
  quarantineOrphanedSqliteSidecars(pathname);
  // Latched paths are quarantined; every fresh open fails fast here until
  // doctor repairs the file and clears the latch plus the persisted row.
  const terminalFailure = terminalOpenLatch.get(pathname);
  if (terminalFailure) {
    throw terminalFailure;
  }
  let persistedFailure: Error | undefined;
  try {
    const quarantine = readAforaDatabaseQuarantine(pathname, { env: databaseOptions.env });
    if (quarantine) {
      persistedFailure = createAforaDatabaseVerificationError(
        "agent",
        pathname,
        quarantine.reason,
      );
    }
  } catch {
    // A broken quarantine store must not brick every agent open.
    // The process latch and daily verifier still cover known damage.
  }
  if (persistedFailure) {
    recordAforaAgentDatabaseOpenFailure(pathname, persistedFailure);
    throw persistedFailure;
  }
  if (cached) {
    // A closed handle can leave Kysely and WAL helpers cached; clear both before reopening.
    closeCachedAforaAgentDatabase(cached);
    cachedDatabases.delete(pathname);
    cachedDatabaseOpenFailures.delete(pathname);
  }
  const leaseId = claimAforaAgentDatabaseLease({
    agentId,
    path: pathname,
    ...(options.env ? { env: options.env } : {}),
  });
  const openStartedAt = Date.now();
  let openedDb: DatabaseSync | undefined;
  let openedDatabase: AforaAgentDatabase | undefined;
  let openedWalMaintenance: SqliteWalMaintenance | undefined;
  try {
    ensureAforaAgentDatabasePermissions(pathname, databaseOptions);
    // Free a slot before constructing the new handle: under real descriptor
    // pressure the 65th open would otherwise fail before eviction could run.
    evictLruAgentDatabaseHandles();
    const db = openNodeSqliteDatabase(pathname);
    enableNodeSqliteKyselyStatementCache(db);
    openedDb = db;
    // Eviction churn must avoid schema/registry busy waits on the event loop while
    // reconcile workers hold write transactions on these same agent databases.
    const isValidatedReopen = validatedAgentDatabasePaths.get(pathname) === agentId;
    const walMaintenance = (() => {
      let maintenance: AforaAgentDatabase["walMaintenance"] | undefined;
      try {
        db.exec(`PRAGMA busy_timeout = ${AFORA_SQLITE_BUSY_TIMEOUT_MS};`);
        if (!isValidatedReopen) {
          assertSupportedAgentSchemaVersion(db, pathname);
          assertExistingAgentSchemaOwner(readExistingAgentSchemaMeta(db), agentId, pathname);
        }
        // Integrity is not process-stable: the file can be damaged while evicted.
        // This guard is read-only (no busy waits), so every physical open pays it.
        assertAgentDatabaseIntegrityBeforeMutation(db, agentId, pathname);
        assertCanonicalAgentMediaPersistenceVersion(db, pathname);
        configureSqlitePreSchemaPragmas(db, {
          busyTimeoutMs: AFORA_SQLITE_BUSY_TIMEOUT_MS,
        });
        maintenance = configureSqliteConnectionPragmas(db, {
          busyTimeoutMs: AFORA_SQLITE_BUSY_TIMEOUT_MS,
          databaseLabel: `afora-agent:${agentId}`,
          databasePath: pathname,
          foreignKeys: true,
          synchronous: "NORMAL",
        });
        openedWalMaintenance = maintenance;
        if (!isValidatedReopen) {
          ensureAforaAgentSchema(db, agentId, pathname);
        }
        return maintenance;
      } catch (err) {
        maintenance?.close();
        db.close();
        if (
          err instanceof Error &&
          (err.name === "SqliteSchemaVersionError" || isTerminalSqliteIntegrityError(err))
        ) {
          recordAforaAgentDatabaseOpenFailure(pathname, err);
        }
        throw err;
      }
    })();
    ensureAforaAgentDatabasePermissions(pathname, databaseOptions);
    const database = { agentId, db, path: pathname, walMaintenance };
    openedDatabase = database;
    if (!isValidatedReopen) {
      registerAforaAgentDatabase({ agentId, path: pathname, env: options.env });
      validatedAgentDatabasePaths.set(pathname, agentId);
    }
    terminalOpenLatch.clear(pathname);
    // Safety net for processes that end without an orderly close: agent DBs have
    // no shutdown owner like the ACP/gateway state DB closes. Closing unregisters.
    unregisterExitClose ??= registerSqliteCacheExitClose(closeAforaAgentDatabases);
    logSlowAgentDatabaseOpen({
      agentId,
      elapsedMs: Date.now() - openStartedAt,
      path: pathname,
    });
    cachedDatabaseLeases.set(pathname, { leaseId, env: options.env });
    cachedDatabases.set(pathname, database);
    return database;
  } catch (error) {
    let closeError: unknown;
    if (openedDatabase) {
      try {
        closeCachedAforaAgentDatabase(openedDatabase);
      } catch (caught) {
        closeError = caught;
      }
    }
    if (openedDb?.isOpen) {
      validatedAgentDatabasePaths.delete(pathname);
      const retainedDatabase =
        openedDatabase ??
        ({
          agentId,
          db: openedDb,
          path: pathname,
          walMaintenance: openedWalMaintenance ?? {
            checkpoint: () => false,
            close: () => false,
          },
        } satisfies AforaAgentDatabase);
      // Failed opens remain disposal-owned but cannot become successful cache hits.
      cachedDatabases.set(pathname, retainedDatabase);
      cachedDatabaseLeases.set(pathname, { leaseId, env: options.env });
      cachedDatabaseOpenFailures.set(pathname, closeError ?? error);
      unregisterExitClose ??= registerSqliteCacheExitClose(closeAforaAgentDatabases);
    } else {
      releaseAforaAgentDatabaseLease(leaseId, { env: options.env });
    }
    throw closeError ?? error;
  }
}

/** Run a synchronous immediate transaction against an agent database. */
const postCommitPublications = new WeakMap<AforaAgentDatabase, Array<() => void>>();

/** Queue a non-throwing runtime publication on the outer database commit edge. */
export function deferAforaAgentPostCommitPublication(
  database: AforaAgentDatabase,
  publish: () => void,
): boolean {
  const publications = postCommitPublications.get(database);
  if (!publications) {
    return false;
  }
  publications.push(publish);
  return true;
}

export function runAforaAgentWriteTransaction<T>(
  operation: (database: AforaAgentDatabase) => T,
  options: AforaAgentDatabaseOptions,
  transactionOptions: Pick<
    SqliteTransactionOptions,
    "busyTimeoutMs" | "operationLabel" | "slowTransactionHoldMs"
  > = {},
): T {
  const database = openAforaAgentDatabase(options);
  const enteredNestedTransaction = database.db.isTransaction;
  const publications: Array<() => void> | undefined = enteredNestedTransaction
    ? postCommitPublications.get(database)
    : [];
  const publicationStart = publications?.length ?? 0;
  if (!enteredNestedTransaction && publications) {
    postCommitPublications.set(database, publications);
  }
  let result: T;
  try {
    result = runSqliteImmediateTransactionSync(
      database.db,
      () => {
        const operationResult = operation(database);
        if (!enteredNestedTransaction) {
          // Permission failure must roll back with the write. Repairing after
          // COMMIT could make callers retry a transaction already durable in SQLite.
          if (!incognitoDatabases.has(database)) {
            ensureAforaAgentDatabasePermissions(database.path, options);
          }
        }
        return operationResult;
      },
      {
        busyTimeoutMs: transactionOptions.busyTimeoutMs ?? AFORA_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: database.path,
        ...transactionOptions,
        operationLabel: transactionOptions.operationLabel ?? "agent.write",
      },
    );
  } catch (error) {
    publications?.splice(publicationStart);
    throw error;
  } finally {
    if (!enteredNestedTransaction && publications) {
      postCommitPublications.delete(database);
    }
  }
  if (!enteredNestedTransaction) {
    for (const publish of publications ?? []) {
      publish();
    }
  }
  return result;
}

let unregisterExitClose: (() => void) | null = null;

function closeCachedAforaAgentDatabase(
  database: AforaAgentDatabase,
  options: { eviction?: boolean } = {},
): void {
  // Eviction must stay cheap: PASSIVE skips waiting on concurrent readers,
  // whose drained TRUNCATE checkpoints blocked the event loop for seconds.
  database.walMaintenance.close(options.eviction ? { checkpointMode: "PASSIVE" } : undefined);
  if (database.db.isOpen) {
    database.db.close();
  }
  const lease = cachedDatabaseLeases.get(database.path);
  if (lease) {
    releaseAforaAgentDatabaseLease(lease.leaseId, { env: lease.env });
    cachedDatabaseLeases.delete(database.path);
  }
}

function evictLruAgentDatabaseHandles(): void {
  // Callers re-fetch handles from this cache at each operation entry and use
  // them within one synchronous section, so eviction can never close a handle
  // mid-use; a handle retained across an eviction-triggering open goes stale.
  while (cachedDatabases.size >= AFORA_AGENT_DB_OPEN_HANDLE_CAP) {
    let evicted = false;
    for (const [pathname, database] of cachedDatabases) {
      // A synchronous transaction owns its handle through COMMIT or ROLLBACK;
      // closing it here would violate the transaction commit-section contract.
      if (database.db.isTransaction) {
        continue;
      }
      // Classification is recorded at open; re-deriving the sentinel path here
      // would consult process.env and can misclassify explicit-env opens,
      // letting LRU eviction destroy a live in-memory incognito session.
      if (incognitoDatabases.has(database)) {
        continue;
      }
      // Registry rows are durable discovery metadata; only explicit disposal
      // unregisters them, while eviction closes this process-local handle.
      closeCachedAforaAgentDatabase(database, { eviction: true });
      cachedDatabases.delete(pathname);
      cachedDatabaseOpenFailures.delete(pathname);
      agentDbLog.debug("evicted Afora agent database handle", {
        agentId: database.agentId,
        openHandles: cachedDatabases.size,
        path: pathname,
      });
      evicted = true;
      break;
    }
    if (!evicted) {
      // Every handle is mid-transaction: sync commit sections bound concurrent
      // transactions at call-nesting depth, so this stays a pathological safety
      // valve; exceeding the cap beats failing an unrelated agent's open.
      agentDbLog.warn(
        "agent database handle cap exceeded; all cached handles are in transactions",
        {
          cap: AFORA_AGENT_DB_OPEN_HANDLE_CAP,
          openHandles: cachedDatabases.size,
        },
      );
      return;
    }
  }
}

/** Return whether the exact cached agent database pathname is still open. */
export function isAforaAgentDatabaseOpen(pathname: string): boolean {
  const database = cachedDatabases.get(path.resolve(pathname));
  return database?.db.isOpen === true;
}

/** Return the matching live cache entry without materializing a database. */
export function getAforaAgentDatabaseIfOpen(
  options: AforaAgentDatabaseOptions,
): AforaAgentDatabase | undefined {
  const agentId = normalizeAgentId(options.agentId);
  const pathname = resolveAforaAgentSqlitePath({ ...options, agentId });
  const database = cachedDatabases.get(pathname);
  if (!database?.db.isOpen) {
    return undefined;
  }
  if (cachedDatabaseOpenFailures.has(pathname)) {
    throw cachedDatabaseOpenFailures.get(pathname);
  }
  if (database.agentId !== agentId) {
    throw new Error(
      `Afora agent database ${pathname} is already open for agent ${database.agentId}; requested agent ${agentId}.`,
    );
  }
  return database;
}

/** Lists process-held incognito databases without opening new sentinel handles. */
export function listOpenIncognitoAgentDatabases(): Array<{ agentId: string; storePath: string }> {
  return [...cachedDatabases.values()]
    .filter((database) => database.db.isOpen && incognitoDatabases.has(database))
    .map((database) => ({ agentId: database.agentId, storePath: database.path }))
    .toSorted(
      (left, right) =>
        left.agentId.localeCompare(right.agentId) || left.storePath.localeCompare(right.storePath),
    );
}

/** Return the generation of process-held incognito database membership. */
export function readOpenIncognitoAgentDatabaseGeneration(): number {
  return incognitoDatabaseGeneration;
}

/** Returns whether this exact process-held database is incognito/in-memory. */
export function isIncognitoAforaAgentDatabase(database: AforaAgentDatabase): boolean {
  return incognitoDatabases.has(database);
}

/** List process-held agent databases without opening or inspecting fixture state. */
export function listAforaAgentDatabasesForTest(): Array<{ agentId: string; path: string }> {
  return [...cachedDatabases.values()]
    .filter((database) => database.db.isOpen)
    .map((database) => ({ agentId: database.agentId, path: database.path }))
    .toSorted(
      (left, right) =>
        left.agentId.localeCompare(right.agentId) || left.path.localeCompare(right.path),
    );
}

/** Close one cached agent database identified by its exact resolved pathname. */
export function closeAforaAgentDatabaseByPath(pathname: string): boolean {
  // Cache keys are lexical resolved paths. Do not realpath aliases here: a
  // symlink swap must never redirect cleanup onto a different cached database.
  const resolvedPath = path.resolve(pathname);
  const database = cachedDatabases.get(resolvedPath);
  if (!database) {
    return false;
  }
  const incognito = incognitoDatabases.has(database);
  closeCachedAforaAgentDatabase(database);
  cachedDatabases.delete(resolvedPath);
  cachedDatabaseOpenFailures.delete(resolvedPath);
  if (incognito) {
    incognitoDatabaseGeneration += 1;
  }
  if (cachedDatabases.size === 0) {
    unregisterExitClose?.();
    unregisterExitClose = null;
  }
  return true;
}

/** Close and unregister one unambiguous transient agent database by filesystem identity. */
export function disposeAforaAgentDatabaseByPath(
  pathname: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): boolean {
  const resolvedPath = path.resolve(pathname);
  // Disposal can be followed by file deletion or recreation, so revalidate next open.
  validatedAgentDatabasePaths.delete(resolvedPath);
  const matchingDatabases = [...cachedDatabases.values()].filter((candidate) =>
    isSameAforaAgentDatabasePath(candidate.path, resolvedPath),
  );
  if (matchingDatabases.length > 1) {
    return false;
  }
  const database = matchingDatabases[0];
  if (database && incognitoDatabases.has(database)) {
    return closeAforaAgentDatabaseByPath(database.path);
  }
  if (!database) {
    return false;
  }
  try {
    unregisterAforaAgentDatabase({
      agentId: database.agentId,
      path: database.path,
      ...(options.env ? { env: options.env } : {}),
    });
  } finally {
    // Secret-bearing transient DBs must close even when registry maintenance
    // fails; Windows otherwise cannot remove the file during caller cleanup.
    closeAforaAgentDatabaseByPath(database.path);
  }
  return true;
}

/** Close all cached agent database handles. */
export function closeAforaAgentDatabases(): void {
  unregisterExitClose?.();
  unregisterExitClose = null;
  const removedIncognito = [...cachedDatabases.values()].some(
    (database) => database.db.isOpen && incognitoDatabases.has(database),
  );
  for (const database of cachedDatabases.values()) {
    closeCachedAforaAgentDatabase(database);
  }
  cachedDatabases.clear();
  cachedDatabaseOpenFailures.clear();
  if (removedIncognito) {
    incognitoDatabaseGeneration += 1;
  }
}

/** Close cached agent handles and clear terminal failure latches for test isolation. */
export function closeAforaAgentDatabasesForTest(): void {
  closeAforaAgentDatabases();
  validatedAgentDatabasePaths.clear();
  terminalOpenLatch.clearAll();
}
