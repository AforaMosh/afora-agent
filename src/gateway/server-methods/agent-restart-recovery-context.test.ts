import { describe, expect, it } from "vitest";
import {
  resolveAgentRestartRecoveryChannelContext,
  resolveAgentRestartRecoveryExecutionIdentityAdmission,
} from "./agent-restart-recovery-context.js";

const matchingParams = {
  canUseInternalRuntimeHandoff: true,
  expectedExistingSessionId: "session-1",
  resolvedSessionId: "session-1",
  runId: "recovery-run-1",
  sessionEntry: {
    sessionId: "session-1",
    updatedAt: 1,
    restartRecoveryDeliveryRunId: "recovery-run-1",
    restartRecoveryDeliverySourceRunId: "channel-user:v1:source-1",
    restartRecoveryDeliveryContext: {
      channel: "discord",
      to: "discord:dm:123",
      accountId: "work",
      threadId: "thread-1",
    },
    restartRecoveryRequesterAccountId: "work",
    restartRecoveryRequesterSenderId: "user-1",
    restartRecoverySameChannelThreadRequired: true,
    restartRecoverySourceIngress: "channel",
  },
} as const;

describe("resolveAgentRestartRecoveryChannelContext", () => {
  it("rehydrates the exact backend-owned recovery claim", () => {
    expect(resolveAgentRestartRecoveryChannelContext(matchingParams)).toEqual({
      channel: "discord",
      currentChannelId: "discord:dm:123",
      currentThreadTs: "thread-1",
      sourceTurnId: "channel-user:v1:source-1",
      requesterAccountId: "work",
      requesterSenderId: "user-1",
      sameChannelThreadRequired: true,
    });
  });

  it("does not promote a generic chat claim with channel delivery metadata", () => {
    expect(
      resolveAgentRestartRecoveryChannelContext({
        ...matchingParams,
        sessionEntry: {
          ...matchingParams.sessionEntry,
          restartRecoveryDeliveryContext: {
            channel: "discord",
            to: "discord:dm:123",
          },
          restartRecoverySourceIngress: undefined,
        },
      }),
    ).toBeUndefined();
  });

  it.each([
    { canUseInternalRuntimeHandoff: false },
    { expectedExistingSessionId: "session-2" },
    { resolvedSessionId: "session-2" },
    { runId: "recovery-run-2" },
    { sessionEntry: { ...matchingParams.sessionEntry, sessionId: "session-2" } },
    {
      sessionEntry: {
        ...matchingParams.sessionEntry,
        restartRecoveryDeliveryContext: undefined,
      },
    },
    {
      sessionEntry: {
        ...matchingParams.sessionEntry,
        restartRecoverySourceIngress: undefined,
      },
    },
    {
      sessionEntry: {
        ...matchingParams.sessionEntry,
        restartRecoveryDeliverySourceRunId: undefined,
      },
    },
  ])("rejects a non-matching or uncorrelated claim", (override) => {
    expect(
      resolveAgentRestartRecoveryChannelContext({ ...matchingParams, ...override }),
    ).toBeUndefined();
  });
});

describe("resolveAgentRestartRecoveryExecutionIdentityAdmission", () => {
  const sessionEntry = {
    sessionId: "session-1",
    updatedAt: 1,
    mainRestartRecovery: {
      cycleId: "cycle-1",
      revision: 2,
      chargedAttempts: 1,
      executionIdentity: {
        tokenVersion: 1,
        contextId: "context-1",
        executionId: "execution-1",
        runId: "recovery-run-1",
        createdAt: 100,
      },
    },
  } as never;

  it("captures once and reuses only the durable token on a later recovery", () => {
    expect(
      resolveAgentRestartRecoveryExecutionIdentityAdmission({
        isRestartRecoveryResumeRun: true,
        retryOnly: false,
        runId: "recovery-run-1",
        sessionEntry,
      }),
    ).toMatchObject({
      retryOnly: false,
      token: { executionId: "execution-1", contextId: "context-1" },
    });
    expect(
      resolveAgentRestartRecoveryExecutionIdentityAdmission({
        isRestartRecoveryResumeRun: true,
        retryOnly: true,
        runId: "rotated-transport-run",
        sessionEntry,
      }),
    ).toMatchObject({
      retryOnly: true,
      token: { runId: "recovery-run-1", executionId: "execution-1" },
    });
  });

  it("rejects capture mismatch or missing durable state without manufacturing a token", () => {
    expect(() =>
      resolveAgentRestartRecoveryExecutionIdentityAdmission({
        isRestartRecoveryResumeRun: true,
        retryOnly: false,
        runId: "other-run",
        sessionEntry,
      }),
    ).toThrow("disagrees with the admitted run");
    expect(() =>
      resolveAgentRestartRecoveryExecutionIdentityAdmission({
        isRestartRecoveryResumeRun: true,
        retryOnly: true,
        runId: "other-run",
        sessionEntry: { sessionId: "session-1", updatedAt: 1 },
      }),
    ).toThrow("token is unavailable");
    expect(
      resolveAgentRestartRecoveryExecutionIdentityAdmission({
        isRestartRecoveryResumeRun: false,
        retryOnly: false,
        runId: "ordinary-run",
      }),
    ).toBeUndefined();
  });
});
