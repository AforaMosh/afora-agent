import type { MainRestartRecoveryState } from "../config/sessions.js";

export function executionIdentity(runId: string) {
  return {
    tokenVersion: 1 as const,
    contextId: `context-${runId}`,
    executionId: `execution-${runId}`,
    runId,
    createdAt: 100,
  };
}

export function recoveryState(
  overrides: Partial<MainRestartRecoveryState> = {},
): MainRestartRecoveryState {
  return {
    cycleId: "cycle-1",
    revision: 1,
    chargedAttempts: 0,
    ...overrides,
  };
}
