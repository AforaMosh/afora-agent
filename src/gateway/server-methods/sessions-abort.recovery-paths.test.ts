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

async function createRecoveryWithSuccessorFixture(
  label: string,
  options: { successorOwnsRecovery?: boolean } = {},
) {
  const agentId = "main";
  const sessionKey = `agent:main:direct:${label}`;
  const sessionId = `session-${label}`;
  const recoveryBackendRunId = `run-${label}-recovery-backend`;
  const recoveryClientRunId = `run-${label}-recovery-client`;
  const successorBackendRunId = `run-${label}-successor-backend`;
  const successorClientRunId = `run-${label}-successor-client`;
  const successorClaimId = `claim-${label}-successor`;
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const storePath = path.join(requireStateDir(), "agents", agentId, "sessions", "sessions.json");
  const recoveryEntry: InternalSessionEntry = {
    sessionId,
    updatedAt: 100,
    status: "running",
    abortedLastRun: true,
    lifecycleRunId: recoveryBackendRunId,
    restartRecoveryRuns: [
      { runId: recoveryBackendRunId, lifecycleGeneration },
      ...(options.successorOwnsRecovery
        ? [{ runId: successorBackendRunId, lifecycleGeneration }]
        : []),
    ],
    mainRestartRecovery: {
      cycleId: `cycle-${label}`,
      revision: 2,
      chargedAttempts: 1,
      ...(options.successorOwnsRecovery
        ? {
            foregroundClaims: {
              lifecycleGeneration,
              tokens: [successorClaimId],
              runIdsByClaimId: { [successorClaimId]: successorBackendRunId },
            },
          }
        : {}),
    },
  };
  await replaceSessionEntry({ agentId, sessionKey, storePath }, recoveryEntry);
  setActiveEmbeddedRun(
    sessionId,
    createEmbeddedRunHandle({ runId: recoveryBackendRunId }),
    sessionKey,
  );
  embeddedRunMock.activeIds.add(sessionId);
  const successorRun = createActiveRun(sessionKey, { agentId, sessionId });
  const successorOperation = replyRunRegistry.begin({
    sessionKey,
    sessionId,
    resetTriggered: false,
    upstreamAbortSignal: successorRun.controller.signal,
  });
  successorOperation.attachBackend({
    kind: "embedded",
    runId: successorBackendRunId,
    cancel: () => {},
  });
  successorOperation.setPhase("running");
  const successorRecoveryOwner = options.successorOwnsRecovery
    ? {
        cycleId: `cycle-${label}`,
        lifecycleGeneration,
        claimId: successorClaimId,
        sessionId,
        sessionKey,
        storePath,
        runId: successorBackendRunId,
      }
    : undefined;
  if (successorRecoveryOwner) {
    setReplyRecoveryOwner(successorOperation, successorRecoveryOwner);
  }
  const chatAbortContext = createChatAbortContext({
    chatAbortControllers: new Map([[successorClientRunId, successorRun]]),
  });
  chatAbortContext.chatRunState.registry.add(recoveryBackendRunId, {
    clientRunId: recoveryClientRunId,
    sessionKey,
    agentId,
  });
  chatAbortContext.chatRunState.registry.add(successorBackendRunId, {
    clientRunId: successorClientRunId,
    sessionKey,
    agentId,
  });
  return {
    agentId,
    chatAbortContext,
    recoveryBackendRunId,
    recoveryClientRunId,
    recoveryEntry,
    sessionId,
    sessionKey,
    storePath,
    successorBackendRunId,
    successorClaimId,
    successorClientRunId,
    successorOperation,
    successorRecoveryOwner,
    successorRun,
  };
}

async function invokeExactAbort(params: {
  method: "chat.abort" | "sessions.abort";
  runId: string;
  sessionKey: string;
  context: ReturnType<typeof createChatAbortContext>;
}) {
  if (params.method === "chat.abort") {
    return await invokeChatAbortHandler({
      handler: chatHandlers["chat.abort"]!,
      context: params.context,
      request: { sessionKey: params.sessionKey, runId: params.runId },
    });
  }
  const { getRuntimeConfig: _getRuntimeConfig, ...context } = params.context;
  return await directSessionReq(
    "sessions.abort",
    { key: params.sessionKey, runId: params.runId },
    { context },
  );
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

test.each(["chat.abort", "sessions.abort"] as const)(
  "$method aborting a same-session successor leaves older recovery state untouched",
  async (method) => {
    const fixture = await createRecoveryWithSuccessorFixture(`${method}-successor-target`);

    const result = await invokeExactAbort({
      method,
      runId: fixture.successorClientRunId,
      sessionKey: fixture.sessionKey,
      context: fixture.chatAbortContext,
    });

    if (method === "chat.abort") {
      expect(result).toHaveBeenCalledWith(true, {
        ok: true,
        aborted: true,
        runIds: [fixture.successorClientRunId],
      });
    } else {
      expect(result).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          abortedRunId: fixture.successorClientRunId,
          status: "aborted",
        },
      });
    }
    expect(fixture.successorOperation.result).toEqual({
      kind: "aborted",
      code: "aborted_by_user",
    });
    expect(fixture.successorRun.controller.signal.aborted).toBe(true);
    expect(embeddedRunMock.abortCalls).toEqual([]);
    const entry = loadSessionEntry({
      agentId: fixture.agentId,
      sessionKey: fixture.sessionKey,
      storePath: fixture.storePath,
    });
    expect(entry).toMatchObject(fixture.recoveryEntry);
    expect(entry?.restartRecoveryTerminalRunIds).toBeUndefined();
    fixture.successorOperation.complete();
  },
);

test.each([
  { method: "chat.abort", target: "client" },
  { method: "chat.abort", target: "backend" },
  { method: "sessions.abort", target: "client" },
  { method: "sessions.abort", target: "backend" },
] as const)(
  "$method aborts an exact older recovery by $target id while a same-session successor stays active",
  async ({ method, target }) => {
    const fixture = await createRecoveryWithSuccessorFixture(
      `${method}-${target}-recovery-target`,
      { successorOwnsRecovery: true },
    );
    const requestedRunId =
      target === "backend" ? fixture.recoveryBackendRunId : fixture.recoveryClientRunId;

    const result = await invokeExactAbort({
      method,
      runId: requestedRunId,
      sessionKey: fixture.sessionKey,
      context: fixture.chatAbortContext,
    });

    if (method === "chat.abort") {
      expect(result).toHaveBeenCalledWith(true, {
        ok: true,
        aborted: true,
        runIds: [requestedRunId],
      });
    } else {
      expect(result).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          abortedRunId: fixture.recoveryClientRunId,
          status: "aborted",
        },
      });
    }
    expect(embeddedRunMock.abortCalls).toEqual([fixture.sessionId]);
    expect(fixture.successorOperation.result).toBeNull();
    expect(fixture.successorRun.controller.signal.aborted).toBe(false);
    expect(
      loadSessionEntry({
        agentId: fixture.agentId,
        sessionKey: fixture.sessionKey,
        storePath: fixture.storePath,
      }),
    ).toMatchObject({
      sessionId: fixture.sessionId,
      lifecycleRunId: fixture.successorBackendRunId,
      status: "running",
      restartRecoveryTerminalRunIds: [fixture.recoveryBackendRunId],
      restartRecoveryRuns: [
        {
          runId: fixture.successorBackendRunId,
          lifecycleGeneration: expect.any(String),
        },
      ],
      mainRestartRecovery: {
        foregroundClaims: {
          tokens: [fixture.successorClaimId],
          runIdsByClaimId: {
            [fixture.successorClaimId]: fixture.successorBackendRunId,
          },
        },
      },
    });
    if (fixture.successorRecoveryOwner) {
      clearReplyRecoveryOwner(fixture.successorOperation, fixture.successorRecoveryOwner);
    }
    fixture.successorOperation.complete();
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
