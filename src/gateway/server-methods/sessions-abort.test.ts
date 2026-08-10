import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { setActiveEmbeddedRun } from "../../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing as embeddedRunsTesting,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { setReplyRecoveryOwner } from "../../auto-reply/reply/reply-recovery-owner.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import type { InternalSessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenClawRegisteredAgentDatabases,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChatRunState } from "../server-chat-state.js";
import { embeddedRunMock, testState } from "../test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import { createActiveRun, createChatAbortContext } from "./chat.abort.test-helpers.js";

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

async function configureFixedSessionStore(label = "default"): Promise<string> {
  const storePath = path.join(requireStateDir(), `shared-abort-sessions-${label}`, "sessions.json");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, "{}\n", "utf8");
  testState.sessionStorePath = storePath;
  testState.agentsConfig = { list: [{ id: "main", default: true }] };
  const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  expect(getRuntimeConfig().session?.store).toBe(storePath);
  return storePath;
}

test("sessions.abort rejects an unknown agent without provisioning its store", async () => {
  const result = await directSessionReq("sessions.abort", { key: "agent:ghost:zzz" });

  expect(result).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: 'agent "ghost" not found' },
  });
  const env = { OPENCLAW_STATE_DIR: requireStateDir() };
  expect(fs.existsSync(path.join(env.OPENCLAW_STATE_DIR, "agents", "ghost"))).toBe(false);
  expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId: "ghost", env }))).toBe(false);
  expect(listOpenClawRegisteredAgentDatabases({ env }).map((entry) => entry.agentId)).not.toContain(
    "ghost",
  );
});

test("sessions.abort aborts a pre-existing session after its agent is removed from config", async () => {
  const agentId = "retired";
  const sessionKey = `agent:${agentId}:existing`;
  const sessionId = "session-retired";
  const runId = "run-retired";
  const storePath = path.join(requireStateDir(), "agents", agentId, "sessions", "sessions.json");
  await replaceSessionEntry({ agentId, sessionKey, storePath }, { sessionId, updatedAt: 42 });
  const activeRun = createActiveRun(sessionKey, { agentId, sessionId });
  const { getRuntimeConfig: _getRuntimeConfig, ...abortContext } = createChatAbortContext({
    chatAbortControllers: new Map([[runId, activeRun]]),
  });

  const result = await directSessionReq(
    "sessions.abort",
    { key: sessionKey },
    {
      context: abortContext,
    },
  );

  expect(result).toMatchObject({
    ok: true,
    payload: { ok: true, abortedRunId: runId, status: "aborted" },
  });
  expect(activeRun.controller.signal.aborted).toBe(true);
});

test("sessions.abort aborts an exact active run for an unconfigured agent without a store", async () => {
  const agentId = "active-only";
  const sessionKey = `agent:${agentId}:running`;
  const runId = "run-active-only";
  const activeRun = createActiveRun(sessionKey, { agentId });
  const { getRuntimeConfig: _getRuntimeConfig, ...abortContext } = createChatAbortContext({
    chatAbortControllers: new Map([[runId, activeRun]]),
  });

  const result = await directSessionReq(
    "sessions.abort",
    { key: sessionKey },
    { context: abortContext },
  );

  expect(result).toMatchObject({
    ok: true,
    payload: { ok: true, abortedRunId: runId, status: "aborted" },
  });
  expect(activeRun.controller.signal.aborted).toBe(true);
  const env = { OPENCLAW_STATE_DIR: requireStateDir() };
  expect(fs.existsSync(path.join(env.OPENCLAW_STATE_DIR, "agents", agentId))).toBe(false);
  expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId, env }))).toBe(false);
  expect(listOpenClawRegisteredAgentDatabases({ env }).map((entry) => entry.agentId)).not.toContain(
    agentId,
  );
});

test("sessions.abort rejects an unknown agent when only the fixed store file exists", async () => {
  const storePath = await configureFixedSessionStore();

  const result = await directSessionReq("sessions.abort", { key: "agent:ghost:missing" });

  expect(result).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: 'agent "ghost" not found' },
  });
  const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, {
    agentId: "ghost",
  }).path;
  expect(sqlitePath).toBeDefined();
  expect(fs.existsSync(sqlitePath!)).toBe(false);
});

test("sessions.abort aborts an unconfigured agent with rows in a fixed store", async () => {
  const storePath = await configureFixedSessionStore();
  const agentId = "retired";
  const sessionKey = `agent:${agentId}:existing`;
  const sessionId = "session-retired-fixed";
  const runId = "run-retired-fixed";
  await replaceSessionEntry({ agentId, sessionKey, storePath }, { sessionId, updatedAt: 42 });
  const activeRun = createActiveRun(sessionKey, { agentId, sessionId });
  const { getRuntimeConfig: _getRuntimeConfig, ...abortContext } = createChatAbortContext({
    chatAbortControllers: new Map([[runId, activeRun]]),
  });

  const result = await directSessionReq(
    "sessions.abort",
    { key: sessionKey },
    { context: abortContext },
  );

  expect(result).toMatchObject({
    ok: true,
    payload: { ok: true, abortedRunId: runId, status: "aborted" },
  });
  expect(activeRun.controller.signal.aborted).toBe(true);
});

test("sessions.abort rejects an unconfigured agent found only in a fixed legacy store", async () => {
  const storePath = await configureFixedSessionStore("legacy");
  const sessionKey = "agent:retired:legacy";
  fs.writeFileSync(
    storePath,
    JSON.stringify({ [sessionKey]: { sessionId: "session-retired-legacy", updatedAt: 42 } }),
    "utf8",
  );

  const result = await directSessionReq("sessions.abort", { key: sessionKey });

  expect(result).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: 'agent "retired" not found' },
  });
  const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, {
    agentId: "retired",
  }).path;
  expect(sqlitePath).toBeDefined();
  expect(fs.existsSync(sqlitePath!)).toBe(false);
});

test("sessions.abort finds a retired store only reachable through its deterministic template", async () => {
  const agentId = "template-retired";
  const sessionKey = `agent:${agentId}:existing`;
  const sessionId = "session-template-retired";
  const runId = "run-template-retired";
  const storeTemplate = path.join(
    requireStateDir(),
    "external-abort-stores",
    "sessions-{agentId}.json",
  );
  const storePath = storeTemplate.replace("{agentId}", agentId);
  testState.sessionStorePath = storeTemplate;
  testState.agentsConfig = { list: [{ id: "main", default: true }] };
  const { clearConfigCache, clearRuntimeConfigSnapshot } = await getGatewayConfigModule();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  await replaceSessionEntry({ agentId, sessionKey, storePath }, { sessionId, updatedAt: 42 });
  const activeRun = createActiveRun(sessionKey, { agentId, sessionId });
  const { getRuntimeConfig: _getRuntimeConfig, ...abortContext } = createChatAbortContext({
    chatAbortControllers: new Map([[runId, activeRun]]),
  });

  const result = await directSessionReq(
    "sessions.abort",
    { key: sessionKey },
    { context: abortContext },
  );

  expect(result).toMatchObject({
    ok: true,
    payload: { ok: true, abortedRunId: runId, status: "aborted" },
  });
  expect(activeRun.controller.signal.aborted).toBe(true);
});

test.each(["main", "work"])("sessions.abort still resolves the %s agent store", async (agentId) => {
  const result = await directSessionReq("sessions.abort", {
    key: `agent:${agentId}:missing`,
  });

  expect(result).toMatchObject({
    ok: true,
    payload: { ok: true, abortedRunId: null, status: "no-active-run" },
  });
  expect(
    fs.existsSync(
      resolveOpenClawAgentSqlitePath({
        agentId,
        env: { OPENCLAW_STATE_DIR: requireStateDir() },
      }),
    ),
  ).toBe(true);
});

test("sessions.abort terminalizes a controller-less recovery run after its reply operation clears", async () => {
  const agentId = "main";
  const sessionKey = "agent:main:openclaw-weixin:direct:recovery-run";
  const sessionId = "session-controller-less-recovery";
  const runId = "run-controller-less-recovery";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const storePath = path.join(requireStateDir(), "agents", agentId, "sessions", "sessions.json");
  const recoveryEntry: InternalSessionEntry = {
    sessionId,
    updatedAt: 100,
    status: "running",
    abortedLastRun: true,
    restartRecoveryRuns: [{ runId, lifecycleGeneration }],
    mainRestartRecovery: {
      cycleId: "cycle-controller-less-recovery",
      revision: 2,
      chargedAttempts: 1,
    },
  };
  await replaceSessionEntry({ agentId, sessionKey, storePath }, recoveryEntry);
  setActiveEmbeddedRun(sessionId, createEmbeddedRunHandle({ runId }), sessionKey);
  embeddedRunMock.activeIds.add(sessionId);

  const result = await directSessionReq(
    "sessions.abort",
    { key: sessionKey },
    { context: { chatRunState: createChatRunState() } },
  );

  expect(result).toMatchObject({
    ok: true,
    payload: { ok: true, abortedRunId: null, status: "aborted" },
  });
  expect(embeddedRunMock.abortCalls).toEqual([sessionId]);
  expect(loadSessionEntry({ agentId, sessionKey, storePath })).toMatchObject({
    sessionId,
    lifecycleRunId: runId,
    status: "killed",
    abortedLastRun: true,
    restartRecoveryTerminalRunIds: [runId],
  });
  expect(loadSessionEntry({ agentId, sessionKey, storePath })?.restartRecoveryRuns).toBeUndefined();
  expect(
    (loadSessionEntry({ agentId, sessionKey, storePath }) as InternalSessionEntry | undefined)
      ?.mainRestartRecovery,
  ).toBeUndefined();
});

test.each([
  {
    label: "client run id",
    requestedRunId: "client",
    includeKey: true,
    attachBackend: true,
  },
  {
    label: "backend run id",
    requestedRunId: "backend",
    includeKey: true,
    attachBackend: true,
  },
  {
    label: "backend run id without a key",
    requestedRunId: "backend",
    includeKey: false,
    attachBackend: true,
  },
  {
    label: "client run id before backend attachment",
    requestedRunId: "client",
    includeKey: true,
    attachBackend: false,
  },
])("sessions.abort terminalizes the recovery owner for an exact $label", async (scenario) => {
  const agentId = "main";
  const sessionKey = "agent:main:openclaw-weixin:direct:exact-recovery-run";
  const sessionId = "session-exact-recovery";
  const backendRunId = "run-exact-recovery-backend";
  const clientRunId = "run-exact-recovery-client";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const storePath = path.join(requireStateDir(), "agents", agentId, "sessions", "sessions.json");
  const claimId = "claim-exact-recovery";
  await replaceSessionEntry({ agentId, sessionKey, storePath }, {
    sessionId,
    updatedAt: 100,
    status: "running",
    abortedLastRun: true,
    restartRecoveryRuns: [{ runId: backendRunId, lifecycleGeneration }],
    mainRestartRecovery: {
      cycleId: "cycle-exact-recovery",
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
  if (scenario.attachBackend) {
    operation.attachBackend({
      kind: "embedded",
      runId: backendRunId,
      cancel: () => {},
    });
  }
  operation.setPhase("running");
  setReplyRecoveryOwner(operation, {
    cycleId: "cycle-exact-recovery",
    lifecycleGeneration,
    claimId,
    sessionId,
    sessionKey,
    storePath,
    runId: backendRunId,
  });
  const { getRuntimeConfig: _getRuntimeConfig, ...abortContext } = createChatAbortContext({
    chatAbortControllers: new Map([[clientRunId, activeRun]]),
  });
  abortContext.chatRunState.registry.add(backendRunId, {
    clientRunId,
    sessionKey,
    agentId,
  });

  const result = await directSessionReq(
    "sessions.abort",
    {
      ...(scenario.includeKey ? { key: sessionKey } : {}),
      runId: scenario.requestedRunId === "backend" ? backendRunId : clientRunId,
    },
    { context: abortContext },
  );

  expect(result).toMatchObject({
    ok: true,
    payload: { ok: true, abortedRunId: clientRunId, status: "aborted" },
  });
  expect(loadSessionEntry({ agentId, sessionKey, storePath })).toMatchObject({
    sessionId,
    lifecycleRunId: backendRunId,
    status: "killed",
    abortedLastRun: true,
    restartRecoveryTerminalRunIds: [backendRunId],
  });
  operation.complete();
});

test("sessions.abort does not terminalize controller-less recovery for an unauthorized owner", async () => {
  const agentId = "main";
  const sessionKey = "agent:main:openclaw-weixin:direct:protected-recovery-run";
  const sessionId = "session-protected-recovery";
  const runId = "run-protected-recovery";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const storePath = path.join(requireStateDir(), "agents", agentId, "sessions", "sessions.json");
  const pendingEntry: InternalSessionEntry = {
    sessionId,
    updatedAt: 100,
    status: "running" as const,
    abortedLastRun: true,
    restartRecoveryRuns: [{ runId, lifecycleGeneration }],
    mainRestartRecovery: {
      cycleId: "cycle-protected-recovery",
      revision: 2,
      chargedAttempts: 1,
    },
  };
  await replaceSessionEntry({ agentId, sessionKey, storePath }, pendingEntry);
  setActiveEmbeddedRun(sessionId, createEmbeddedRunHandle({ runId }), sessionKey);
  embeddedRunMock.activeIds.add(sessionId);
  const protectedRun = createActiveRun(sessionKey, {
    owner: { connId: "conn-owner", deviceId: "device-owner" },
  });
  const { getRuntimeConfig: _getRuntimeConfig, ...abortContext } = createChatAbortContext({
    chatAbortControllers: new Map([["protected-visible-run", protectedRun]]),
  });

  const result = await directSessionReq(
    "sessions.abort",
    { key: sessionKey },
    {
      context: abortContext,
      client: {
        connId: "conn-other",
        connect: {
          device: { id: "device-other" },
          scopes: ["operator.write"],
        },
      } as never,
    },
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: "unauthorized" },
  });
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(loadSessionEntry({ agentId, sessionKey, storePath })).toMatchObject(pendingEntry);
});
