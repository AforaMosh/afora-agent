import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { upsertSessionEntry } from "./session-accessor.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { readCurrentSessionMemorySubject } from "./session-memory-subject-access.js";
import { prepareExplicitSessionMemorySubjectSeed } from "./session-memory-subject.js";

const tempDirectories = useAutoCleanupTempDirTracker(afterEach);

function createScope() {
  const directory = tempDirectories.make("openclaw-session-memory-subject-immutable-");
  return {
    agentId: "main",
    sessionKey: "agent:main:immutable-subject",
    storePath: path.join(directory, "sessions.json"),
  };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("session memory subject immutability", () => {
  it("lazily restores missing subject tables and trigger in a current agent database", async () => {
    const scope = createScope();
    const stateOptions = { path: path.join(path.dirname(scope.storePath), "state.sqlite") };
    const seed = prepareExplicitSessionMemorySubjectSeed({
      kind: "service",
      stableSubjectId: "lazy-schema-restore-service",
      now: 100,
      options: stateOptions,
    });

    await upsertSessionEntry(scope, { sessionId: "lazy-schema-session", updatedAt: 100 });

    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
    database.db.exec(`
      DROP TRIGGER IF EXISTS session_memory_subjects_reject_update;
      DROP TABLE session_memory_subject_snapshots;
      DROP TABLE session_memory_subjects;
    `);
    closeOpenClawAgentDatabasesForTest();

    await upsertSessionEntry(
      scope,
      { sessionId: "lazy-schema-session", updatedAt: 101 },
      { memorySubjectSeed: seed },
    );

    expect(readCurrentSessionMemorySubject(scope)?.subject).toEqual(seed.subject);

    const reopened = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
    expect(
      reopened.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'session_memory_subjects'",
        )
        .get(),
    ).toEqual({ name: "session_memory_subjects" });
    expect(
      reopened.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'session_memory_subject_snapshots'",
        )
        .get(),
    ).toEqual({ name: "session_memory_subject_snapshots" });
    expect(
      reopened.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'session_memory_subjects_reject_update'",
        )
        .get(),
    ).toEqual({ name: "session_memory_subjects_reject_update" });
  });

  it("lazily installs the immutable-row trigger before accepting an existing subject", async () => {
    const scope = createScope();
    await upsertSessionEntry(scope, { sessionId: "immutable-session", updatedAt: 100 });

    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
    database.db.exec("DROP TRIGGER session_memory_subjects_reject_update;");
    closeOpenClawAgentDatabasesForTest();

    expect(readCurrentSessionMemorySubject(scope)?.subject).toEqual({
      version: 1,
      kind: "ambiguous",
      reason: "unbound",
    });

    const reopened = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
    expect(
      reopened.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = 'session_memory_subjects_reject_update'",
        )
        .get(),
    ).toEqual({ name: "session_memory_subjects_reject_update" });
    expect(() =>
      reopened.db
        .prepare(
          "UPDATE session_memory_subjects SET ambiguous_reason = 'shared-main' WHERE session_key = ?",
        )
        .run(scope.sessionKey),
    ).toThrow("session memory subject is immutable");
  });
});
