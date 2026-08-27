import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeAforaStateDatabaseForTest,
  openAforaStateDatabase,
} from "../../state/afora-state-db.js";
import {
  createAforaTestState,
  type AforaTestState,
} from "../../test-utils/afora-test-state.js";
import {
  clearCuratedSkillLifecycle,
  getArchivedSkillFiles,
  getSkillCuratorStatus,
  pinCuratedSkill,
  restoreCuratedSkill,
  unpinCuratedSkill,
} from "./curator.js";

let testState: AforaTestState;

beforeEach(async () => {
  testState = await createAforaTestState({
    layout: "state-only",
    prefix: "afora-legacy-skill-curator-",
  });
});

afterEach(async () => {
  closeAforaStateDatabaseForTest();
  await testState.cleanup();
});

describe("legacy skill curator state", () => {
  it("keeps shipped status controls while collection review clears their state", () => {
    const skillFile = "/workspace/skills/daily-brief/SKILL.md";
    const database = openAforaStateDatabase({ env: testState.env });
    database.db
      .prepare(
        `INSERT INTO skill_lifecycle (
          skill_file, skill_key, skill_name, state, pinned,
          state_changed_at_ms, created_at_ms, archived_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(skillFile, "daily-brief", "Daily Brief", "archived", 0, 10, 1, "unused");

    expect(getArchivedSkillFiles({ env: testState.env })).toEqual(new Set([skillFile]));
    expect(pinCuratedSkill("daily-brief", { env: testState.env }).pinned).toBe(true);
    expect(unpinCuratedSkill("daily-brief", { env: testState.env }).pinned).toBe(false);
    expect(restoreCuratedSkill("daily-brief", { env: testState.env, nowMs: 20 }).state).toBe(
      "active",
    );

    clearCuratedSkillLifecycle([skillFile], { env: testState.env });
    expect(getSkillCuratorStatus({ env: testState.env }).skills).toEqual([]);
  });
});
