import { describe, expect, it } from "vitest";
import { buildSessionResetEntry } from "./session-reset-entry.js";
import type { SessionEntry } from "./types.js";

function createIds(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `id-${index}`;
}

describe("buildSessionResetEntry", () => {
  it("preserves durable choices while clearing prior run state", () => {
    const current: SessionEntry = {
      sessionId: "session-1",
      lifecycleRevision: "old-lifecycle",
      updatedAt: 1,
      status: "failed",
      lastRunError: "provider failed",
      thinkingLevel: "high",
      fastMode: "auto",
      modelOverride: "model-a",
      modelOverrideSource: "user",
      providerOverride: "provider-a",
      authProfileOverride: "profile-a",
      authProfileOverrideSource: "user",
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      totalTokensFresh: false,
      contextTokens: 100,
    };

    const next = buildSessionResetEntry({
      currentEntry: current,
      primaryKey: "agent:main:work",
      resetBoundaryAppended: true,
      now: 5_000,
      createId: createIds("new-lifecycle"),
    });

    expect(next).toMatchObject({
      sessionId: "session-1",
      lifecycleRevision: "new-lifecycle",
      updatedAt: 5_000,
      sessionStartedAt: 5_000,
      systemSent: false,
      abortedLastRun: false,
      thinkingLevel: "high",
      fastMode: "auto",
      modelOverride: "model-a",
      modelOverrideSource: "user",
      providerOverride: "provider-a",
      authProfileOverride: "profile-a",
      authProfileOverrideSource: "user",
      compactionCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalTokensFresh: true,
    });
    expect(next).not.toHaveProperty("status");
    expect(next).not.toHaveProperty("lastRunError");
    expect(next).not.toHaveProperty("contextTokens");
  });

  it("applies creation, exec, and workspace reset inputs for a new row", () => {
    const next = buildSessionResetEntry({
      primaryKey: "agent:main:new",
      resetBoundaryAppended: false,
      now: 5_000,
      createId: createIds("session-1", "lifecycle-1"),
      creation: {
        via: "plugin",
        actor: { type: "system", id: "runtime-a" },
      },
      authorizedPluginId: "plugin-a",
      execNode: "node-a",
      execCwd: "/node/work",
      spawnedCwd: "/workspace",
      worktree: {
        id: "worktree-a",
        branch: "feature/a",
        repoRoot: "/repo",
      },
    });

    expect(next).toMatchObject({
      sessionId: "session-1",
      lifecycleRevision: "lifecycle-1",
      createdVia: "plugin",
      createdActor: { type: "system", id: "runtime-a" },
      createdAt: 5_000,
      pluginOwnerId: "plugin-a",
      execHost: "node",
      execNode: "node-a",
      execCwd: "/node/work",
      spawnedCwd: "/workspace",
      worktree: {
        id: "worktree-a",
        branch: "feature/a",
        repoRoot: "/repo",
      },
    });
  });

  it("clears ordinary CLI bindings but preserves spawned subagent continuity", () => {
    const current: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      cliSessionBindings: {
        "claude-cli": {
          sessionId: "provider-session",
          reseedReceipt: {
            version: 1,
            promptHash: "a".repeat(64),
            localSessionId: "old-local-session",
            userTurnDisposition: "omitted",
          },
        },
      },
      cliSessionIds: { "claude-cli": "provider-session" },
      claudeCliSessionId: "provider-session",
    };

    const ordinary = buildSessionResetEntry({
      currentEntry: current,
      primaryKey: "agent:main:work",
      resetBoundaryAppended: true,
      now: 5_000,
      createId: createIds("ordinary-lifecycle"),
    });
    expect(ordinary.cliSessionBindings).toBeUndefined();
    expect(ordinary.cliSessionIds).toBeUndefined();
    expect(ordinary.claudeCliSessionId).toBeUndefined();

    const subagent = buildSessionResetEntry({
      currentEntry: current,
      primaryKey: "agent:main:subagent:child",
      resetBoundaryAppended: true,
      now: 5_000,
      createId: createIds("subagent-lifecycle"),
    });
    expect(subagent.cliSessionBindings).toEqual({
      "claude-cli": {
        sessionId: "provider-session",
        reseedReceipt: {
          version: 1,
          promptHash: "a".repeat(64),
          localSessionId: "session-1",
          userTurnDisposition: "omitted",
        },
      },
    });
    expect(subagent.cliSessionIds).toEqual({ "claude-cli": "provider-session" });
    expect(subagent.claudeCliSessionId).toBe("provider-session");
  });
});
