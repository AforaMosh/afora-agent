import path from "node:path";
import {
  buildChannelInboundEventContext,
  runChannelInboundEvent,
} from "openclaw/plugin-sdk/channel-inbound";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { afterEach, expect, it, vi } from "vitest";
import type { FinalizedMsgContext } from "../../../src/auto-reply/templating.js";
import { createCoreChannelInboundEventFacade } from "../../../src/channels/inbound-event/core-ingress.js";
import { readCurrentSessionMemorySubject } from "../../../src/config/sessions/session-memory-subject-access.js";
import { createMemoryIdentityBindingThroughApprovedPairing } from "../../../src/pairing/memory-identity-approval.test-support.js";
import { memoryIdentityLifecycle } from "../../../src/state/memory-identity.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../src/state/openclaw-state-db.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

const SESSION_KEY = "agent:main:telegram:direct:telegram-user-42";
const COMMAND_SESSION_KEY = "agent:main:telegram:slash:telegram-user-42";
const COMMAND_TARGET_SESSION_KEY = "agent:main:telegram:direct:telegram-user-42";
const tempDirectories = useAutoCleanupTempDirTracker(afterEach);
const { ensureEnterpriseMemoryPrincipal } = memoryIdentityLifecycle;

afterEach(() => {
  clearTelegramRuntimeForTest();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

it("falls back to the SDK ingress functions when a partial runtime has no inbound facade", () => {
  setTelegramRuntime({ channel: {} } as TelegramRuntime);

  expect(defaultTelegramBotDeps.buildChannelInboundEventContext).toBe(
    buildChannelInboundEventContext,
  );
  expect(defaultTelegramBotDeps.runChannelInboundEvent).toBe(runChannelInboundEvent);
});

it("uses the trusted Telegram inbound facade to persist an approved direct-message subject", async () => {
  const stateDir = tempDirectories.make("openclaw-telegram-inbound-facade-state-");
  const storePath = path.join(
    tempDirectories.make("openclaw-telegram-inbound-facade-store-"),
    "sessions.json",
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  closeOpenClawStateDatabaseForTest();
  const principal = ensureEnterpriseMemoryPrincipal({
    issuer: "telegram-inbound-facade-test",
    stableSubjectId: "telegram-user-42",
    now: 100,
  });
  await createMemoryIdentityBindingThroughApprovedPairing({
    channel: "telegram",
    accountId: "acct",
    stableSenderId: "telegram-user-42",
    principalId: principal.principalId,
    now: 100,
    options: { env: process.env },
  });
  const inbound = createCoreChannelInboundEventFacade({
    ownsChannel: (channel) => channel === "telegram",
  });
  setTelegramRuntime({ channel: { inbound } } as TelegramRuntime);

  expect(defaultTelegramBotDeps.buildChannelInboundEventContext).toBe(inbound.buildContext);
  expect(defaultTelegramBotDeps.runChannelInboundEvent).toBe(inbound.run);

  const ctx = await defaultTelegramBotDeps.buildChannelInboundEventContext!({
    channel: "telegram",
    accountId: "acct",
    from: "telegram:telegram-user-42",
    sender: { id: "telegram-user-42" },
    conversation: { kind: "direct", id: "telegram-user-42" },
    route: {
      agentId: "main",
      accountId: "acct",
      dmScope: "per-channel-peer",
      routeSessionKey: SESSION_KEY,
    },
    reply: { to: "telegram:telegram-user-42" },
    message: { rawBody: "hello" },
  });
  const metadataTasks: Promise<unknown>[] = [];
  const recordErrors: unknown[] = [];

  await defaultTelegramBotDeps.runChannelInboundEvent({
    channel: "telegram",
    accountId: "acct",
    raw: {},
    adapter: {
      ingest: () => ({ id: "telegram-message-1", rawText: "hello" }),
      resolveTurn: () => ({
        channel: "telegram",
        accountId: "acct",
        routeSessionKey: SESSION_KEY,
        storePath,
        ctxPayload: ctx as FinalizedMsgContext,
        recordInboundSession,
        record: {
          sessionKey: SESSION_KEY,
          onRecordError: (error) => {
            recordErrors.push(error);
          },
          trackSessionMetaTask: (task) => {
            metadataTasks.push(task);
          },
        },
        runDispatch: async () => ({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } }),
        runDispatchLifecycle: {
          turnAdoptionLifecycle: undefined,
          onDispatchSkipped: async () => undefined,
        },
      }),
    },
  });

  await Promise.all(metadataTasks);

  expect(recordErrors).toEqual([]);
  expect(metadataTasks).toHaveLength(1);
  expect(
    readCurrentSessionMemorySubject({ agentId: "main", sessionKey: SESSION_KEY, storePath })
      ?.subject,
  ).toMatchObject({ kind: "user", principalId: principal.principalId });
});

it("keeps a split-key native-command target unbound through public ingress", async () => {
  const stateDir = tempDirectories.make("openclaw-telegram-native-command-state-");
  const storePath = path.join(
    tempDirectories.make("openclaw-telegram-native-command-store-"),
    "sessions.json",
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  closeOpenClawStateDatabaseForTest();
  const principal = ensureEnterpriseMemoryPrincipal({
    issuer: "telegram-native-command-test",
    stableSubjectId: "telegram-user-42",
    now: 100,
  });
  await createMemoryIdentityBindingThroughApprovedPairing({
    channel: "telegram",
    accountId: "acct",
    stableSenderId: "telegram-user-42",
    principalId: principal.principalId,
    now: 100,
    options: { env: process.env },
  });
  const ctx = finalizeInboundContext({
    Body: "/status",
    BodyForAgent: "/status",
    RawBody: "/status",
    CommandBody: "/status",
    From: "telegram:telegram-user-42",
    To: "slash:telegram-user-42",
    ChatType: "direct",
    SenderId: "telegram-user-42",
    Surface: "telegram",
    Provider: "telegram",
    OriginatingChannel: "telegram",
    AccountId: "acct",
    AgentId: "main",
    SessionKey: COMMAND_SESSION_KEY,
    CommandTargetSessionKey: COMMAND_TARGET_SESSION_KEY,
    CommandAuthorized: true,
    CommandTurn: {
      kind: "native",
      source: "native",
      authorized: true,
      body: "/status",
    },
    CommandSource: "native",
  });
  const metadataTasks: Promise<unknown>[] = [];
  const recordErrors: unknown[] = [];
  const recordedSessionKeys: string[] = [];
  const recordNativeCommandSession = async (
    params: Parameters<typeof recordInboundSession>[0],
  ): Promise<void> => {
    recordedSessionKeys.push(params.sessionKey);
    await recordInboundSession(params);
  };

  const result = await runChannelInboundEvent({
    channel: "telegram",
    accountId: "acct",
    raw: {},
    adapter: {
      ingest: () => ({ id: "telegram-native-command-1", rawText: "/status" }),
      resolveTurn: () => ({
        channel: "telegram",
        accountId: "acct",
        routeSessionKey: COMMAND_SESSION_KEY,
        storePath,
        ctxPayload: ctx as FinalizedMsgContext,
        recordInboundSession: recordNativeCommandSession,
        record: {
          sessionKey: COMMAND_TARGET_SESSION_KEY,
          onRecordError: (error) => {
            recordErrors.push(error);
          },
          trackSessionMetaTask: (task) => {
            metadataTasks.push(task);
          },
        },
        runDispatch: async () => ({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } }),
        runDispatchLifecycle: {
          turnAdoptionLifecycle: undefined,
          onDispatchSkipped: async () => undefined,
        },
      }),
    },
  });

  await Promise.all(metadataTasks);

  expect(result).toMatchObject({ dispatched: true, routeSessionKey: COMMAND_SESSION_KEY });
  expect(ctx).toMatchObject({
    SessionKey: COMMAND_SESSION_KEY,
    CommandTargetSessionKey: COMMAND_TARGET_SESSION_KEY,
    CommandTurn: { kind: "native", source: "native", authorized: true },
  });
  expect(recordedSessionKeys).toEqual([COMMAND_TARGET_SESSION_KEY]);
  expect(recordErrors).toEqual([]);
  expect(metadataTasks).toHaveLength(1);
  expect(
    readCurrentSessionMemorySubject({
      agentId: "main",
      sessionKey: COMMAND_TARGET_SESSION_KEY,
      storePath,
    })?.subject,
  ).toEqual({ version: 1, kind: "ambiguous", reason: "unbound" });
});
