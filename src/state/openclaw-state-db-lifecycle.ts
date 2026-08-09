import path from "node:path";
import type { SqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import { createSqliteTerminalOpenLatch } from "../infra/sqlite-terminal-open-latch.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import {
  resolveOpenClawStateSqliteIdentityPath,
  resolveOpenClawStateSqlitePath,
} from "./openclaw-state-db.paths.js";

const MAX_CACHED_DATABASE_ALIASES = 256;

export function createOpenClawStateDatabaseLifecycle() {
  const databases = new Map<string, OpenClawStateDatabase>();
  const aliases = new Map<string, string>();

  function forgetAliases(identityPath: string): void {
    for (const [requestedPath, cachedIdentityPath] of aliases) {
      if (cachedIdentityPath === identityPath) {
        aliases.delete(requestedPath);
      }
    }
  }

  function rememberAlias(requestedPath: string, identityPath: string): void {
    if (requestedPath === identityPath) {
      return;
    }
    aliases.delete(requestedPath);
    aliases.set(requestedPath, identityPath);
    while (aliases.size > MAX_CACHED_DATABASE_ALIASES) {
      const oldest = aliases.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      aliases.delete(oldest);
    }
  }

  function resolveIdentityPath(options: OpenClawStateDatabaseOptions): string {
    const requestedPath = path.resolve(
      options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env),
    );
    if (databases.has(requestedPath)) {
      return requestedPath;
    }
    const cachedIdentityPath = aliases.get(requestedPath);
    if (cachedIdentityPath && databases.has(cachedIdentityPath)) {
      return cachedIdentityPath;
    }
    if (cachedIdentityPath) {
      aliases.delete(requestedPath);
    }
    const identityPath = resolveOpenClawStateSqliteIdentityPath({ path: requestedPath });
    rememberAlias(requestedPath, identityPath);
    return identityPath;
  }

  function evict(database: OpenClawStateDatabase): boolean {
    if (databases.get(database.path) !== database) {
      return false;
    }
    // Remove ownership before cleanup. A poisoned native handle can reject close,
    // but it must never remain discoverable as the process-wide shared handle.
    databases.delete(database.path);
    forgetAliases(database.path);
    try {
      database.walMaintenance.close();
    } catch {
      // Eviction is best-effort; the triggering database error remains authoritative.
    }
    try {
      if (database.db.isOpen) {
        database.db.close();
      }
    } catch {
      // A failed native close must not re-register the poisoned handle.
    }
    return true;
  }

  const terminalOpenLatch = createSqliteTerminalOpenLatch({
    closeByPath: (pathname) => {
      const database = databases.get(pathname);
      if (database) {
        evict(database);
      }
    },
  });

  function closeAll(): void {
    for (const database of databases.values()) {
      database.walMaintenance.close();
      if (database.db.isOpen) {
        database.db.close();
      }
    }
    databases.clear();
    aliases.clear();
  }

  return {
    clearFailure(pathname: string): void {
      terminalOpenLatch.clear(resolveIdentityPath({ path: pathname }));
    },
    closeAll,
    closeByPath(pathname: string): boolean {
      const identityPath = resolveIdentityPath({ path: pathname });
      const database = databases.get(identityPath);
      if (!database) {
        return false;
      }
      database.walMaintenance.close();
      if (database.db.isOpen) {
        database.db.close();
      }
      databases.delete(identityPath);
      forgetAliases(identityPath);
      return true;
    },
    evict,
    get(identityPath: string): OpenClawStateDatabase | undefined {
      return databases.get(identityPath);
    },
    getFailure(identityPath: string): Error | undefined {
      return terminalOpenLatch.get(identityPath);
    },
    isOpen(): boolean {
      return Array.from(databases.values()).some((database) => database.db.isOpen);
    },
    recordFailure(pathname: string, error: Error, generation?: SqliteFileGeneration): boolean {
      return terminalOpenLatch.record(resolveIdentityPath({ path: pathname }), error, generation);
    },
    resetForTest(): void {
      closeAll();
      terminalOpenLatch.clearAll();
    },
    resolveIdentityPath,
    set(database: OpenClawStateDatabase): void {
      databases.set(database.path, database);
    },
  };
}
