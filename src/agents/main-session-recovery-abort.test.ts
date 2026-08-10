import { describe, expect, it } from "vitest";
import type {
  InternalSessionEntry as SessionEntry,
  MainRestartRecoveryState,
} from "../config/sessions.js";
import { transitionMainSessionRecovery } from "./main-session-recovery-state.js";

const sessionKey = "agent:main:main";

function recoveryState(
  overrides: Partial<MainRestartRecoveryState> = {},
): MainRestartRecoveryState {
  return {
    cycleId: "cycle-1",
    revision: 1,
    chargedAttempts: 0,
    ...overrides,
  };
}

function interruptedEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 100,
    status: "running",
    abortedLastRun: true,
    mainRestartRecovery: recoveryState(),
    ...overrides,
  };
}

function observe(entry: SessionEntry, lifecycleGeneration: string) {
  const result = transitionMainSessionRecovery(entry, {
    kind: "observe",
    cycleId: "unused-cycle",
    lifecycleGeneration,
    sessionKey,
  });
  if (result.kind !== "observed") {
    throw new Error("expected recovery observation");
  }
  return result.view;
}

function abortClaim(params: {
  claim: {
    claimId: string;
    cycleId: string;
    lifecycleGeneration: string;
    runId?: string;
    sessionId: string;
    sessionKey: string;
  };
  entry: SessionEntry;
  now: number;
  runId?: string;
}) {
  return transitionMainSessionRecovery(params.entry, {
    kind: "abort_foreground",
    now: params.now,
    target: {
      kind: "claim",
      claim: params.claim,
      ...(params.runId ? { runId: params.runId } : {}),
    },
  });
}

describe("main session recovery user abort", () => {
  it("terminalizes an exact foreground user abort before owner release", () => {
    const entry = interruptedEntry({
      startedAt: 100,
      restartRecoveryRuns: [{ runId: "recovery-1", lifecycleGeneration: "generation-1" }],
      mainRestartRecovery: recoveryState({
        revision: 3,
        chargedAttempts: 1,
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["foreground-1"],
          runIdsByClaimId: { "foreground-1": "recovery-1" },
        },
      }),
    });
    const claim = {
      cycleId: "cycle-1",
      lifecycleGeneration: "generation-1",
      claimId: "foreground-1",
      sessionId: "session-1",
      sessionKey,
      runId: "recovery-1",
    };

    expect(abortClaim({ entry, claim, now: 300 })).toEqual({ kind: "applied" });
    expect(entry).toMatchObject({
      status: "killed",
      abortedLastRun: true,
      lifecycleRunId: "recovery-1",
      endedAt: 300,
      runtimeMs: 200,
      updatedAt: 300,
      restartRecoveryTerminalRunIds: ["recovery-1"],
    });
    expect(entry.restartRecoveryRuns).toBeUndefined();
    expect(entry.mainRestartRecovery).toBeUndefined();
    expect(
      transitionMainSessionRecovery(entry, {
        kind: "release_foreground",
        claim,
      }),
    ).toEqual({ kind: "no_change" });
    expect(observe(entry, "generation-1")).toEqual({ status: "inactive" });
  });

  it("leaves a replaced foreground owner unchanged on stale abort", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: recoveryState({
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["foreground-2"],
          runIdsByClaimId: { "foreground-2": "recovery-2" },
        },
      }),
    });
    const before = structuredClone(entry);

    expect(
      abortClaim({
        entry,
        claim: {
          cycleId: "cycle-1",
          lifecycleGeneration: "generation-1",
          claimId: "foreground-1",
          sessionId: "session-1",
          sessionKey,
        },
        now: 300,
        runId: "recovery-1",
      }),
    ).toEqual({ kind: "no_change" });
    expect(entry).toEqual(before);
  });

  it("tombstones an aborted run while another foreground owner remains", () => {
    const entry = interruptedEntry({
      lifecycleRunId: "recovery-1",
      restartRecoveryRuns: [
        { runId: "recovery-1", lifecycleGeneration: "generation-1" },
        { runId: "recovery-2", lifecycleGeneration: "generation-1" },
      ],
      mainRestartRecovery: recoveryState({
        revision: 3,
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["foreground-1", "foreground-2"],
          runIdsByClaimId: {
            "foreground-1": "recovery-1",
            "foreground-2": "recovery-2",
          },
        },
      }),
    });

    expect(
      abortClaim({
        entry,
        claim: {
          cycleId: "cycle-1",
          lifecycleGeneration: "generation-1",
          claimId: "foreground-1",
          sessionId: "session-1",
          sessionKey,
          runId: "recovery-1",
        },
        now: 300,
      }),
    ).toEqual({ kind: "applied" });
    expect(entry.restartRecoveryTerminalRunIds).toEqual(["recovery-1"]);
    expect(entry.restartRecoveryRuns).toEqual([
      { runId: "recovery-2", lifecycleGeneration: "generation-1" },
    ]);
    expect(entry.lifecycleRunId).toBe("recovery-2");
    expect(entry.mainRestartRecovery?.foregroundClaims).toEqual({
      lifecycleGeneration: "generation-1",
      tokens: ["foreground-2"],
      runIdsByClaimId: { "foreground-2": "recovery-2" },
    });
  });

  it("does not borrow a sibling run id for an unbound concurrent owner", () => {
    const entry = interruptedEntry({
      lifecycleRunId: "recovery-2",
      restartRecoveryRuns: [{ runId: "recovery-2", lifecycleGeneration: "generation-1" }],
      mainRestartRecovery: recoveryState({
        revision: 3,
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["foreground-1", "foreground-2"],
          runIdsByClaimId: { "foreground-2": "recovery-2" },
        },
      }),
    });

    expect(
      abortClaim({
        entry,
        claim: {
          cycleId: "cycle-1",
          lifecycleGeneration: "generation-1",
          claimId: "foreground-1",
          sessionId: "session-1",
          sessionKey,
        },
        now: 300,
      }),
    ).toEqual({ kind: "applied" });
    expect(entry.restartRecoveryTerminalRunIds).toBeUndefined();
    expect(entry.restartRecoveryRuns).toEqual([
      { runId: "recovery-2", lifecycleGeneration: "generation-1" },
    ]);
    expect(entry.mainRestartRecovery?.foregroundClaims).toEqual({
      lifecycleGeneration: "generation-1",
      tokens: ["foreground-2"],
      runIdsByClaimId: { "foreground-2": "recovery-2" },
    });
  });

  it("terminalizes a released sibling fence when the final owner is unbound", () => {
    const entry = interruptedEntry({
      lifecycleRunId: "recovery-2",
      restartRecoveryRuns: [{ runId: "recovery-2", lifecycleGeneration: "generation-1" }],
      mainRestartRecovery: recoveryState({
        revision: 3,
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["foreground-1", "foreground-2"],
          runIdsByClaimId: { "foreground-2": "recovery-2" },
        },
      }),
    });

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "release_foreground",
        claim: {
          cycleId: "cycle-1",
          lifecycleGeneration: "generation-1",
          claimId: "foreground-2",
          sessionId: "session-1",
          sessionKey,
          runId: "recovery-2",
        },
      }),
    ).toEqual({ kind: "applied" });
    expect(
      abortClaim({
        entry,
        claim: {
          cycleId: "cycle-1",
          lifecycleGeneration: "generation-1",
          claimId: "foreground-1",
          sessionId: "session-1",
          sessionKey,
        },
        now: 300,
      }),
    ).toEqual({ kind: "applied" });
    expect(entry).toMatchObject({
      status: "killed",
      abortedLastRun: true,
      lifecycleRunId: undefined,
    });
    expect(entry.restartRecoveryTerminalRunIds).toEqual(["recovery-2"]);
    expect(entry.restartRecoveryRuns).toBeUndefined();
    expect(entry.mainRestartRecovery).toBeUndefined();
  });

  it("terminalizes an operationless active recovery run by exact identity", () => {
    const entry = interruptedEntry({
      startedAt: 100,
      restartRecoveryRuns: [{ runId: "recovery-1", lifecycleGeneration: "generation-1" }],
      mainRestartRecovery: recoveryState({ revision: 4 }),
    });

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "abort_foreground",
        now: 300,
        target: {
          kind: "run",
          lifecycleGeneration: "generation-1",
          runId: "recovery-1",
          sessionId: "session-1",
        },
      }),
    ).toEqual({ kind: "applied" });
    expect(entry).toMatchObject({
      status: "killed",
      abortedLastRun: true,
      lifecycleRunId: "recovery-1",
      restartRecoveryTerminalRunIds: ["recovery-1"],
    });
    expect(entry.restartRecoveryRuns).toBeUndefined();
    expect(entry.mainRestartRecovery).toBeUndefined();
  });

  it("rejects an operationless abort whose run identity no longer owns recovery", () => {
    const entry = interruptedEntry({
      restartRecoveryRuns: [{ runId: "recovery-2", lifecycleGeneration: "generation-1" }],
      mainRestartRecovery: recoveryState({ revision: 4 }),
    });
    const before = structuredClone(entry);

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "abort_foreground",
        now: 300,
        target: {
          kind: "run",
          lifecycleGeneration: "generation-1",
          runId: "recovery-1",
          sessionId: "session-1",
        },
      }),
    ).toEqual({ kind: "no_change" });
    expect(entry).toEqual(before);
  });
});
