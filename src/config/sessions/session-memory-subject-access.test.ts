import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { replaceSessionEntrySync, upsertSessionEntry } from "./session-accessor.js";
import {
  readCurrentSessionMemorySubject,
  readCurrentSessionMemorySubjectAuthority,
} from "./session-memory-subject-access.js";
import {
  prepareExplicitSessionMemorySubjectSeed,
  SessionMemorySubjectReboundError,
} from "./session-memory-subject.js";
import * as sessionMemorySubjectModule from "./session-memory-subject.js";

const tempDirectories = useAutoCleanupTempDirTracker(afterEach);

function createPaths() {
  const directory = tempDirectories.make("openclaw-session-memory-subject-access-");
  return {
    stateOptions: { path: path.join(directory, "state.sqlite") },
    storePath: path.join(directory, "sessions.json"),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("session memory subject access", () => {
  it("returns the current persisted subject and authority", async () => {
    const { stateOptions, storePath } = createPaths();
    const scope = { agentId: "main", sessionKey: "agent:main:service:task-1", storePath };
    const seed = prepareExplicitSessionMemorySubjectSeed({
      kind: "service",
      stableSubjectId: "task-service",
      now: 100,
      options: stateOptions,
    });
    await upsertSessionEntry(
      scope,
      { sessionId: "session-1", updatedAt: 100 },
      { memorySubjectSeed: seed },
    );

    const snapshot = readCurrentSessionMemorySubject(scope);
    const result = readCurrentSessionMemorySubjectAuthority(scope, stateOptions, 101);

    expect(snapshot).toMatchObject({
      sessionId: "session-1",
      subject: { kind: "service" },
    });
    expect(result).toMatchObject({
      snapshot,
      authority: { kind: "current", assurance: "service" },
    });
  });

  it("fails closed when the session is rebound between authority checks", async () => {
    const { stateOptions, storePath } = createPaths();
    const scope = { agentId: "main", sessionKey: "agent:main:rebound-race", storePath };
    const seed = prepareExplicitSessionMemorySubjectSeed({
      kind: "service",
      stableSubjectId: "rebound-race-service",
      now: 100,
      options: stateOptions,
    });
    await upsertSessionEntry(
      scope,
      { sessionId: "rebound-race-before", updatedAt: 101 },
      { memorySubjectSeed: seed },
    );

    const resolveAuthority = sessionMemorySubjectModule.resolveSessionMemorySubjectAuthority;
    let replaced = false;
    const resolveAuthoritySpy = vi
      .spyOn(sessionMemorySubjectModule, "resolveSessionMemorySubjectAuthority")
      .mockImplementation((snapshot, options, now) => {
        const result = resolveAuthority(snapshot, options, now);
        if (!replaced) {
          replaced = true;
          replaceSessionEntrySync(scope, {
            sessionId: "rebound-race-after",
            updatedAt: 102,
          });
        }
        return result;
      });

    expect(() => readCurrentSessionMemorySubjectAuthority(scope, stateOptions, 103)).toThrow(
      SessionMemorySubjectReboundError,
    );
    expect(resolveAuthoritySpy).toHaveBeenCalledOnce();
  });
});
