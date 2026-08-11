import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";

const tempDirs: string[] = [];

describe("legacy media persistence additive schema repair", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanupTempDirs(tempDirs);
  });

  it("repairs same-version additive and retired structural schema before media validation", () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-current-additive-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    const databasePath = opened.path;
    opened.db
      .prepare(
        `INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        "agent:main:session-1",
        "session-1",
        JSON.stringify({ sessionId: "session-1", updatedAt: 1 }),
        1,
      );
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    database.exec(`
      DROP TRIGGER session_nodes_entry_valid_after_insert;
      DROP TRIGGER session_nodes_entry_valid_after_entry_update;
      DROP TRIGGER session_nodes_entry_valid_after_identity_update;
      DROP INDEX idx_agent_session_nodes_entry_valid_pending;
      DROP TABLE session_key_contract;
      ALTER TABLE session_nodes DROP COLUMN entry_valid;
      CREATE TABLE state_leases (
        scope TEXT NOT NULL,
        lease_key TEXT NOT NULL,
        owner TEXT NOT NULL,
        expires_at INTEGER,
        heartbeat_at INTEGER,
        payload_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, lease_key)
      ) STRICT;
      CREATE INDEX idx_agent_state_leases_expiry
        ON state_leases(expires_at, scope, lease_key)
        WHERE expires_at IS NOT NULL;
      CREATE INDEX idx_agent_state_leases_owner
        ON state_leases(owner, updated_at DESC);
      INSERT INTO state_leases (
        scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at
      ) VALUES ('retired', 'orphan', 'nobody', NULL, NULL, NULL, 1, 1);
      INSERT INTO auth_profile_store (store_key, store_json, updated_at)
      VALUES ('primary', '{"fixture":"store-present"}', 10);
      INSERT INTO auth_profile_state (state_key, state_json, updated_at)
      VALUES ('primary', '{"fixture":"state-present"}', 11);
    `);
    const before = {
      authState: database
        .prepare("SELECT state_key, state_json, updated_at FROM auth_profile_state")
        .get(),
      authStore: database
        .prepare("SELECT store_key, store_json, updated_at FROM auth_profile_store")
        .get(),
      metadata: database
        .prepare(
          "SELECT role, schema_version, agent_id, app_version, created_at, updated_at FROM schema_meta WHERE meta_key = 'primary'",
        )
        .get(),
    };
    database.close();

    const result = migrateLegacyMediaPersistence({ env });
    expect(result.warnings).toEqual([]);
    const repaired = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(repaired.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(
        repaired
          .prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?")
          .get("agent:main:session-1"),
      ).toEqual({ entry_valid: 1 });
      expect(
        repaired.prepare("SELECT main_key FROM session_key_contract WHERE id = 1").get(),
      ).toEqual({ main_key: "main" });
      expect(
        repaired
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name IN ('state_leases', 'idx_agent_state_leases_expiry', 'idx_agent_state_leases_owner')",
          )
          .all(),
      ).toEqual([]);
      expect(
        repaired.prepare("SELECT store_key, store_json, updated_at FROM auth_profile_store").get(),
      ).toEqual(before.authStore);
      expect(
        repaired.prepare("SELECT state_key, state_json, updated_at FROM auth_profile_state").get(),
      ).toEqual(before.authState);
      expect(
        repaired
          .prepare(
            "SELECT role, schema_version, agent_id, app_version, created_at, updated_at FROM schema_meta WHERE meta_key = 'primary'",
          )
          .get(),
      ).toEqual(before.metadata);
      expect(repaired.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      expect(repaired.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      repaired.close();
    }
    expect(migrateLegacyMediaPersistence({ env })).toEqual({ changes: [], warnings: [] });
  });
});
