import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { setActiveEmbeddedRun } from "../../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing as embeddedRunsTesting,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { releaseMainSessionRecoveryOwner } from "../../agents/main-session-recovery-store.js";
import {
  clearReplyRecoveryOwner,
  setReplyRecoveryOwner,
} from "../../auto-reply/reply/reply-recovery-owner.js";
import {
  forceClearReplyOperation,
  isReplyRunAbortableForSignal,
  replyRunRegistry,
} from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import type { InternalSessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChatRunState } from "../server-chat-state.js";
import { embeddedRunMock, testState } from "../test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "./chat.abort.test-helpers.js";
import { chatHandlers } from "./chat.js";

setupGatewaySessionsHandlerTestHarness();

function requireStateDir(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required");
  }
  return stateDir;
}

beforeEach(async () => {
  testState.sessionStorePath = undefined;
  testState.sessionConfig = undefined;
  testState.agentsConfig = { list: [{ id: "main", default: true }, { id: "work" }] };
  const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
});

afterEach(() => {
  embeddedRunsTesting.resetActiveEmbeddedRuns();
  replyRunTesting.resetReplyRunRegistry();
  embeddedRunMock.activeIds.clear();
  testState.sessionStorePath = undefined;
  testState.sessionConfig = undefined;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

test.each([
  { label: "backend run id", requestedRunId: "backend", expectedAborted: true },
  { label: "client run id", requestedRunId: "client", expectedAborted: true },
  { label: "mismatched run id", requestedRunId: "other", expectedAborted: false },
])(
  "sessions.abort handles a controller-less recovery by exact $label",
  async ({ requestedRunId, expectedAborted }) => {
    const agentId = "main";
    const sessionKey = "agent:main:openclaw-weixin:direct:controller-less-exact";
    const sessionId = "session-controller-less-exact";
    const backendRunId = "run-controller-less-backend";
    const clientRunId = "run-controller-less-client";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const storePath = path.join(requireStateDir(), "agents", agentId, "sessions", "sessions.json");
    const recoveryEntry: InternalSessionEntry = {
      sessionId,
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
      restartRecoveryRuns: [{ runId: backendRunId, lifecycleGeneration }],
      mainRestartRecovery: {
        cycleId: "cycle-controller-less-exact",
        revision: 2,
        chargedAttempts: 1,
      },
    };
    await replaceSessionEntry({ agentId, sessionKey, storePath }, recoveryEntry);
    setActiveEmbeddedRun(sessionId, createEmbeddedRunHandle({ runId: backendRunId }), sessionKey);
    embeddedRunMock.activeIds.add(sessionId);
    const chatRunState = createChatRunState();
    chatRunState.registry.add(backendRunId, {
      clientRunId,
      sessionKey,
      agentId,
    });

    const result = await directSessionReq(
      "sessions.abort",
      {
        key: sessionKey,
        runId:
          requestedRunId === "backend"
            ? backendRunId
            : requestedRunId === "client"
              ? clientRunId
              : "run-other",
      },
      { context: { chatRunState } },
    );

    expect(result).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        abortedRunId: expectedAborted ? clientRunId : null,
        status: expectedAborted ? "aborted" : "no-active-run",
      },
    });
    expect(embeddedRunMock.abortCalls).toEqual(expectedAborted ? [sessionId] : []);
    expect(loadSessionEntry({ agentId, sessionKey, storePath })).toMatchObject(
      expectedAborted
        ? {
            sessionId,
            lifecycleRunId: backendRunId,
            status: "killed",
            restartRecoveryTerminalRunIds: [backendRunId],
          }
        : recoveryEntry,
    );
  },
);

test("sessions.abort resolves an exact recovery owner before a same-session alias", async () => {
  const agentId = "main";
  const sessionId = "session-shared-alias";
  const sessionKey = "agent:main:alias-a";
  const aliasSessionKey = "agent:main:alias-b";
  const backendRunId = "run-alias-a-backend";
  const clientRunId = "run-alias-a-client";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const storePath = path.join(requireStateDir(), "agents", agentId, "sessions", "sessions.json");
  const claimId = "claim-alias-a";
  await replaceSessionEntry({ agentId, sessionKey, storePath }, {
    sessionId,
    updatedAt: 100,
    status: "running",
    abortedLastRun: true,
    restartRecoveryRuns: [{ runId: backendRunId, lifecycleGeneration }],
    mainRestartRecovery: {
      cycleId: "cycle-alias-a",
      revision: 2,
      chargedAttempts: 1,
      foregroundClaims: {
        lifecycleGeneration,
        tokens: [claimId],
        runIdsByClaimId: { [claimId]: backendRunId },
      },
    },
  } as InternalSessionEntry);
  const activeRun = createActiveRun(sessionKey, { agentId, sessionId });
  const operation = replyRunRegistry.begin({
    sessionKey,
    sessionId,
    resetTriggered: false,
    upstreamAbortSignal: activeRun.controller.signal,
  });
  operation.attachBackend({ kind: "embedded", runId: backendRunId, cancel: () => {} });
  operation.setPhase("running");
  setReplyRecoveryOwner(operation, {
    cycleId: "cycle-alias-a",
    lifecycleGeneration,
    claimId,
    sessionId,
    sessionKey,
    storePath,
    runId: backendRunId,
  });
  const aliasOperation = replyRunRegistry.begin({
    sessionKey: aliasSessionKey,
    sessionId,
    resetTriggered: false,
  });
  const chatAbortContext = createChatAbortContext({
    chatAbortControllers: new Map([[clientRunId, activeRun]]),
  });
  const { getRuntimeConfig: _getRuntimeConfig, ...abortContext } = chatAbortContext;
  abortContext.chatRunState.registry.add(backendRunId, {
    clientRunId,
    sessionKey,
    agentId,
  });

  const result = await directSessionReq(
    "sessions.abort",
    { key: sessionKey, runId: clientRunId },
    { context: abortContext },
  );

  expect(result).toMatchObject({
    ok: true,
    payload: { ok: true, abortedRunId: clientRunId, status: "aborted" },
  });
  expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
  expect(aliasOperation.result).toBeNull();
  expect(loadSessionEntry({ agentId, sessionKey, storePath })).toMatchObject({
    status: "killed",
    restartRecoveryTerminalRunIds: [backendRunId],
  });
  operation.complete();
  aliasOperation.complete();
});

test("chat.abort terminalizes a recovery owner through the shared abort barrier", async () => {
  const agentId = "main";
  const sessionKey = "agent:main:direct-chat-abort-recovery";
  const sessionId = "session-direct-chat-abort-recovery";
  const backendRunId = "run-direct-chat-backend";
  const clientRunId = "run-direct-chat-client";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const storePath = path.join(requireStateDir(), "agents", agentId, "sessions", "sessions.json");
  const claimId = "claim-direct-chat-abort";
  await replaceSessionEntry({ agentId, sessionKey, storePath }, {
    sessionId,
    updatedAt: 100,
    status: "running",
    abortedLastRun: true,
    restartRecoveryRuns: [{ runId: backendRunId, lifecycleGeneration }],
    mainRestartRecovery: {
      cycleId: "cycle-direct-chat-abort",
      revision: 2,
      chargedAttempts: 1,
      foregroundClaims: {
        lifecycleGeneration,
        tokens: [claimId],
        runIdsByClaimId: { [claimId]: backendRunId },
      },
    },
  } as InternalSessionEntry);
  const activeRun = createActiveRun(sessionKey, { agentId, sessionId });
  const operation = replyRunRegistry.begin({
    sessionKey,
    sessionId,
    resetTriggered: false,
    upstreamAbortSignal: activeRun.controller.signal,
  });
  operation.attachBackend({ kind: "embedded", runId: backendRunId, cancel: () => {} });
  operation.setPhase("running");
  setReplyRecoveryOwner(operation, {
    cycleId: "cycle-direct-chat-abort",
    lifecycleGeneration,
    claimId,
    sessionId,
    sessionKey,
    storePath,
    runId: backendRunId,
  });
  const context = createChatAbortContext({
    chatAbortControllers: new Map([[clientRunId, activeRun]]),
  });

  const respond = await invokeChatAbortHandler({
    handler: chatHandlers["chat.abort"]!,
    context,
    request: { sessionKey, runId: clientRunId },
  });

  expect(respond).toHaveBeenCalledWith(true, { ok: true, aborted: true, runIds: [clientRunId] });
  expect(loadSessionEntry({ agentId, sessionKey, storePath })).toMatchObject({
    status: "killed",
    restartRecoveryTerminalRunIds: [backendRunId],
  });
  operation.complete();
});

test.each([
  { method: "sessions.abort", exact: true },
  { method: "sessions.abort", exact: false },
  { method: "chat.abort", exact: true },
  { method: "chat.abort", exact: false },
] as const)(
  "$method ignores a cleared reply operation for an $exact exact target",
  async ({ method, exact }) => {
    const agentId = "main";
    const sessionKey = "agent:main:force-cleared-recovery";
    const sessionId = "session-force-cleared-recovery";
    const backendRunId = "run-force-cleared-backend";
    const clientRunId = "run-force-cleared-client";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const storePath = path.join(requireStateDir(), "agents", agentId, "sessions", "sessions.json");
    const claimId = "claim-force-cleared";
    await replaceSessionEntry({ agentId, sessionKey, storePath }, {
      sessionId,
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
      restartRecoveryRuns: [{ runId: backendRunId, lifecycleGeneration }],
      mainRestartRecovery: {
        cycleId: "cycle-force-cleared",
        revision: 2,
        chargedAttempts: 1,
        foregroundClaims: {
          lifecycleGeneration,
          tokens: [claimId],
          runIdsByClaimId: { [claimId]: backendRunId },
        },
      },
    } as InternalSessionEntry);
    setActiveEmbeddedRun(sessionId, createEmbeddedRunHandle({ runId: backendRunId }), sessionKey);
    embeddedRunMock.activeIds.add(sessionId);
    const activeRun = Object.assign(createActiveRun(sessionKey, { agentId, sessionId }), {
      isAbortable: () => isReplyRunAbortableForSignal(activeRun.controller.signal),
    });
    const operation = replyRunRegistry.begin({
      sessionKey,
      sessionId,
      resetTriggered: false,
      upstreamAbortSignal: activeRun.controller.signal,
    });
    operation.attachBackend({ kind: "embedded", runId: backendRunId, cancel: () => {} });
    operation.setPhase("running");
    const recoveryOwner = {
      cycleId: "cycle-force-cleared",
      lifecycleGeneration,
      claimId,
      sessionId,
      sessionKey,
      storePath,
      runId: backendRunId,
    };
    setReplyRecoveryOwner(operation, recoveryOwner);

    expect(forceClearReplyOperation(operation, new Error("terminal completion timed out"))).toBe(
      true,
    );
    await releaseMainSessionRecoveryOwner(recoveryOwner);
    clearReplyRecoveryOwner(operation, recoveryOwner);
    const successor = replyRunRegistry.begin({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });

    const chatAbortContext = createChatAbortContext({
      chatAbortControllers: new Map([[clientRunId, activeRun]]),
    });
    const { getRuntimeConfig: _getRuntimeConfig, ...abortContext } = chatAbortContext;
    abortContext.chatRunState.registry.add(backendRunId, {
      clientRunId,
      sessionKey,
      agentId,
    });

    if (method === "sessions.abort") {
      const result = await directSessionReq(
        method,
        { key: sessionKey, ...(exact ? { runId: clientRunId } : {}) },
        { context: abortContext },
      );
      expect(result).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          abortedRunId: exact ? clientRunId : null,
          status: "aborted",
        },
      });
    } else {
      const respond = await invokeChatAbortHandler({
        handler: chatHandlers[method]!,
        context: chatAbortContext,
        request: { sessionKey, ...(exact ? { runId: clientRunId } : {}) },
      });
      expect(respond).toHaveBeenCalledWith(true, {
        ok: true,
        aborted: true,
        runIds: [clientRunId],
      });
    }
    expect(loadSessionEntry({ agentId, sessionKey, storePath })).toMatchObject({
      status: "killed",
      restartRecoveryTerminalRunIds: [backendRunId],
    });
    expect(embeddedRunMock.abortCalls).toEqual([sessionId]);
    expect(successor.result).toBeNull();
    successor.complete();
  },
);
