import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createMemoryIdentityBindingThroughApprovedPairing } from "../../pairing/memory-identity-approval.test-support.js";
import { memoryIdentityLifecycle } from "../../state/memory-identity.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { replaceSessionEntrySync, upsertSessionEntry } from "./session-accessor.js";
import {
  createTrustedSessionMemoryAccessContext,
  isTrustedSessionMemoryAccessContext,
  readTrustedSessionMemoryAccessContext,
} from "./session-memory-access-context.js";
import {
  isTrustedMemoryAccessHostFacts,
  issueTrustedMemoryAccessHostFactsFromCore,
  type TrustedMemoryAccessHostFacts,
} from "./session-memory-access-host-facts.js";
import { readCurrentSessionMemorySubjectAuthority } from "./session-memory-subject-access.js";
import * as sessionMemorySubjectAccessModule from "./session-memory-subject-access.js";
import {
  prepareChannelBindingSessionMemorySubjectSeed,
  prepareExplicitSessionMemorySubjectSeed,
  prepareConversationSessionMemorySubjectSeed,
} from "./session-memory-subject.js";

const tempDirectories = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function createPaths() {
  const directory = tempDirectories.make("openclaw-session-memory-context-");
  return {
    stateOptions: { path: path.join(directory, "state.sqlite") },
    storePath: path.join(directory, "sessions.json"),
  };
}

async function createServiceSession(options: { expiresAt?: number; now?: number } = {}) {
  const { stateOptions, storePath } = createPaths();
  const scope = { agentId: "main", sessionKey: "agent:main:service:context", storePath };
  const now = options.now ?? 100;
  const seed = prepareExplicitSessionMemorySubjectSeed({
    kind: "service",
    stableSubjectId: "memory-context-service",
    now,
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    options: stateOptions,
  });
  await upsertSessionEntry(
    scope,
    { sessionId: "memory-context-session", updatedAt: now },
    { memorySubjectSeed: seed },
  );
  const authority = readCurrentSessionMemorySubjectAuthority(scope, stateOptions, now + 1);
  if (
    !authority ||
    authority.authority.kind !== "current" ||
    !authority.authority.currentPrincipalId
  ) {
    throw new Error("expected current service authority");
  }
  return { authority: authority.authority, scope, stateOptions };
}

async function createChannelBoundSession() {
  const { storePath } = createPaths();
  const stateOptions = {
    env: { ...process.env, OPENCLAW_STATE_DIR: path.dirname(storePath) },
  };
  const principal = memoryIdentityLifecycle.ensureEnterpriseMemoryPrincipal({
    issuer: "session-memory-access-context-test",
    stableSubjectId: "binding-race-user",
    now: 100,
    options: stateOptions,
  });
  const binding = await createMemoryIdentityBindingThroughApprovedPairing({
    channel: "telegram",
    accountId: "default",
    stableSenderId: "binding-race-user",
    principalId: principal.principalId,
    now: 100,
    options: stateOptions,
  });
  const scope = { agentId: "main", sessionKey: "agent:main:binding-race", storePath };
  await upsertSessionEntry(
    scope,
    { sessionId: "binding-race-session", updatedAt: 101 },
    {
      memorySubjectSeed: prepareChannelBindingSessionMemorySubjectSeed({
        channel: "telegram",
        accountId: "default",
        stableSenderId: "binding-race-user",
        now: 101,
        options: stateOptions,
      }),
    },
  );
  const authority = readCurrentSessionMemorySubjectAuthority(scope, stateOptions, 102);
  if (
    !authority ||
    authority.authority.kind !== "current" ||
    !authority.authority.currentPrincipalId ||
    !authority.authority.assurance ||
    !authority.authority.evidenceRevision
  ) {
    throw new Error("expected current channel-bound authority");
  }
  return { authority: authority.authority, binding, scope, stateOptions };
}

function createHostFacts(
  params: Pick<Awaited<ReturnType<typeof createServiceSession>>, "authority" | "scope">,
  extra: Record<string, unknown> = {},
) {
  const expiresAt = params.authority.expiresAt;
  return {
    contextId: "context-1",
    requestId: "request-1",
    runId: "run-1",
    agentId: "main",
    sessionKey: params.scope.sessionKey,
    actor: {
      kind: "principal",
      actorKind: "service",
      principalId: params.authority.currentPrincipalId,
      assurance: "service",
      evidenceRevision: params.authority.evidenceRevision,
      ...(expiresAt === undefined ? {} : { expiresAt: new Date(expiresAt).toISOString() }),
    },
    verifiedPrincipals: [
      {
        principalId: params.authority.currentPrincipalId,
        assurance: "service",
        evidenceRevision: params.authority.evidenceRevision,
        ...(expiresAt === undefined ? {} : { expiresAt: new Date(expiresAt).toISOString() }),
      },
    ],
    delivery: {
      sinkKind: "internal",
      audiences: [{ kind: "agent", id: "main" }],
      egressCapabilityIds: ["memory-egress"],
      egressRegistryRevision: "egress-r1",
      deliveryRevision: "delivery-r1",
    },
    collaboration: { kind: "not-applicable" },
    verifiedMemberships: [],
    operation: "read",
    hostFactsRevision: "host-facts-r1",
    ...extra,
  };
}

describe("session memory access context", () => {
  it("binds frozen host facts to the current persisted subject and hides the DTO behind an opaque handle", async () => {
    const params = await createServiceSession();
    const hostFacts = issueTrustedMemoryAccessHostFactsFromCore({
      facts: createHostFacts(params),
      scope: params.scope,
      stateOptions: params.stateOptions,
    });

    const result = createTrustedSessionMemoryAccessContext({ hostFacts });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(isTrustedSessionMemoryAccessContext(result.value)).toBe(true);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(result.value.contextFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(result.value)).not.toContain(params.authority.currentPrincipalId);
    expect(isTrustedSessionMemoryAccessContext({ ...result.value })).toBe(false);
    expect(readTrustedSessionMemoryAccessContext(result.value)).toMatchObject({
      sessionId: "memory-context-session",
      subject: { kind: "service", principalId: params.authority.currentPrincipalId },
      subjectRevision: expect.any(String),
    });
  });

  it("accepts only an opaque core-issued host-facts handle", async () => {
    const params = await createServiceSession();
    const callerAssembledFacts = createHostFacts(params);
    const modelAuthoredJson = JSON.parse(JSON.stringify(callerAssembledFacts)) as unknown;
    const pluginExtras = {
      ...callerAssembledFacts,
      extra: {
        identityLinks: [{ principalId: params.authority.currentPrincipalId }],
        memoryAccess: callerAssembledFacts,
      },
    };

    for (const candidate of [callerAssembledFacts, modelAuthoredJson, pluginExtras]) {
      expect(isTrustedMemoryAccessHostFacts(candidate)).toBe(false);
      expect(
        createTrustedSessionMemoryAccessContext({
          hostFacts: candidate as TrustedMemoryAccessHostFacts,
        }),
      ).toEqual({ ok: false, error: "invalid-context" });
    }

    const coreIssued = issueTrustedMemoryAccessHostFactsFromCore({
      facts: callerAssembledFacts,
      scope: params.scope,
      stateOptions: params.stateOptions,
    });
    expect(isTrustedMemoryAccessHostFacts(coreIssued)).toBe(true);
    expect(createTrustedSessionMemoryAccessContext({ hostFacts: coreIssued })).toMatchObject({
      ok: true,
    });
  });

  it("uses the host clock even when untyped callers attach a backdated now", async () => {
    const beforeExpiry = 1_000;
    const expiresAt = 2_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(beforeExpiry);
    const params = await createServiceSession({ now: beforeExpiry, expiresAt });
    const hostFacts = issueTrustedMemoryAccessHostFactsFromCore({
      facts: createHostFacts(params),
      scope: params.scope,
      stateOptions: params.stateOptions,
    });

    expect(createTrustedSessionMemoryAccessContext({ hostFacts })).toMatchObject({ ok: true });

    dateNow.mockReturnValue(expiresAt + 1);
    const backdatedHostFactsParams = {
      facts: createHostFacts(params),
      scope: params.scope,
      stateOptions: params.stateOptions,
      now: beforeExpiry,
    } as unknown as Parameters<typeof issueTrustedMemoryAccessHostFactsFromCore>[0];
    expect(() => issueTrustedMemoryAccessHostFactsFromCore(backdatedHostFactsParams)).toThrow(
      "identity-revoked",
    );
    const backdatedContextParams = {
      hostFacts,
      now: beforeExpiry,
    } as unknown as Parameters<typeof createTrustedSessionMemoryAccessContext>[0];
    expect(createTrustedSessionMemoryAccessContext(backdatedContextParams)).toEqual({
      ok: false,
      error: "identity-revoked",
    });
  });

  it("normalizes unordered facts into a stable fingerprint and rejects copied or extra host facts", async () => {
    const params = await createServiceSession();
    const base = createHostFacts(params, {
      verifiedPrincipals: [
        ...createHostFacts(params).verifiedPrincipals,
        {
          principalId: "other-principal",
          assurance: "service",
          evidenceRevision: "other-evidence",
        },
      ],
      delivery: {
        ...createHostFacts(params).delivery,
        audiences: [
          { kind: "internal", id: "memory" },
          { kind: "agent", id: "main" },
        ],
        egressCapabilityIds: ["z-cap", "a-cap"],
      },
    });
    const reordered = {
      ...base,
      verifiedPrincipals: [...base.verifiedPrincipals].toReversed(),
      delivery: {
        ...base.delivery,
        audiences: [...base.delivery.audiences].toReversed(),
        egressCapabilityIds: [...base.delivery.egressCapabilityIds].toReversed(),
      },
    };
    const first = issueTrustedMemoryAccessHostFactsFromCore({
      facts: base,
      scope: params.scope,
      stateOptions: params.stateOptions,
    });
    const second = issueTrustedMemoryAccessHostFactsFromCore({
      facts: reordered,
      scope: params.scope,
      stateOptions: params.stateOptions,
    });
    const firstContext = createTrustedSessionMemoryAccessContext({ hostFacts: first });
    const secondContext = createTrustedSessionMemoryAccessContext({ hostFacts: second });

    expect(firstContext).toMatchObject({ ok: true });
    expect(secondContext).toMatchObject({ ok: true });
    if (!firstContext.ok || !secondContext.ok) {
      return;
    }
    expect(secondContext.value.contextFingerprint).toBe(firstContext.value.contextFingerprint);
    expect(
      createTrustedSessionMemoryAccessContext({
        hostFacts: { ...first } as TrustedMemoryAccessHostFacts,
      }),
    ).toEqual({
      ok: false,
      error: "invalid-context",
    });
    expect(() =>
      issueTrustedMemoryAccessHostFactsFromCore({
        facts: { ...base, rawSenderId: "forged" },
        scope: params.scope,
        stateOptions: params.stateOptions,
      }),
    ).toThrow("invalid-context");
  });

  it("rejects a revoked principal and a mismatched conversation host fact", async () => {
    const params = await createServiceSession();
    const hostFacts = issueTrustedMemoryAccessHostFactsFromCore({
      facts: createHostFacts(params),
      scope: params.scope,
      stateOptions: params.stateOptions,
    });
    expect(
      memoryIdentityLifecycle.revokeMemoryPrincipal({
        principalId: params.authority.currentPrincipalId,
        now: 102,
        options: params.stateOptions,
      }),
    ).toBe(true);
    expect(createTrustedSessionMemoryAccessContext({ hostFacts })).toEqual({
      ok: false,
      error: "identity-revoked",
    });

    const { stateOptions, storePath } = createPaths();
    const scope = { agentId: "main", sessionKey: "agent:main:group:context", storePath };
    const seed = prepareConversationSessionMemorySubjectSeed({
      channel: "discord",
      accountId: "primary",
      conversationId: "room-1",
      now: 100,
      options: stateOptions,
    });
    await upsertSessionEntry(
      scope,
      { sessionId: "conversation-context-session", updatedAt: 100 },
      { memorySubjectSeed: seed },
    );
    const conversationFacts = issueTrustedMemoryAccessHostFactsFromCore({
      facts: {
        contextId: "conversation-context",
        requestId: "request-1",
        runId: "run-1",
        agentId: "main",
        sessionKey: scope.sessionKey,
        actor: { kind: "unattributed", transportAuditRef: "audit-1", evidenceRevision: "audit-r1" },
        verifiedPrincipals: [],
        conversation: {
          conversationPrincipalId: "wrong-conversation",
          channel: "discord",
          accountId: "primary",
          evidenceRevision: "conversation-r1",
        },
        delivery: {
          sinkKind: "channel",
          audiences: [{ kind: "conversation", id: "room-1" }],
          egressCapabilityIds: [],
          egressRegistryRevision: "egress-r1",
          deliveryRevision: "delivery-r1",
        },
        collaboration: { kind: "not-applicable" },
        verifiedMemberships: [],
        operation: "read",
        hostFactsRevision: "host-facts-r1",
      },
      scope,
      stateOptions,
    });
    expect(createTrustedSessionMemoryAccessContext({ hostFacts: conversationFacts })).toEqual({
      ok: false,
      error: "outside-view",
    });
  });

  it("fails closed when the session is rebound while constructing the context", async () => {
    const params = await createServiceSession();
    const hostFacts = issueTrustedMemoryAccessHostFactsFromCore({
      facts: createHostFacts(params),
      scope: params.scope,
      stateOptions: params.stateOptions,
    });
    const readAuthority = sessionMemorySubjectAccessModule.readCurrentSessionMemorySubjectAuthority;
    let rebound = false;
    vi.spyOn(
      sessionMemorySubjectAccessModule,
      "readCurrentSessionMemorySubjectAuthority",
    ).mockImplementation((scope, stateOptions, now) => {
      const result = readAuthority(scope, stateOptions, now);
      if (!rebound) {
        rebound = true;
        replaceSessionEntrySync(scope, {
          sessionId: "memory-context-session-rebound",
          updatedAt: 102,
        });
      }
      return result;
    });

    expect(createTrustedSessionMemoryAccessContext({ hostFacts })).toEqual({
      ok: false,
      error: "session-rebound",
    });
  });

  it("fails closed when a channel binding is revoked between context authority reads", async () => {
    const params = await createChannelBoundSession();
    const hostFacts = issueTrustedMemoryAccessHostFactsFromCore({
      facts: createHostFacts(params, {
        actor: {
          kind: "principal",
          actorKind: "human",
          principalId: params.authority.currentPrincipalId,
          assurance: params.authority.assurance,
          evidenceRevision: params.authority.evidenceRevision,
        },
        verifiedPrincipals: [
          {
            principalId: params.authority.currentPrincipalId,
            assurance: params.authority.assurance,
            evidenceRevision: params.authority.evidenceRevision,
          },
        ],
      }),
      scope: params.scope,
      stateOptions: params.stateOptions,
    });
    const readAuthority = sessionMemorySubjectAccessModule.readCurrentSessionMemorySubjectAuthority;
    let authorityReads = 0;
    const authoritySpy = vi
      .spyOn(sessionMemorySubjectAccessModule, "readCurrentSessionMemorySubjectAuthority")
      .mockImplementation((scope, stateOptions, now) => {
        const result = readAuthority(scope, stateOptions, now);
        authorityReads += 1;
        if (authorityReads === 1) {
          expect(result?.authority.kind).toBe("current");
          expect(
            memoryIdentityLifecycle.revokeMemoryIdentityBinding({
              bindingId: params.binding.bindingId,
              revokedBy: "context-race-test",
              now: Date.now(),
              options: params.stateOptions,
            }),
          ).toBe(true);
        }
        return result;
      });

    expect(createTrustedSessionMemoryAccessContext({ hostFacts })).toEqual({
      ok: false,
      error: "identity-revoked",
    });
    expect(authoritySpy).toHaveBeenCalledTimes(2);
  });
});
