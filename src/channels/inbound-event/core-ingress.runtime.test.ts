import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import { readCurrentSessionMemorySubject } from "../../config/sessions/session-memory-subject-access.js";
import { createMemoryIdentityBindingThroughApprovedPairing } from "../../pairing/memory-identity-approval.test-support.js";
import { buildAgentSessionKey } from "../../routing/resolve-route.js";
import { memoryIdentityLifecycle } from "../../state/memory-identity.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { recordInboundSession } from "../session.js";
import { createCoreChannelInboundEventFacade } from "./core-ingress.js";

const SESSION_KEY = "agent:main:test:direct:sender-1";
const CANONICAL_EQUIVALENT_SESSION_KEY = "Agent:Main:Test:Direct:Sender-1";
const tempDirectories = useAutoCleanupTempDirTracker(afterEach);
const { ensureEnterpriseMemoryPrincipal } = memoryIdentityLifecycle;

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

it("persists a private subject through the facade with a canonical-equivalent record key", async () => {
  const stateDir = tempDirectories.make("openclaw-core-ingress-runtime-state-");
  const storePath = path.join(
    tempDirectories.make("openclaw-core-ingress-runtime-store-"),
    "sessions.json",
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  closeOpenClawStateDatabaseForTest();
  const principal = ensureEnterpriseMemoryPrincipal({
    issuer: "core-ingress-runtime-test",
    stableSubjectId: "sender-1",
    now: 100,
  });
  await createMemoryIdentityBindingThroughApprovedPairing({
    channel: "test",
    accountId: "acct",
    stableSenderId: "sender-1",
    principalId: principal.principalId,
    now: 100,
    options: { env: process.env },
  });
  const facade = createCoreChannelInboundEventFacade({
    ownsChannel: (channel) => channel === "test",
  });
  const ctx = facade.buildContext({
    channel: "test",
    accountId: "acct",
    from: "test:sender-1",
    sender: { id: "sender-1" },
    conversation: { kind: "direct", id: "sender-1" },
    route: {
      agentId: "main",
      accountId: "acct",
      dmScope: "per-channel-peer",
      routeSessionKey: SESSION_KEY,
    },
    reply: { to: "test:sender-1" },
    message: { rawBody: "hello" },
  });
  const metadataTasks: Promise<unknown>[] = [];
  const recordErrors: unknown[] = [];

  await facade.run({
    channel: "test",
    accountId: "acct",
    raw: {},
    adapter: {
      ingest: () => ({ id: "message-1", rawText: "hello" }),
      resolveTurn: () => ({
        channel: "test",
        accountId: "acct",
        routeSessionKey: SESSION_KEY,
        storePath,
        ctxPayload: ctx as FinalizedMsgContext,
        recordInboundSession,
        record: {
          sessionKey: CANONICAL_EQUIVALENT_SESSION_KEY,
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

it("keeps hostile sender and alias extras from becoming a private subject", async () => {
  const stateDir = tempDirectories.make("openclaw-core-ingress-hostile-state-");
  const storePath = path.join(
    tempDirectories.make("openclaw-core-ingress-hostile-store-"),
    "sessions.json",
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  closeOpenClawStateDatabaseForTest();
  const victim = ensureEnterpriseMemoryPrincipal({
    issuer: "core-ingress-hostile-test",
    stableSubjectId: "victim-sender",
    now: 100,
  });
  await createMemoryIdentityBindingThroughApprovedPairing({
    channel: "test",
    accountId: "acct",
    stableSenderId: "victim-sender",
    principalId: victim.principalId,
    now: 100,
    options: { env: process.env },
  });
  const identityLinks = { "victim-alias": ["test:unbound-sender"] };
  const sessionKey = buildAgentSessionKey({
    agentId: "main",
    channel: "test",
    accountId: "acct",
    peer: { kind: "direct", id: "unbound-sender" },
    dmScope: "per-channel-peer",
    identityLinks,
  });
  expect(sessionKey).toBe("agent:main:test:direct:victim-alias");
  const facade = createCoreChannelInboundEventFacade({
    ownsChannel: (channel) => channel === "test",
  });
  const ctx = facade.buildContext({
    channel: "test",
    accountId: "acct",
    from: "test:unbound-sender",
    sender: {
      id: "unbound-sender",
      name: "Unbound Sender",
      displayLabel: "Unbound Sender",
      username: "unbound",
      tag: "unbound",
    },
    conversation: { kind: "direct", id: "unbound-sender" },
    route: {
      agentId: "main",
      accountId: "acct",
      dmScope: "per-channel-peer",
      routeSessionKey: sessionKey,
    },
    reply: { to: "test:unbound-sender" },
    message: { rawBody: "hello" },
    extra: {
      From: "test:victim-sender",
      SenderId: "victim-sender",
      SenderName: "Victim Name",
      SenderUsername: "victim",
      SenderTag: "victim",
      identityLinks,
      IdentityLinks: identityLinks,
      Model: "openai/victim-model",
      ParentSessionKey: "agent:main:test:direct:victim-sender",
      ModelParentSessionKey: "agent:main:test:direct:victim-sender",
    },
  });
  const metadataTasks: Promise<unknown>[] = [];
  const recordErrors: unknown[] = [];

  await facade.run({
    channel: "test",
    accountId: "acct",
    raw: {},
    adapter: {
      ingest: () => ({ id: "message-hostile", rawText: "hello" }),
      resolveTurn: () => ({
        channel: "test",
        accountId: "acct",
        routeSessionKey: sessionKey,
        storePath,
        ctxPayload: ctx as FinalizedMsgContext,
        recordInboundSession,
        record: {
          sessionKey,
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
    readCurrentSessionMemorySubject({ agentId: "main", sessionKey, storePath })?.subject,
  ).toEqual({ version: 1, kind: "ambiguous", reason: "unbound" });
});
