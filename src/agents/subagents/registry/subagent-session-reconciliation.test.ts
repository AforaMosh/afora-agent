// Subagent session reconciliation tests cover how a persisted child session
// entry is converted into a registry completion outcome.
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../../config/sessions.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { resolveCompletionFromSessionEntry } from "./subagent-session-reconciliation.js";

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
