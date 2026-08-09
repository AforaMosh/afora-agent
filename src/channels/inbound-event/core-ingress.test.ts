import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import { recordInboundSessionMetaWithTrustedMemorySubject } from "../../config/sessions/session-accessor.entry-mutation.js";
import { readCurrentSessionMemorySubject } from "../../config/sessions/session-memory-subject-access.js";
import type { TrustedSessionMemorySubjectIssuer } from "../../config/sessions/session-memory-subject.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createMemoryIdentityBindingThroughApprovedPairing } from "../../pairing/memory-identity-approval.test-support.js";
import {
  buildChannelInboundEventContext,
  runChannelInboundEvent,
} from "../../plugin-sdk/channel-inbound.js";
import { memoryIdentityLifecycle } from "../../state/memory-identity.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { RecordInboundSession } from "../session.types.js";
import { dispatchChannelInboundTurn, runPreparedInboundReply } from "../turn/kernel.js";
import { createCoreChannelInboundEventFacade } from "./core-ingress.js";
import {
  attestCoreChannelInboundMemorySubjectContext,
  bindAttestedChannelInboundMemorySubject,
  getBoundChannelInboundMemorySubjectIssuer,
} from "./memory-subject-attestation.js";

const recordInboundSession = vi.hoisted(() => vi.fn<RecordInboundSession>(async () => undefined));
const dispatchRouted = vi.hoisted(() => vi.fn());

vi.mock("../session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session.js")>();
  return { ...actual, recordInboundSession };
});

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return { ...actual, dispatchInboundMessageWithRoutedChannelDispatcher: dispatchRouted };
});

const SESSION_KEY = "agent:main:test:direct:sender-1";
const OTHER_SESSION_KEY = "agent:main:test:direct:sender-2";
const CANONICAL_EQUIVALENT_SESSION_KEY = "Agent:Main:Test:Direct:Sender-1";
const tempDirectories = useAutoCleanupTempDirTracker(afterEach);
const { ensureEnterpriseMemoryPrincipal } = memoryIdentityLifecycle;

function createContextParams(overrides: Record<string, unknown> = {}) {
  return {
    channel: "test",
    accountId: "acct",
    from: "test:sender-1",
    sender: { id: "sender-1" },
    conversation: { kind: "direct" as const, id: "sender-1" },
    route: {
      agentId: "main",
      accountId: "acct",
      dmScope: "per-channel-peer" as const,
      routeSessionKey: SESSION_KEY,
    },
    reply: { to: "test:sender-1" },
    message: { rawBody: "hello" },
    ...overrides,
  };
}

function createPreparedTurn(
  ctxPayload: FinalizedMsgContext,
  options?: { recordSessionKey?: string; useSessionRecorder?: boolean },
) {
  return {
    channel: "test",
    accountId: "acct",
    routeSessionKey: SESSION_KEY,
    storePath: "/tmp/openclaw-core-ingress-test",
    ctxPayload,
    recordInboundSession: options?.useSessionRecorder
      ? recordInboundSession
      : async () => undefined,
    ...(options?.recordSessionKey ? { record: { sessionKey: options.recordSessionKey } } : {}),
    runDispatch: async () => ({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } }),
    runDispatchLifecycle: {
      turnAdoptionLifecycle: undefined,
      onDispatchSkipped: async () => undefined,
    },
  };
}

function createRoutedTurn(ctxPayload: FinalizedMsgContext) {
  return {
    cfg: {} as OpenClawConfig,
    channel: "test",
    accountId: "acct",
    route: {
      agentId: "main",
      dmScope: "per-channel-peer" as const,
      sessionKey: SESSION_KEY,
    },
    ctxPayload,
    delivery: { deliver: async () => ({ visibleReplySent: false }) },
  };
}

async function runPrepared(params: {
  ctxPayload: FinalizedMsgContext;
  run: (input: Parameters<typeof runChannelInboundEvent>[0]) => Promise<unknown>;
  recordSessionKey?: string;
  useSessionRecorder?: boolean;
}) {
  await params.run({
    channel: "test",
    accountId: "acct",
    raw: {},
    adapter: {
      ingest: () => ({ id: "message-1", rawText: "hello" }),
      resolveTurn: () =>
        createPreparedTurn(params.ctxPayload, {
          recordSessionKey: params.recordSessionKey,
          useSessionRecorder: params.useSessionRecorder,
        }),
    },
  });
}

describe("core channel inbound memory-subject ingress", () => {
  beforeEach(() => {
    recordInboundSession.mockReset();
    recordInboundSession.mockResolvedValue(undefined);
    dispatchRouted.mockReset();
    dispatchRouted.mockResolvedValue({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  it("keeps public SDK builder and runner calls unbound", async () => {
    const ctx = buildChannelInboundEventContext(createContextParams());

    await runPrepared({ ctxPayload: ctx, run: runChannelInboundEvent });

    expect(getBoundChannelInboundMemorySubjectIssuer(ctx, SESSION_KEY)).toBeUndefined();
  });

  it("keeps the public runtime-style builder unbound even when a trusted runner is used", async () => {
    const facade = createCoreChannelInboundEventFacade({
      ownsChannel: (channel) => channel === "test",
    });
    const ctx = buildChannelInboundEventContext(createContextParams());

    await runPrepared({ ctxPayload: ctx, run: facade.run });

    expect(getBoundChannelInboundMemorySubjectIssuer(ctx, SESSION_KEY)).toBeUndefined();
  });

  it("keeps a trusted builder unbound when it runs through the public SDK runner", async () => {
    const facade = createCoreChannelInboundEventFacade({
      ownsChannel: (channel) => channel === "test",
    });
    const ctx = facade.buildContext(createContextParams());

    await runPrepared({ ctxPayload: ctx, run: runChannelInboundEvent });

    expect(getBoundChannelInboundMemorySubjectIssuer(ctx, SESSION_KEY)).toBeUndefined();
  });

  it("issues only through the matching paired trusted facade", async () => {
    const facade = createCoreChannelInboundEventFacade({
      ownsChannel: (channel) => channel === "test",
    });
    const ctx = facade.buildContext(createContextParams());
    let issuer: TrustedSessionMemorySubjectIssuer | undefined;
    recordInboundSession.mockImplementation(async (params) => {
      issuer = getBoundChannelInboundMemorySubjectIssuer(
        params.ctx as FinalizedMsgContext,
        params.sessionKey,
      );
    });

    await runPrepared({ ctxPayload: ctx, run: facade.run, useSessionRecorder: true });

    expect(issuer).toBeDefined();
    expect(getBoundChannelInboundMemorySubjectIssuer(ctx, SESSION_KEY)).toBeUndefined();
  });

  it("pairs facade-built contexts with facade dispatch without promoting public dispatch", async () => {
    const facade = createCoreChannelInboundEventFacade({
      ownsChannel: (channel) => channel === "test",
    });
    const paired = facade.buildContext(createContextParams());
    const publicContext = buildChannelInboundEventContext(createContextParams());
    const directDispatchContext = facade.buildContext(createContextParams());
    const cloned = { ...facade.buildContext(createContextParams()) } as FinalizedMsgContext;
    const issuers: TrustedSessionMemorySubjectIssuer[] = [];
    recordInboundSession.mockImplementation(async (params) => {
      const issuer = getBoundChannelInboundMemorySubjectIssuer(
        params.ctx as FinalizedMsgContext,
        params.sessionKey,
      );
      if (issuer) {
        issuers.push(issuer);
      }
    });

    await facade.dispatch(createRoutedTurn(paired));
    await facade.dispatch(createRoutedTurn(publicContext));
    await dispatchChannelInboundTurn(createRoutedTurn(directDispatchContext));
    await facade.dispatch(createRoutedTurn(cloned));

    expect(issuers).toHaveLength(1);
    expect(getBoundChannelInboundMemorySubjectIssuer(paired, SESSION_KEY)).toBeUndefined();
    expect(getBoundChannelInboundMemorySubjectIssuer(publicContext, SESSION_KEY)).toBeUndefined();
    expect(
      getBoundChannelInboundMemorySubjectIssuer(directDispatchContext, SESSION_KEY),
    ).toBeUndefined();
    expect(getBoundChannelInboundMemorySubjectIssuer(cloned, SESSION_KEY)).toBeUndefined();
  });

  it("rejects a different facade, cloned context, and lookalike ingress", async () => {
    const first = createCoreChannelInboundEventFacade({
      ownsChannel: (channel) => channel === "test",
    });
    const second = createCoreChannelInboundEventFacade({
      ownsChannel: (channel) => channel === "test",
    });
    const firstContext = first.buildContext(createContextParams());
    const clonedContext = { ...firstContext } as FinalizedMsgContext;

    await runPrepared({ ctxPayload: firstContext, run: second.run });
    await runPrepared({ ctxPayload: clonedContext, run: first.run });
    attestCoreChannelInboundMemorySubjectContext({
      ctx: firstContext,
      ingress: Object.freeze({}),
      runChannel: "test",
    });
    await bindAttestedChannelInboundMemorySubject(firstContext, SESSION_KEY);

    expect(getBoundChannelInboundMemorySubjectIssuer(firstContext, SESSION_KEY)).toBeUndefined();
    expect(getBoundChannelInboundMemorySubjectIssuer(clonedContext, SESSION_KEY)).toBeUndefined();
  });

  it("rejects untrusted or wrong-channel facades", async () => {
    const untrusted = createCoreChannelInboundEventFacade({ ownsChannel: () => false });
    const wrongChannel = createCoreChannelInboundEventFacade({
      ownsChannel: (channel) => channel === "other",
    });
    const untrustedContext = untrusted.buildContext(createContextParams());
    const wrongChannelContext = wrongChannel.buildContext(createContextParams());

    await runPrepared({ ctxPayload: untrustedContext, run: untrusted.run });
    await runPrepared({ ctxPayload: wrongChannelContext, run: wrongChannel.run });

    expect(
      getBoundChannelInboundMemorySubjectIssuer(untrustedContext, SESSION_KEY),
    ).toBeUndefined();
    expect(
      getBoundChannelInboundMemorySubjectIssuer(wrongChannelContext, SESSION_KEY),
    ).toBeUndefined();
  });

  it("accepts a canonical record key but rejects a different final identity", async () => {
    const facade = createCoreChannelInboundEventFacade({
      ownsChannel: (channel) => channel === "test",
    });
    const equivalentKey = facade.buildContext(createContextParams());
    const changedAccount = facade.buildContext(
      createContextParams({ extra: { AccountId: "different-account" } }),
    );
    const changedScope = facade.buildContext(
      createContextParams({ extra: { DmScope: "per-peer" } }),
    );
    const changedKey = facade.buildContext(createContextParams());

    const issuers: TrustedSessionMemorySubjectIssuer[] = [];
    recordInboundSession.mockImplementation(async (params) => {
      const issuer = getBoundChannelInboundMemorySubjectIssuer(
        params.ctx as FinalizedMsgContext,
        params.sessionKey,
      );
      if (issuer) {
        issuers.push(issuer);
      }
    });

    await runPrepared({
      ctxPayload: equivalentKey,
      run: facade.run,
      recordSessionKey: CANONICAL_EQUIVALENT_SESSION_KEY,
      useSessionRecorder: true,
    });
    await runPrepared({ ctxPayload: changedAccount, run: facade.run, useSessionRecorder: true });
    await runPrepared({ ctxPayload: changedScope, run: facade.run, useSessionRecorder: true });
    await runPrepared({
      ctxPayload: changedKey,
      run: facade.run,
      recordSessionKey: OTHER_SESSION_KEY,
      useSessionRecorder: true,
    });

    expect(issuers).toHaveLength(1);
    expect(getBoundChannelInboundMemorySubjectIssuer(changedAccount, SESSION_KEY)).toBeUndefined();
    expect(getBoundChannelInboundMemorySubjectIssuer(changedScope, SESSION_KEY)).toBeUndefined();
    expect(getBoundChannelInboundMemorySubjectIssuer(changedKey, SESSION_KEY)).toBeUndefined();
  });

  it("maps either captured or finalized main DM scope to an ambiguous issuer", async () => {
    const facade = createCoreChannelInboundEventFacade({
      ownsChannel: (channel) => channel === "test",
    });
    const capturedMain = facade.buildContext(
      createContextParams({
        route: {
          agentId: "main",
          accountId: "acct",
          dmScope: "main",
          routeSessionKey: SESSION_KEY,
        },
      }),
    );
    const finalizedMain = facade.buildContext(createContextParams({ extra: { DmScope: "main" } }));
    const issuers: TrustedSessionMemorySubjectIssuer[] = [];
    recordInboundSession.mockImplementation(async (params) => {
      const issuer = getBoundChannelInboundMemorySubjectIssuer(
        params.ctx as FinalizedMsgContext,
        params.sessionKey,
      );
      if (issuer) {
        issuers.push(issuer);
      }
    });

    await runPrepared({ ctxPayload: capturedMain, run: facade.run, useSessionRecorder: true });
    await runPrepared({ ctxPayload: finalizedMain, run: facade.run, useSessionRecorder: true });

    expect(issuers).toHaveLength(2);
    expect(issuers.map((issuer) => issuer.issue().subject)).toEqual([
      { version: 1, kind: "ambiguous", reason: "shared-main" },
      { version: 1, kind: "ambiguous", reason: "shared-main" },
    ]);
  });

  it("rechecks facade liveness inside the real first-write transaction", async () => {
    const stateDir = tempDirectories.make("openclaw-core-ingress-state-");
    const storePath = path.join(
      tempDirectories.make("openclaw-core-ingress-store-"),
      "sessions.json",
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    closeOpenClawStateDatabaseForTest();
    const principal = ensureEnterpriseMemoryPrincipal({
      issuer: "core-ingress-test",
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
    let ownsChannel = true;
    const facade = createCoreChannelInboundEventFacade({
      ownsChannel: (channel) => ownsChannel && channel === "test",
    });
    const activeContext = facade.buildContext(createContextParams());
    const revokedSessionKey = "agent:main:test:direct:sender-2";
    const revokedContext = facade.buildContext(
      createContextParams({
        from: "test:sender-2",
        sender: { id: "sender-2" },
        conversation: { kind: "direct", id: "sender-2" },
        route: {
          agentId: "main",
          accountId: "acct",
          dmScope: "per-channel-peer",
          routeSessionKey: revokedSessionKey,
        },
        reply: { to: "test:sender-2" },
      }),
    );
    const issuers: TrustedSessionMemorySubjectIssuer[] = [];
    recordInboundSession.mockImplementation(async (params) => {
      const issuer = getBoundChannelInboundMemorySubjectIssuer(
        params.ctx as FinalizedMsgContext,
        params.sessionKey,
      );
      if (issuer) {
        issuers.push(issuer);
      }
    });

    await runPrepared({ ctxPayload: activeContext, run: facade.run, useSessionRecorder: true });
    const activeIssuer = issuers.at(0);
    if (!activeIssuer) {
      throw new Error("expected active facade issuer");
    }
    await recordInboundSessionMetaWithTrustedMemorySubject(
      { storePath, sessionKey: SESSION_KEY, ctx: activeContext },
      activeIssuer,
    );
    expect(
      readCurrentSessionMemorySubject({ agentId: "main", sessionKey: SESSION_KEY, storePath })
        ?.subject,
    ).toMatchObject({ kind: "user", principalId: principal.principalId });

    await runPrepared({ ctxPayload: revokedContext, run: facade.run, useSessionRecorder: true });
    const revokedIssuer = issuers.at(1);
    if (!revokedIssuer) {
      throw new Error("expected issuer before liveness revocation");
    }
    ownsChannel = false;
    await recordInboundSessionMetaWithTrustedMemorySubject(
      { storePath, sessionKey: revokedSessionKey, ctx: revokedContext },
      revokedIssuer,
    );
    expect(
      readCurrentSessionMemorySubject({
        agentId: "main",
        sessionKey: revokedSessionKey,
        storePath,
      })?.subject,
    ).toEqual({ version: 1, kind: "ambiguous", reason: "unbound" });
  });

  it("does not promote a facade-built context through direct prepared dispatch", async () => {
    const facade = createCoreChannelInboundEventFacade({
      ownsChannel: (channel) => channel === "test",
    });
    const ctx = facade.buildContext(createContextParams());
    const issuers: TrustedSessionMemorySubjectIssuer[] = [];
    recordInboundSession.mockImplementation(async (params) => {
      const issuer = getBoundChannelInboundMemorySubjectIssuer(
        params.ctx as FinalizedMsgContext,
        params.sessionKey,
      );
      if (issuer) {
        issuers.push(issuer);
      }
    });

    await runPrepared({ ctxPayload: ctx, run: facade.run, useSessionRecorder: true });
    await runPrepared({ ctxPayload: ctx, run: runChannelInboundEvent, useSessionRecorder: true });
    await runPreparedInboundReply(createPreparedTurn(ctx));

    expect(issuers).toHaveLength(1);
    expect(getBoundChannelInboundMemorySubjectIssuer(ctx, SESSION_KEY)).toBeUndefined();
  });

  it("rejects authority when routed execution changes the owning agent", async () => {
    const facade = createCoreChannelInboundEventFacade({
      ownsChannel: (channel) => channel === "test",
    });
    const ctx = facade.buildContext(createContextParams());
    let issuer: TrustedSessionMemorySubjectIssuer | undefined;
    recordInboundSession.mockImplementation(async (params) => {
      issuer = getBoundChannelInboundMemorySubjectIssuer(
        params.ctx as FinalizedMsgContext,
        params.sessionKey,
      );
    });

    await facade.run({
      channel: "test",
      accountId: "acct",
      raw: {},
      adapter: {
        ingest: () => ({ id: "message-1", rawText: "hello" }),
        resolveTurn: () => ({
          cfg: {} as OpenClawConfig,
          channel: "test",
          accountId: "acct",
          route: {
            agentId: "other-agent",
            dmScope: "per-channel-peer",
            sessionKey: SESSION_KEY,
          },
          ctxPayload: ctx,
          delivery: { deliver: async () => ({ visibleReplySent: false }) },
        }),
      },
    });

    expect(issuer).toBeUndefined();
    expect(getBoundChannelInboundMemorySubjectIssuer(ctx, SESSION_KEY)).toBeUndefined();
  });

  it("clears a bound issuer after a bot-loop terminal path", async () => {
    const facade = createCoreChannelInboundEventFacade({
      ownsChannel: (channel) => channel === "test",
    });
    const ctx = facade.buildContext(createContextParams());
    const botLoopProtection = {
      scopeId: "core-ingress-terminal-cleanup",
      conversationId: "sender-1",
      senderId: "bot-a",
      receiverId: "bot-b",
      config: { maxEventsPerWindow: 1, windowSeconds: 60, cooldownSeconds: 60 },
      defaultEnabled: true,
    };
    await runPreparedInboundReply({
      ...createPreparedTurn(ctx),
      botLoopProtection: { ...botLoopProtection, nowMs: 1_000 },
    });
    let issuerDuringSkip: TrustedSessionMemorySubjectIssuer | undefined;

    await facade.run({
      channel: "test",
      accountId: "acct",
      raw: {},
      adapter: {
        ingest: () => ({ id: "message-1", rawText: "hello" }),
        resolveTurn: () => ({
          ...createPreparedTurn(ctx),
          botLoopProtection: { ...botLoopProtection, nowMs: 1_001 },
          runDispatchLifecycle: {
            turnAdoptionLifecycle: undefined,
            onDispatchSkipped: async () => {
              issuerDuringSkip = getBoundChannelInboundMemorySubjectIssuer(ctx, SESSION_KEY);
            },
          },
        }),
      },
    });

    expect(issuerDuringSkip).toBeDefined();
    expect(getBoundChannelInboundMemorySubjectIssuer(ctx, SESSION_KEY)).toBeUndefined();
  });

  it("preserves a valid issuer only on the final routed dmScope context clone", async () => {
    const facade = createCoreChannelInboundEventFacade({
      ownsChannel: (channel) => channel === "test",
    });
    const ctx = facade.buildContext(createContextParams());
    let recordedContext: FinalizedMsgContext | undefined;
    let issuer: TrustedSessionMemorySubjectIssuer | undefined;
    recordInboundSession.mockImplementation(async (params) => {
      recordedContext = params.ctx as FinalizedMsgContext;
      issuer = getBoundChannelInboundMemorySubjectIssuer(recordedContext, params.sessionKey);
    });
    const result = await facade.run({
      channel: "test",
      accountId: "acct",
      raw: {},
      adapter: {
        ingest: () => ({ id: "message-1", rawText: "hello" }),
        resolveTurn: () => ({
          cfg: {} as OpenClawConfig,
          channel: "test",
          accountId: "acct",
          route: {
            agentId: "main",
            dmScope: "per-channel-peer",
            sessionKey: SESSION_KEY,
          },
          ctxPayload: ctx,
          delivery: { deliver: async () => ({ visibleReplySent: false }) },
        }),
      },
    });

    expect(result.dispatched).toBe(true);
    if (!result.dispatched) {
      throw new Error("expected a dispatched routed turn");
    }
    expect(result.ctxPayload).not.toBe(ctx);
    expect(getBoundChannelInboundMemorySubjectIssuer(ctx, SESSION_KEY)).toBeUndefined();
    expect(recordedContext).toBe(result.ctxPayload);
    expect(issuer).toBeDefined();
    expect(
      getBoundChannelInboundMemorySubjectIssuer(
        result.ctxPayload as FinalizedMsgContext,
        SESSION_KEY,
      ),
    ).toBeUndefined();
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({ ctx: result.ctxPayload, sessionKey: SESSION_KEY }),
    );
  });
});
