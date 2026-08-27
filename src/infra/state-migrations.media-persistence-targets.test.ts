import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  registerAforaAgentDatabase,
  unregisterAforaAgentDatabase,
} from "../state/afora-agent-db-registry.js";
import {
  closeAforaAgentDatabasesForTest,
  listAforaRegisteredAgentDatabases,
  AFORA_AGENT_SCHEMA_VERSION,
  openAforaAgentDatabase,
} from "../state/afora-agent-db.js";
import {
  closeAforaStateDatabaseForTest,
  openAforaStateDatabase,
} from "../state/afora-state-db.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";

const tempDirs: string[] = [];
const PREVIOUS_VERSION = AFORA_AGENT_SCHEMA_VERSION - 1;

function createLegacyAgentDatabase(params: {
  agentId?: string;
  env: NodeJS.ProcessEnv;
  path?: string;
}): string {
  const agentId = params.agentId ?? "main";
  const opened = openAforaAgentDatabase({
    agentId,
    env: params.env,
    ...(params.path ? { path: params.path } : {}),
  });
  const databasePath = opened.path;
  closeAforaAgentDatabasesForTest();
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`PRAGMA user_version = ${PREVIOUS_VERSION};`);
    database
      .prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'")
      .run(PREVIOUS_VERSION);
  } finally {
    database.close();
  }
  return databasePath;
}

function readUserVersion(databasePath: string): number {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    database.close();
  }
}

afterEach(() => {
  closeAforaAgentDatabasesForTest();
  closeAforaStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("media persistence migration targets", () => {
  it("migrates and registers an unregistered default-layout agent database", () => {
    const stateDir = fs.realpathSync.native(makeTempDir(tempDirs, "media-persistence-disk-scan-"));
    const env = { AFORA_STATE_DIR: stateDir };
    const databasePath = createLegacyAgentDatabase({ env });
    unregisterAforaAgentDatabase({ agentId: "main", env, path: databasePath });

    const result = migrateLegacyMediaPersistence({ env });

    expect(result.warnings).toEqual([]);
    expect(readUserVersion(databasePath)).toBe(AFORA_AGENT_SCHEMA_VERSION);
    expect(
      listAforaRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([
      expect.objectContaining({
        agentId: "main",
        path: databasePath,
        schemaVersion: AFORA_AGENT_SCHEMA_VERSION,
      }),
    ]);
  });

  it("prefers a renamed configured owner over the default-layout directory name", () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-renamed-owner-"),
    );
    const env = { AFORA_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agents", "oldname", "agent", "afora-agent.sqlite");
    createLegacyAgentDatabase({ agentId: "renamed", env, path: databasePath });
    unregisterAforaAgentDatabase({ agentId: "renamed", env, path: databasePath });

    const result = migrateLegacyMediaPersistence({
      configuredAgentDatabaseTargets: [{ agentId: "renamed", path: databasePath }],
      env,
    });

    expect(result.warnings).toEqual([]);
    expect(readUserVersion(databasePath)).toBe(AFORA_AGENT_SCHEMA_VERSION);
    expect(
      listAforaRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([expect.objectContaining({ agentId: "renamed", path: databasePath })]);
  });

  it("prefers a recorded owner over the default-layout directory name", () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-recorded-owner-"),
    );
    const env = { AFORA_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agents", "dirname", "agent", "afora-agent.sqlite");
    createLegacyAgentDatabase({ agentId: "recorded", env, path: databasePath });

    const result = migrateLegacyMediaPersistence({ env });

    expect(result.warnings).toEqual([]);
    expect(readUserVersion(databasePath)).toBe(AFORA_AGENT_SCHEMA_VERSION);
    expect(
      listAforaRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([expect.objectContaining({ agentId: "recorded", path: databasePath })]);
  });

  it("preserves filesystem traversal for registered paths containing dot-dot segments", () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-symlink-path-"),
    );
    const env = { AFORA_STATE_DIR: stateDir };
    const symlinkTarget = path.join(stateDir, "external", "subdir");
    fs.mkdirSync(symlinkTarget, { recursive: true });
    fs.symlinkSync(symlinkTarget, path.join(stateDir, "link"), "dir");
    const filesystemPath = path.join(stateDir, "external", "x", "afora-agent.sqlite");
    const lexicalPath = path.join(stateDir, "x", "afora-agent.sqlite");
    createLegacyAgentDatabase({ env, path: filesystemPath });
    createLegacyAgentDatabase({ env, path: lexicalPath });
    unregisterAforaAgentDatabase({ agentId: "main", env, path: filesystemPath });
    unregisterAforaAgentDatabase({ agentId: "main", env, path: lexicalPath });
    const registeredPath = `${path.join(stateDir, "link")}${path.sep}..${path.sep}x${path.sep}afora-agent.sqlite`;
    expect(fs.realpathSync.native(registeredPath)).toBe(filesystemPath);
    expect(path.resolve(registeredPath)).toBe(lexicalPath);
    registerAforaAgentDatabase({
      agentId: "main",
      env,
      path: registeredPath,
      schemaVersion: PREVIOUS_VERSION,
    });

    const result = migrateLegacyMediaPersistence({ env });

    expect(result.warnings).toEqual([]);
    expect(readUserVersion(filesystemPath)).toBe(AFORA_AGENT_SCHEMA_VERSION);
    expect(readUserVersion(lexicalPath)).toBe(PREVIOUS_VERSION);
  });

  it("unregisters foreign registry paths without touching their databases", () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-active-state-"),
    );
    const foreignStateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-foreign-state-"),
    );
    const env = { AFORA_STATE_DIR: stateDir };
    const databasePath = path.join(
      foreignStateDir,
      "agents",
      "main",
      "agent",
      "afora-agent.sqlite",
    );
    createLegacyAgentDatabase({ env, path: databasePath });
    const beforeBytes = fs.readFileSync(databasePath);
    const beforeMtimeMs = fs.statSync(databasePath).mtimeMs;

    const result = migrateLegacyMediaPersistence({ env });

    expect(result.warnings).toContain(
      `Skipped foreign agent database ${databasePath}; it is outside the active state directory and is not a configured session store.`,
    );
    expect(
      listAforaRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([]);
    expect(fs.readFileSync(databasePath)).toEqual(beforeBytes);
    expect(fs.statSync(databasePath).mtimeMs).toBe(beforeMtimeMs);
  });

  it("migrates a configured out-of-tree session store", () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-custom-active-"),
    );
    const customRoot = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-custom-store-"),
    );
    const env = { AFORA_STATE_DIR: stateDir };
    const storePath = resolveSessionStorePathCore(
      path.join(customRoot, "{agentId}", "sessions.json"),
      {
        agentId: "main",
        env,
      },
    );
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
      defaultAgentId: "main",
      env,
    }).path;
    createLegacyAgentDatabase({ env, path: databasePath });
    unregisterAforaAgentDatabase({ agentId: "main", env, path: databasePath });
    expect(
      listAforaRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([]);

    const result = migrateLegacyMediaPersistence({
      configuredAgentDatabaseTargets: [{ agentId: "main", path: databasePath }],
      env,
    });

    expect(result.warnings).toEqual([]);
    expect(readUserVersion(databasePath)).toBe(AFORA_AGENT_SCHEMA_VERSION);
    expect(
      listAforaRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([expect.objectContaining({ agentId: "main", path: databasePath })]);
  });

  it("prefers the configured owner over a stale registry owner for the same path", () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-stale-owner-active-"),
    );
    const customRoot = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-stale-owner-store-"),
    );
    const env = { AFORA_STATE_DIR: stateDir };
    const databasePath = path.join(customRoot, "afora-agent.sqlite");
    createLegacyAgentDatabase({ agentId: "new", env, path: databasePath });
    unregisterAforaAgentDatabase({ agentId: "new", env, path: databasePath });
    registerAforaAgentDatabase({
      agentId: "old",
      env,
      path: databasePath,
      schemaVersion: PREVIOUS_VERSION,
    });

    const result = migrateLegacyMediaPersistence({
      configuredAgentDatabaseTargets: [{ agentId: "new", path: databasePath }],
      env,
    });

    expect(result.warnings).toContain(
      `Skipped foreign agent database ${databasePath}; it is outside the active state directory and is not a configured session store.`,
    );
    expect(readUserVersion(databasePath)).toBe(AFORA_AGENT_SCHEMA_VERSION);
    expect(
      listAforaRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([expect.objectContaining({ agentId: "new", path: databasePath })]);
  });

  it("prunes missing and archived registry entries before migration", () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-registry-hygiene-"),
    );
    const env = { AFORA_STATE_DIR: stateDir };
    const missingPath = path.join(stateDir, "agents", "missing", "agent", "afora-agent.sqlite");
    const archivedPath = path.join(stateDir, "imports", "archived", "afora-agent.sqlite");
    fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
    fs.writeFileSync(archivedPath, "archived fixture");
    const state = openAforaStateDatabase({ env });
    const insert = state.db.prepare(
      "INSERT INTO agent_databases(agent_id,path,schema_version,last_seen_at,size_bytes) VALUES(?,?,?,?,?)",
    );
    insert.run("missing", missingPath, AFORA_AGENT_SCHEMA_VERSION, 1, null);
    insert.run("archived", archivedPath, 8, 1, null);

    const result = migrateLegacyMediaPersistence({ env });

    expect(result.changes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Removed missing agent database registry entry"),
        expect.stringContaining("Removed archived or transient agent database registry entry"),
      ]),
    );
    expect(result.warnings).toContain(`Skipped missing registered agent database ${missingPath}.`);
    expect(
      listAforaRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([]);
  });
});
