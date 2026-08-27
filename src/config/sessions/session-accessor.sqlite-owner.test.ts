import { afterEach, describe, expect, it } from "vitest";
import { FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS } from "../../state/afora-agent-db-additive-columns.js";
import {
  closeAforaAgentDatabasesForTest,
  openAforaAgentDatabase,
} from "../../state/afora-agent-db.js";
import { withAforaTestState } from "../../test-utils/afora-test-state.js";
import {
  assignSessionOwner,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";

afterEach(() => {
  closeAforaAgentDatabasesForTest();
});

describe("SQLite session owner assignment", () => {
  it("lazily adds bare columns and preserves the assignment across reopen", async () => {
    await withAforaTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:owned-session",
      };
      await upsertSessionEntryCore(scope, {
        sessionId: "session-owned",
        updatedAt: 1,
        createdActor: { type: "human", id: "profile-creator" },
      });
      const initial = openAforaAgentDatabase({ agentId: "main", env: state.env });
      for (const { columnName } of FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS) {
        initial.db.exec(`ALTER TABLE session_nodes DROP COLUMN ${columnName};`);
      }
      closeAforaAgentDatabasesForTest();

      expect(loadSessionEntry(scope)).toMatchObject({
        createdActor: { type: "human", id: "profile-creator" },
      });
      expect(loadSessionEntry(scope)?.owner).toBeUndefined();

      expect(
        assignSessionOwner(scope, {
          owner: { type: "agent", id: "research" },
          assignedBy: { type: "human", id: "profile-assigner" },
          assignedAt: 1234,
        }),
      ).toEqual({
        actor: { type: "agent", id: "research" },
        assignedBy: { type: "human", id: "profile-assigner" },
        assignedAt: 1234,
      });
      expect(loadSessionEntry(scope)?.owner).toEqual({
        actor: { type: "agent", id: "research" },
        assignedBy: { type: "human", id: "profile-assigner" },
        assignedAt: 1234,
      });

      closeAforaAgentDatabasesForTest();
      expect(loadSessionEntry(scope)?.owner).toEqual({
        actor: { type: "agent", id: "research" },
        assignedBy: { type: "human", id: "profile-assigner" },
        assignedAt: 1234,
      });
      const reopened = openAforaAgentDatabase({ agentId: "main", env: state.env });
      const columns = reopened.db.prepare("PRAGMA table_info(session_nodes)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: unknown;
        type: string;
      }>;
      for (const definition of FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS) {
        expect(columns.find((column) => column.name === definition.columnName)).toMatchObject({
          type: definition.dataType,
          notnull: 0,
          dflt_value: null,
        });
      }
    });
  });
});
