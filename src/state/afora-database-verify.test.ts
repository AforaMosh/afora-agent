import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { readStableSqliteFileGeneration } from "../infra/sqlite-file-generation.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import {
  clearAforaAgentDatabaseOpenFailure,
  closeAforaAgentDatabaseByPath,
  closeAforaAgentDatabasesForTest,
  openAforaAgentDatabase,
  recordAforaAgentDatabaseOpenFailure,
} from "./afora-agent-db.js";
import {
  applyAforaDatabaseVerificationResults,
  runDatabaseVerifyWorker,
} from "./afora-database-verify.impl.js";
import {
  type AforaDatabaseVerifyResult,
  type AforaDatabaseVerifyTarget,
  verifyAforaDatabases,
} from "./afora-database-verify.worker.js";
import {
  clearAforaDatabaseQuarantine,
  readAforaDatabaseQuarantine,
  recordAforaDatabaseQuarantine,
} from "./afora-quarantine-store.js";
import {
  closeAforaStateDatabaseForTest,
  openAforaStateDatabase,
  recordAforaStateDatabaseOpenFailure,
  repairAforaStateDatabaseSchema,
} from "./afora-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    try {
      closeAforaAgentDatabasesForTest();
    } finally {
      try {
        closeAforaStateDatabaseForTest();
      } finally {
        cleanup();
      }
    }
  });
});

async function captureDatabaseVerifyWorkerSendFailure(failure: unknown): Promise<Error> {
  return await runDatabaseVerifyWorker([], {
    onWorker: (worker) => {
      if (!worker) {
        return;
      }
      worker.send = ((...args: unknown[]) => {
        const callback = args.at(-1);
        if (typeof callback === "function") {
          callback(failure);
        }
        return true;
      }) as ChildProcess["send"];
    },
  }).then(
    () => {
      throw new Error("expected database verification worker failure");
    },
    (rejection: unknown) => rejection as Error,
  );
}

describe("database verification error coercion", () => {
  it("preserves structured send failures across the database-worker boundary", async () => {
    const failure = { code: "SQLITE_IOERR", database: "state" };

    const error = await captureDatabaseVerifyWorkerSendFailure(failure);

    expect(error).toMatchObject({ message: "[object Object]", code: "SQLITE_IOERR" });
    expect(error.cause).toBe(failure);
  });
});

function createUnsafeIndexDrift(databasePath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE unsafe_index_records (
        id INTEGER PRIMARY KEY,
        indexed_value TEXT NOT NULL,
        alternate_value TEXT NOT NULL
      );
      CREATE INDEX unsafe_index_records_value ON unsafe_index_records(indexed_value);
      INSERT INTO unsafe_index_records (indexed_value, alternate_value)
      VALUES ('alpha', 'zeta'), ('beta', 'eta'), ('gamma', 'theta');
    `);
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX unsafe_index_records_value ON unsafe_index_records(alternate_value)' WHERE name = 'unsafe_index_records_value'",
      )
      .run();
    const schemaVersion = readSqliteNumberPragma(database, "schema_version");
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

function repairUnsafeIndexDrift(databasePath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX unsafe_index_records_value ON unsafe_index_records(indexed_value)' WHERE name = 'unsafe_index_records_value'",
      )
      .run();
    const schemaVersion = readSqliteNumberPragma(database, "schema_version");
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

async function copyHealthyDatabase(sourcePath: string, targetPath: string): Promise<void> {
  const sqlite = requireNodeSqlite();
  const source = new sqlite.DatabaseSync(sourcePath, { readOnly: true });
  try {
    await sqlite.backup(source, targetPath);
  } finally {
    source.close();
  }
}

function quarantineStorePath(stateDir: string): string {
  return path.join(stateDir, "state", "afora-quarantine.sqlite");
}

function terminalVerificationResult(pathname: string): AforaDatabaseVerifyResult {
  return {
    path: pathname,
    ok: false,
    error: "prepared terminal integrity failure",
    terminal: true,
  };
}

function preparedVerificationResults(
  targets: readonly AforaDatabaseVerifyTarget[],
): AforaDatabaseVerifyResult[] {
  return targets.map((target) => terminalVerificationResult(target.path));
}

function readLinuxPosixLocksForPath(pathname: string): string[] {
  if (process.platform !== "linux") {
    return [];
  }
  const inode = fs.statSync(pathname, { bigint: true }).ino;
  const lockInode = new RegExp(`\\b[0-9a-f]+:[0-9a-f]+:${inode}\\b`, "u");
  return fs
    .readFileSync("/proc/locks", "utf8")
    .split("\n")
    .filter((line) => line.includes(" POSIX ") && lockInode.test(line));
}

describe("Afora database integrity verifier", () => {
  it.skipIf(process.platform === "win32")(
    "preserves live WAL ownership while snapshotting an open database",
    async () => {
      const stateDir = tempDirs.make("afora-database-verify-live-locks-");
      const env = { AFORA_STATE_DIR: stateDir };
      const agent = openAforaAgentDatabase({ agentId: "worker-1", env });
      agent.db
        .prepare(
          "INSERT INTO auth_profile_state (state_key, state_json, updated_at) VALUES (?, ?, ?)",
        )
        .run("verifier-lock-owner", JSON.stringify({ preserved: true }), 1);
      const walBefore = fs.statSync(`${agent.path}-wal`);
      const shmBefore = fs.statSync(`${agent.path}-shm`);
      const baseLocksBefore = readLinuxPosixLocksForPath(agent.path);
      if (process.platform === "linux") {
        expect(baseLocksBefore.length).toBeGreaterThan(0);
      }
      const targets: AforaDatabaseVerifyTarget[] = [
        { kind: "agent", label: "Afora agent database worker-1", path: agent.path },
      ];

      await expect(runDatabaseVerifyWorker(targets)).resolves.toEqual([
        { path: agent.path, ok: true },
      ]);
      if (process.platform === "linux") {
        // SQLite 3.51 can preserve visible WAL files after a lock is lost, so
        // assert the kernel lock itself rather than relying on that symptom.
        expect(readLinuxPosixLocksForPath(agent.path).length).toBeGreaterThan(0);
      }
      const reader = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            import { DatabaseSync } from "node:sqlite";
            const database = new DatabaseSync(process.env.AFORA_VERIFY_TEST_PATH);
            database.prepare("PRAGMA schema_version;").get();
            database.close();
          `,
        ],
        {
          env: { ...process.env, AFORA_VERIFY_TEST_PATH: agent.path },
          encoding: "utf8",
        },
      );

      expect(reader.stderr).toBe("");
      expect(reader.status).toBe(0);
      expect(fs.statSync(`${agent.path}-wal`).ino).toBe(walBefore.ino);
      expect(fs.statSync(`${agent.path}-shm`).ino).toBe(shmBefore.ino);
      expect(() =>
        agent.db
          .prepare("UPDATE auth_profile_state SET updated_at = ? WHERE state_key = ?")
          .run(2, "verifier-lock-owner"),
      ).not.toThrow();
    },
  );

  it("detects corruption off-thread, quarantines it, and latches later opens", async () => {
    const stateDir = tempDirs.make("afora-database-verify-");
    const env = { AFORA_STATE_DIR: stateDir };
    const agentPath = openAforaAgentDatabase({ agentId: "worker-1", env }).path;
    createUnsafeIndexDrift(agentPath);
    const targets: AforaDatabaseVerifyTarget[] = [
      { kind: "agent", label: "Afora agent database worker-1", path: agentPath },
    ];

    const results = await runDatabaseVerifyWorker(targets);
    expect(results).toEqual([
      {
        path: agentPath,
        ok: false,
        error: expect.stringMatching(/missing from index unsafe_index_records_value/iu),
        terminal: true,
      },
    ]);

    applyAforaDatabaseVerificationResults({
      env,
      results,
      targets,
    });
    const quarantine = readAforaDatabaseQuarantine(agentPath, { env });
    expect(quarantine).toEqual({
      kind: "agent",
      quarantinedAt: expect.any(Number),
      reason: expect.stringMatching(/missing from index unsafe_index_records_value/iu),
    });

    expect(() => openAforaAgentDatabase({ agentId: "worker-1", env })).toThrow(
      expect.objectContaining({ name: "SqliteIntegrityError" }),
    );

    closeAforaAgentDatabasesForTest();
    closeAforaStateDatabaseForTest();
    expect(() => openAforaAgentDatabase({ agentId: "worker-1", env })).toThrow(
      expect.objectContaining({
        name: "SqliteIntegrityError",
        message: expect.stringContaining(quarantine?.reason ?? ""),
      }),
    );
    clearAforaAgentDatabaseOpenFailure(agentPath, { env });
    expect(() => openAforaAgentDatabase({ agentId: "worker-1", env })).toThrow(
      expect.objectContaining({ name: "SqliteIntegrityError" }),
    );
  });

  it("does not quarantine a healthy database that replaced the verified file", async () => {
    const stateDir = tempDirs.make("afora-database-verify-replacement-");
    const env = { AFORA_STATE_DIR: stateDir };
    const agentPath = openAforaAgentDatabase({ agentId: "worker-1", env }).path;
    closeAforaAgentDatabasesForTest();
    closeAforaStateDatabaseForTest();

    const healthyReplacementPath = `${agentPath}.healthy`;
    const corruptArchivePath = `${agentPath}.corrupt`;
    fs.copyFileSync(agentPath, healthyReplacementPath);
    createUnsafeIndexDrift(agentPath);
    const targets: AforaDatabaseVerifyTarget[] = [
      { kind: "agent", label: "Afora agent database worker-1", path: agentPath },
    ];
    const results = preparedVerificationResults(targets);

    fs.renameSync(agentPath, corruptArchivePath);
    fs.renameSync(healthyReplacementPath, agentPath);
    applyAforaDatabaseVerificationResults({ env, results, targets });

    expect(readAforaDatabaseQuarantine(agentPath, { env })).toBeUndefined();
    expect(openAforaAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "does not quarantine a healthy replacement while the corrupt agent inode is cached",
    async () => {
      const stateDir = tempDirs.make("afora-database-verify-live-agent-replace-");
      const env = { AFORA_STATE_DIR: stateDir };
      const agent = openAforaAgentDatabase({ agentId: "worker-1", env });
      const healthyReplacementPath = `${agent.path}.healthy`;
      const corruptArchivePath = `${agent.path}.corrupt`;
      await copyHealthyDatabase(agent.path, healthyReplacementPath);
      createUnsafeIndexDrift(agent.path);
      const targets: AforaDatabaseVerifyTarget[] = [
        { kind: "agent", label: "Afora agent database worker-1", path: agent.path },
      ];
      const results = preparedVerificationResults(targets);

      fs.renameSync(agent.path, corruptArchivePath);
      fs.renameSync(healthyReplacementPath, agent.path);
      applyAforaDatabaseVerificationResults({ env, results, targets });

      expect(agent.db.isOpen).toBe(false);
      expect(readAforaDatabaseQuarantine(agent.path, { env })).toBeUndefined();
      expect(openAforaAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not quarantine a healthy replacement while the corrupt state inode is cached",
    async () => {
      const stateDir = tempDirs.make("afora-database-verify-live-state-replace-");
      const env = { AFORA_STATE_DIR: stateDir };
      const state = openAforaStateDatabase({ env });
      const healthyReplacementPath = `${state.path}.healthy`;
      const corruptArchivePath = `${state.path}.corrupt`;
      await copyHealthyDatabase(state.path, healthyReplacementPath);
      createUnsafeIndexDrift(state.path);
      const targets: AforaDatabaseVerifyTarget[] = [
        { kind: "state", label: "Afora state database", path: state.path },
      ];
      const results = preparedVerificationResults(targets);

      fs.renameSync(state.path, corruptArchivePath);
      fs.renameSync(healthyReplacementPath, state.path);
      applyAforaDatabaseVerificationResults({ env, results, targets });

      expect(state.db.isOpen).toBe(false);
      expect(readAforaDatabaseQuarantine(state.path, { env })).toBeUndefined();
      expect(openAforaStateDatabase({ env }).db.isOpen).toBe(true);
    },
  );

  it("reconfirms and quarantines a corrupt closed database", async () => {
    const stateDir = tempDirs.make("afora-database-verify-closed-");
    const env = { AFORA_STATE_DIR: stateDir };
    const agentPath = openAforaAgentDatabase({ agentId: "worker-1", env }).path;
    closeAforaAgentDatabasesForTest();
    closeAforaStateDatabaseForTest();
    createUnsafeIndexDrift(agentPath);
    const targets: AforaDatabaseVerifyTarget[] = [
      { kind: "agent", label: "Afora agent database worker-1", path: agentPath },
    ];
    const results = preparedVerificationResults(targets);

    applyAforaDatabaseVerificationResults({ env, results, targets });

    expect(readAforaDatabaseQuarantine(agentPath, { env })?.reason).toMatch(
      /missing from index unsafe_index_records_value/iu,
    );
    expect(() => openAforaAgentDatabase({ agentId: "worker-1", env })).toThrow(
      expect.objectContaining({ name: "SqliteIntegrityError" }),
    );
  });

  it("does not quarantine a repaired database after same-inode mutation", async () => {
    const stateDir = tempDirs.make("afora-database-verify-repair-race-");
    const env = { AFORA_STATE_DIR: stateDir };
    const agentPath = openAforaAgentDatabase({ agentId: "worker-1", env }).path;
    closeAforaAgentDatabasesForTest();
    closeAforaStateDatabaseForTest();
    createUnsafeIndexDrift(agentPath);
    const targets: AforaDatabaseVerifyTarget[] = [
      { kind: "agent", label: "Afora agent database worker-1", path: agentPath },
    ];
    const results = preparedVerificationResults(targets);

    repairUnsafeIndexDrift(agentPath);
    await expect(verifyAforaDatabases(targets)).resolves.toEqual([
      expect.objectContaining({ ok: true }),
    ]);
    applyAforaDatabaseVerificationResults({ env, results, targets });

    expect(readAforaDatabaseQuarantine(agentPath, { env })).toBeUndefined();
    expect(openAforaAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("rejects stale terminal results after draining healthy owners", () => {
    const stateDir = tempDirs.make("afora-database-verify-live-stale-");
    const env = { AFORA_STATE_DIR: stateDir };
    const state = openAforaStateDatabase({ env });
    const agent = openAforaAgentDatabase({ agentId: "worker-1", env });
    const targets: AforaDatabaseVerifyTarget[] = [
      { kind: "state", label: "Afora state database", path: state.path },
      { kind: "agent", label: "Afora agent database worker-1", path: agent.path },
    ];

    applyAforaDatabaseVerificationResults({
      env,
      results: targets.map((target) => ({
        path: target.path,
        ok: false,
        error: "stale terminal result",
        terminal: true,
      })),
      targets,
    });

    expect(readAforaDatabaseQuarantine(state.path, { env })).toBeUndefined();
    expect(readAforaDatabaseQuarantine(agent.path, { env })).toBeUndefined();
    expect(state.db.isOpen).toBe(false);
    expect(agent.db.isOpen).toBe(false);
    expect(openAforaStateDatabase({ env }).db.isOpen).toBe(true);
    expect(openAforaAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("revalidates agent schema ownership after confirmation drains a pathname", () => {
    const stateDir = tempDirs.make("afora-database-verify-agent-revalidate-");
    const env = { AFORA_STATE_DIR: stateDir };
    const agent = openAforaAgentDatabase({ agentId: "worker-1", env });
    const replacementPath = `${agent.path}.replacement`;
    const { DatabaseSync } = requireNodeSqlite();
    const replacement = new DatabaseSync(replacementPath);
    replacement.close();
    expect(closeAforaAgentDatabaseByPath(agent.path)).toBe(true);
    fs.rmSync(agent.path);
    fs.renameSync(replacementPath, agent.path);
    const targets: AforaDatabaseVerifyTarget[] = [
      { kind: "agent", label: "Afora agent database worker-1", path: agent.path },
    ];

    applyAforaDatabaseVerificationResults({
      env,
      results: [{ path: agent.path, ok: false, error: "stale terminal result", terminal: true }],
      targets,
    });

    const reopened = openAforaAgentDatabase({ agentId: "worker-1", env });
    expect(
      reopened.db
        .prepare("SELECT role, agent_id FROM schema_meta WHERE meta_key = 'primary'")
        .get(),
    ).toEqual({ role: "agent", agent_id: "worker-1" });
  });

  it("expires a generation-bound process latch after the database changes", () => {
    const stateDir = tempDirs.make("afora-database-verify-latch-generation-");
    const env = { AFORA_STATE_DIR: stateDir };
    const agentPath = openAforaAgentDatabase({ agentId: "worker-1", env }).path;
    closeAforaAgentDatabasesForTest();
    const generation = readStableSqliteFileGeneration(agentPath);
    const error = new Error("verified corrupt generation");
    error.name = "SqliteIntegrityError";

    expect(recordAforaAgentDatabaseOpenFailure(agentPath, error, generation)).toBe(true);
    const { DatabaseSync } = requireNodeSqlite();
    const changed = new DatabaseSync(agentPath);
    try {
      changed.exec("CREATE TABLE generation_change (id INTEGER PRIMARY KEY) STRICT;");
    } finally {
      changed.close();
    }

    expect(openAforaAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("reports an uncleared quarantine row instead of claiming repair success", () => {
    const stateDir = tempDirs.make("afora-database-verify-clear-failure-");
    const env = { AFORA_STATE_DIR: stateDir };
    const agentPath = openAforaAgentDatabase({ agentId: "worker-1", env }).path;
    openAforaStateDatabase({ env });
    closeAforaAgentDatabasesForTest();
    closeAforaStateDatabaseForTest();
    expect(
      recordAforaDatabaseQuarantine({
        env,
        kind: "agent",
        path: agentPath,
        reason: "corrupt index",
      }),
    ).toBe(true);
    const error = new Error("corrupt index");
    error.name = "SqliteIntegrityError";
    recordAforaAgentDatabaseOpenFailure(agentPath, error);
    closeAforaStateDatabaseForTest();

    const storePath = quarantineStorePath(stateDir);
    // A read-only quarantine store cannot drop the row; the clear must say so
    // instead of letting doctor report success while the next open still refuses.
    fs.chmodSync(storePath, 0o444);
    try {
      expect(clearAforaAgentDatabaseOpenFailure(agentPath, { env })).toBe(false);
      expect(
        recordAforaDatabaseQuarantine({
          env,
          kind: "agent",
          path: agentPath,
          reason: "new reason",
        }),
      ).toBe(false);
    } finally {
      fs.chmodSync(storePath, 0o600);
    }
    expect(clearAforaAgentDatabaseOpenFailure(agentPath, { env })).toBe(true);
    expect(openAforaAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("keeps healthy opens on the missing-store fast path", () => {
    const stateDir = tempDirs.make("afora-database-verify-clean-");
    const env = { AFORA_STATE_DIR: stateDir };

    openAforaStateDatabase({ env });
    openAforaAgentDatabase({ agentId: "worker-1", env });

    expect(fs.existsSync(quarantineStorePath(stateDir))).toBe(false);
  });

  it("records and clears dedicated quarantine rows with rollback journaling", () => {
    const stateDir = tempDirs.make("afora-database-verify-store-");
    const env = { AFORA_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agent.sqlite");
    const storePath = quarantineStorePath(stateDir);

    expect(clearAforaDatabaseQuarantine(databasePath, { env })).toBe(true);
    expect(
      recordAforaDatabaseQuarantine({
        env,
        kind: "agent",
        path: databasePath,
        reason: "corrupt index",
      }),
    ).toBe(true);
    expect(readAforaDatabaseQuarantine(databasePath, { env })).toEqual({
      kind: "agent",
      quarantinedAt: expect.any(Number),
      reason: "corrupt index",
    });

    const { DatabaseSync } = requireNodeSqlite();
    const raw = new DatabaseSync(storePath, { readOnly: true });
    try {
      expect(raw.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      expect(readSqliteNumberPragma(raw, "synchronous")).toBe(2);
      expect(readSqliteNumberPragma(raw, "user_version")).toBe(2);
    } finally {
      raw.close();
    }
    if (process.platform !== "win32") {
      expect(fs.statSync(path.dirname(storePath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(storePath).mode & 0o777).toBe(0o600);
    }
    expect(clearAforaDatabaseQuarantine(databasePath, { env })).toBe(true);
    expect(clearAforaDatabaseQuarantine(databasePath, { env })).toBe(true);
    expect(readAforaDatabaseQuarantine(databasePath, { env })).toBeUndefined();
  });

  it("expires a persisted quarantine when the verified database generation changes", () => {
    const stateDir = tempDirs.make("afora-database-verify-store-generation-");
    const env = { AFORA_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agent.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("CREATE TABLE records (id INTEGER PRIMARY KEY) STRICT;");
    } finally {
      database.close();
    }
    const generation = readStableSqliteFileGeneration(databasePath);

    expect(
      recordAforaDatabaseQuarantine({
        env,
        generation,
        kind: "agent",
        path: databasePath,
        reason: "corrupt generation",
      }),
    ).toBe(true);
    expect(readAforaDatabaseQuarantine(databasePath, { env })?.reason).toBe(
      "corrupt generation",
    );

    const changed = new DatabaseSync(databasePath);
    try {
      changed.exec("INSERT INTO records DEFAULT VALUES;");
    } finally {
      changed.close();
    }
    expect(readAforaDatabaseQuarantine(databasePath, { env })).toBeUndefined();
  });

  it("reads schema-v1 quarantine rows and migrates them on the next write", () => {
    const stateDir = tempDirs.make("afora-database-verify-store-v1-");
    const env = { AFORA_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agent.sqlite");
    const storePath = quarantineStorePath(stateDir);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(storePath);
    try {
      legacy.exec(`
        CREATE TABLE quarantined_databases (
          path TEXT NOT NULL PRIMARY KEY,
          kind TEXT NOT NULL,
          reason TEXT NOT NULL,
          quarantined_at INTEGER NOT NULL,
          writer_app_version TEXT
        ) STRICT;
        PRAGMA user_version = 1;
      `);
      legacy
        .prepare(
          "INSERT INTO quarantined_databases (path, kind, reason, quarantined_at) VALUES (?, ?, ?, ?)",
        )
        .run(path.resolve(databasePath), "agent", "legacy quarantine", 1);
    } finally {
      legacy.close();
    }

    expect(readAforaDatabaseQuarantine(databasePath, { env })).toEqual({
      kind: "agent",
      quarantinedAt: 1,
      reason: "legacy quarantine",
    });
    expect(
      recordAforaDatabaseQuarantine({
        env,
        kind: "agent",
        path: databasePath,
        reason: "migrated quarantine",
      }),
    ).toBe(true);

    const migrated = new DatabaseSync(storePath, { readOnly: true });
    try {
      expect(readSqliteNumberPragma(migrated, "user_version")).toBe(2);
      expect(
        migrated
          .prepare("SELECT reason, verified_generation FROM quarantined_databases WHERE path = ?")
          .get(path.resolve(databasePath)),
      ).toEqual({ reason: "migrated quarantine", verified_generation: null });
    } finally {
      migrated.close();
    }
  });

  it("recovers an interrupted empty quarantine-store initialization", () => {
    const stateDir = tempDirs.make("afora-database-verify-empty-store-");
    const env = { AFORA_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agent.sqlite");
    const storePath = quarantineStorePath(stateDir);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, "", { mode: 0o600 });

    expect(readAforaDatabaseQuarantine(databasePath, { env })).toBeUndefined();
    expect(
      recordAforaDatabaseQuarantine({
        env,
        kind: "agent",
        path: databasePath,
        reason: "corrupt index",
      }),
    ).toBe(true);
    expect(readAforaDatabaseQuarantine(databasePath, { env })?.reason).toBe("corrupt index");
  });

  it.skipIf(process.platform === "win32")(
    "recovers a hot rollback journal before reading quarantine",
    () => {
      const stateDir = tempDirs.make("afora-database-verify-hot-journal-");
      const env = { AFORA_STATE_DIR: stateDir };
      const databasePath = path.join(stateDir, "agent.sqlite");
      const storePath = quarantineStorePath(stateDir);
      expect(
        recordAforaDatabaseQuarantine({
          env,
          kind: "agent",
          path: databasePath,
          reason: "committed reason",
        }),
      ).toBe(true);

      const crashed = spawnSync(
        process.execPath,
        [
          "--no-warnings",
          "--input-type=module",
          "-e",
          `
            import { DatabaseSync } from "node:sqlite";
            const database = new DatabaseSync(process.env.AFORA_QUARANTINE_TEST_PATH);
            database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
            database.prepare("UPDATE quarantined_databases SET reason = 'uncommitted reason'").run();
            process.kill(process.pid, "SIGKILL");
          `,
        ],
        { env: { ...process.env, AFORA_QUARANTINE_TEST_PATH: storePath } },
      );
      expect(crashed.signal).toBe("SIGKILL");
      expect(fs.existsSync(`${storePath}-journal`)).toBe(true);

      expect(readAforaDatabaseQuarantine(databasePath, { env })?.reason).toBe(
        "committed reason",
      );
    },
  );

  it("does not latch transient verifier errors", () => {
    const stateDir = tempDirs.make("afora-database-verify-transient-");
    const env = { AFORA_STATE_DIR: stateDir };
    const agentPath = openAforaAgentDatabase({ agentId: "worker-1", env }).path;
    closeAforaAgentDatabasesForTest();
    closeAforaStateDatabaseForTest();
    const targets: AforaDatabaseVerifyTarget[] = [
      { kind: "agent", label: "Afora agent database worker-1", path: agentPath },
    ];

    applyAforaDatabaseVerificationResults({
      env,
      results: [{ path: agentPath, ok: false, error: "Error: database is busy", terminal: false }],
      targets,
    });

    expect(openAforaAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("persists state failure quarantine across restart until doctor repair", () => {
    const stateDir = tempDirs.make("afora-database-verify-state-failure-");
    const env = { AFORA_STATE_DIR: stateDir };
    const statePath = openAforaStateDatabase({ env }).path;
    closeAforaStateDatabaseForTest();

    expect(
      recordAforaDatabaseQuarantine({
        env,
        kind: "state",
        path: statePath,
        reason: "corrupt index",
      }),
    ).toBe(true);
    const error = new Error("corrupt index");
    error.name = "SqliteIntegrityError";
    recordAforaStateDatabaseOpenFailure(statePath, error);

    const { DatabaseSync } = requireNodeSqlite();
    const raw = new DatabaseSync(quarantineStorePath(stateDir), { readOnly: true });
    try {
      expect(
        raw.prepare("SELECT kind, reason FROM quarantined_databases WHERE path = ?").get(statePath),
      ).toEqual({ kind: "state", reason: "corrupt index" });
    } finally {
      raw.close();
    }
    expect(() => openAforaStateDatabase({ env })).toThrow(
      expect.objectContaining({
        name: "SqliteIntegrityError",
        message: expect.stringContaining("corrupt index"),
      }),
    );
    closeAforaStateDatabaseForTest();
    expect(() => openAforaStateDatabase({ env })).toThrow(
      expect.objectContaining({
        name: "SqliteIntegrityError",
        message: expect.stringContaining("corrupt index"),
      }),
    );
    expect(repairAforaStateDatabaseSchema({ env }).warnings).toEqual([]);
    expect(openAforaStateDatabase({ env }).db.isOpen).toBe(true);
  });
});
