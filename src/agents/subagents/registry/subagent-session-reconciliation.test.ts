// Subagent session reconciliation tests cover how a persisted child session
// entry is converted into a registry completion outcome.
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../../config/sessions.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import {
  isExternalCliSubagentRuntime,
  resolveCompletionFromSessionEntry,
} from "./subagent-session-reconciliation.js";

function makeFailedSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-id",
    updatedAt: 4_000,
    status: "failed",
    startedAt: 2_000,
    endedAt: 4_000,
    ...overrides,
  } as SessionEntry;
}

describe("resolveCompletionFromSessionEntry", () => {
  it("preserves the persisted session error for a failed run", () => {
    const completion = resolveCompletionFromSessionEntry(
      makeFailedSessionEntry({ lastRunError: "worker exited with code 1 after writing report" }),
      5_000,
    );

    expect(completion).toMatchObject({
      endedAt: 4_000,
      reason: SUBAGENT_ENDED_REASON_ERROR,
      outcome: {
        status: "error",
        error: "worker exited with code 1 after writing report",
      },
    });
  });

  it("falls back to the generic error when the session entry carries none", () => {
    const completion = resolveCompletionFromSessionEntry(
      makeFailedSessionEntry({ lastRunError: "  " }),
      5_000,
    );

    expect(completion?.outcome).toEqual({
      status: "error",
      error: "session completed before registry settled",
    });
  });

  it("still rejects a stale failed entry that predates the run", () => {
    const completion = resolveCompletionFromSessionEntry(
      makeFailedSessionEntry({ lastRunError: "old failure" }),
      5_000,
      { notBeforeMs: 6_000 },
    );

    expect(completion).toBeNull();
  });
});

describe("isExternalCliSubagentRuntime", () => {
  const childSessionKey = "agent:main:subagent:child";
  const embeddedEntry = { sessionId: "session-id", updatedAt: 4_000 } as SessionEntry;

  it("detects CLI session bindings on the child entry", () => {
    expect(
      isExternalCliSubagentRuntime({
        childSessionKey,
        sessionEntry: { ...embeddedEntry, claudeCliSessionId: "cli-session-1" },
        cfg: {} as OpenClawConfig,
      }),
    ).toBe(true);
    expect(
      isExternalCliSubagentRuntime({
        childSessionKey,
        sessionEntry: { ...embeddedEntry, cliSessionIds: { kimi: "cli-session-2" } },
        cfg: {} as OpenClawConfig,
      }),
    ).toBe(true);
  });

  it("detects a non-default runtime override on the child entry", () => {
    expect(
      isExternalCliSubagentRuntime({
        childSessionKey,
        sessionEntry: { ...embeddedEntry, agentRuntimeOverride: "kimi-cli" },
        cfg: {} as OpenClawConfig,
      }),
    ).toBe(true);
  });

  it("detects a configured external runtime for the child agent", () => {
    expect(
      isExternalCliSubagentRuntime({
        childSessionKey,
        sessionEntry: embeddedEntry,
        cfg: {
          agents: { defaults: { agentRuntime: { id: "kimi-cli" } } },
        } as unknown as OpenClawConfig,
      }),
    ).toBe(true);
  });

  it("treats embedded sessions as in-process", () => {
    expect(
      isExternalCliSubagentRuntime({
        childSessionKey,
        sessionEntry: embeddedEntry,
        cfg: {} as OpenClawConfig,
      }),
    ).toBe(false);
    expect(
      isExternalCliSubagentRuntime({
        childSessionKey,
        sessionEntry: { ...embeddedEntry, agentRuntimeOverride: "openclaw" },
        cfg: {} as OpenClawConfig,
      }),
    ).toBe(false);
  });
});
