import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createMemoryIdentityBindingThroughApprovedPairing } from "../pairing/memory-identity-approval.test-support.js";
import { memoryIdentityLifecycle } from "./memory-identity.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { ensureProfileForEmail } from "./user-profiles.js";

const {
  ensureEnterpriseMemoryPrincipal,
  ensureExplicitMemoryPrincipal,
  ensureGatewayProfileMemoryPrincipal,
  mergeMemoryPrincipals,
  resolveCurrentMemoryIdentityBinding,
  resolveMemoryIdentityBinding,
  resolveMemoryPrincipal,
  revokeMemoryIdentityBinding,
  revokeMemoryPrincipal,
} = memoryIdentityLifecycle;

const tempDirectories = useAutoCleanupTempDirTracker(afterEach);

function createStateOptions() {
  const directory = tempDirectories.make("openclaw-memory-identity-");
  return { env: { ...process.env, OPENCLAW_STATE_DIR: directory } };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("memory identity", () => {
  it("maps one durable Gateway profile to an idempotent canonical principal", () => {
    const options = createStateOptions();
    const profile = ensureProfileForEmail("owner@example.test", options);

    const first = ensureGatewayProfileMemoryPrincipal(profile.id, options);
    const second = ensureGatewayProfileMemoryPrincipal(profile.id, options);

    expect(first).toMatchObject({
      kind: "gateway-profile",
      state: "active",
      userProfileId: profile.id,
    });
    expect(second).toEqual(first);
  });

  it("stores only a keyed sender lookup token and resolves verified evidence", async () => {
    const options = createStateOptions();
    const principal = ensureEnterpriseMemoryPrincipal({
      issuer: "example-idp",
      stableSubjectId: "verified-owner",
      now: 100,
      options,
    });
    const stableSenderId = "provider-user-raw-123";
    const binding = await createMemoryIdentityBindingThroughApprovedPairing({
      channel: "telegram",
      accountId: "default",
      stableSenderId,
      principalId: principal.principalId,
      now: 100,
      options,
    });

    expect(
      resolveMemoryIdentityBinding({
        channel: "telegram",
        accountId: "default",
        stableSenderId,
        now: 101,
        options,
      }),
    ).toEqual({
      kind: "verified",
      bindingId: binding.bindingId,
      principalId: principal.principalId,
      assurance: "adapter-attested",
      evidenceRevision: binding.evidenceRevision,
    });
    const row = openOpenClawStateDatabase(options)
      .db.prepare(
        "SELECT channel, account_id, sender_lookup_hmac FROM memory_identity_bindings WHERE binding_id = ?",
      )
      .get(binding.bindingId) as
      | { channel: string; account_id: string; sender_lookup_hmac: string }
      | undefined;
    expect(row).toMatchObject({ channel: "telegram", account_id: "default" });
    expect(row?.sender_lookup_hmac).not.toBe(stableSenderId);
    expect(JSON.stringify(row)).not.toContain(stableSenderId);
  });

  it("fails closed for unbound, conflicting, expired, and revoked evidence", async () => {
    const options = createStateOptions();
    const first = ensureEnterpriseMemoryPrincipal({
      issuer: "example-idp",
      stableSubjectId: "first-owner",
      now: 100,
      options,
    });
    const second = ensureEnterpriseMemoryPrincipal({
      issuer: "example-idp",
      stableSubjectId: "second-owner",
      now: 100,
      options,
    });
    const base = {
      channel: "signal",
      accountId: "primary",
      stableSenderId: "sender-1",
      options,
    };

    expect(resolveMemoryIdentityBinding({ ...base, now: 101 })).toEqual({ kind: "unbound" });

    const firstBinding = await createMemoryIdentityBindingThroughApprovedPairing({
      ...base,
      principalId: first.principalId,
      now: 100,
    });
    await createMemoryIdentityBindingThroughApprovedPairing({
      ...base,
      principalId: second.principalId,
      now: 100,
    });
    expect(resolveMemoryIdentityBinding({ ...base, now: 101 })).toEqual({
      kind: "conflicting-bindings",
    });

    expect(
      revokeMemoryIdentityBinding({
        bindingId: firstBinding.bindingId,
        revokedBy: "operator-2",
        now: 102,
        options,
      }),
    ).toBe(true);
    expect(revokeMemoryPrincipal({ principalId: second.principalId, now: 102, options })).toBe(
      true,
    );
    expect(resolveMemoryIdentityBinding({ ...base, now: 103 })).toEqual({ kind: "unbound" });

    const expired = ensureEnterpriseMemoryPrincipal({
      issuer: "example-idp",
      stableSubjectId: "expired-owner",
      expiresAt: 201,
      now: 200,
      options,
    });
    expect(resolveMemoryPrincipal(expired.principalId, options, 201)).toEqual({ kind: "expired" });
  });

  it("treats expired channel bindings as unbound for sender and captured-binding lookups", async () => {
    const options = createStateOptions();
    const principal = ensureEnterpriseMemoryPrincipal({
      issuer: "example-idp",
      stableSubjectId: "expiry-owner",
      now: 100,
      options,
    });
    const binding = await createMemoryIdentityBindingThroughApprovedPairing({
      channel: "telegram",
      accountId: "default",
      stableSenderId: "sender-1",
      principalId: principal.principalId,
      now: 100,
      options,
    });
    const lookup = {
      channel: "telegram",
      accountId: "default",
      stableSenderId: "sender-1",
      options,
    };

    const captured = resolveMemoryIdentityBinding({ ...lookup, now: 101 });
    expect(captured).toMatchObject({
      kind: "verified",
      bindingId: binding.bindingId,
      principalId: principal.principalId,
    });
    if (captured.kind !== "verified") {
      throw new Error("test setup must resolve a verified binding");
    }

    openOpenClawStateDatabase(options)
      .db.prepare("UPDATE memory_identity_bindings SET expires_at = ? WHERE binding_id = ?")
      .run(102, binding.bindingId);

    expect(resolveMemoryIdentityBinding({ ...lookup, now: 102 })).toEqual({ kind: "unbound" });
    expect(
      resolveCurrentMemoryIdentityBinding({
        bindingId: captured.bindingId,
        principalId: captured.principalId,
        evidenceRevision: captured.evidenceRevision,
        now: 102,
        options,
      }),
    ).toEqual({ kind: "unbound" });
  });

  it("rechecks a captured binding against current merge and revocation state", async () => {
    const options = createStateOptions();
    const source = ensureEnterpriseMemoryPrincipal({
      issuer: "example-idp",
      stableSubjectId: "source-owner",
      now: 100,
      options,
    });
    const target = ensureEnterpriseMemoryPrincipal({
      issuer: "example-idp",
      stableSubjectId: "target-owner",
      now: 100,
      options,
    });
    const binding = await createMemoryIdentityBindingThroughApprovedPairing({
      channel: "discord",
      accountId: "primary",
      stableSenderId: "sender-1",
      principalId: source.principalId,
      now: 100,
      options,
    });

    mergeMemoryPrincipals({
      sourcePrincipalId: source.principalId,
      targetPrincipalId: target.principalId,
      now: 101,
      options,
    });
    expect(
      resolveCurrentMemoryIdentityBinding({
        bindingId: binding.bindingId,
        principalId: source.principalId,
        evidenceRevision: binding.evidenceRevision,
        now: 102,
        options,
      }),
    ).toMatchObject({ kind: "verified", principalId: target.principalId });

    revokeMemoryIdentityBinding({
      bindingId: binding.bindingId,
      revokedBy: "operator-2",
      now: 103,
      options,
    });
    expect(
      resolveCurrentMemoryIdentityBinding({
        bindingId: binding.bindingId,
        principalId: source.principalId,
        evidenceRevision: binding.evidenceRevision,
        now: 104,
        options,
      }),
    ).toEqual({ kind: "unbound" });
  });

  it("does not allow service or agent principals to be bound as human identity", async () => {
    const options = createStateOptions();
    const service = ensureExplicitMemoryPrincipal({
      kind: "service",
      stableSubjectId: "cron",
      now: 100,
      options,
    });

    await expect(
      createMemoryIdentityBindingThroughApprovedPairing({
        channel: "telegram",
        accountId: "default",
        stableSenderId: "sender-1",
        principalId: service.principalId,
        now: 101,
        options,
      }),
    ).rejects.toThrow("verified user");
  });

  it("keeps identity tables absent until the first identity operation", () => {
    const options = createStateOptions();
    const database = openOpenClawStateDatabase(options).db;

    expect(tableExists(database, "memory_principals")).toBe(false);
    expect(tableExists(database, "memory_identity_bindings")).toBe(false);

    ensureEnterpriseMemoryPrincipal({
      issuer: "lazy-schema-test",
      stableSubjectId: "first-owner",
      now: 100,
      options,
    });

    expect(tableExists(database, "memory_principals")).toBe(true);
    expect(tableExists(database, "memory_identity_bindings")).toBe(true);
  });

  it("rejects caller-assembled pairing approval facts and exposes no raw mint", () => {
    const options = createStateOptions();
    const principal = ensureEnterpriseMemoryPrincipal({
      issuer: "approval-abuse-test",
      stableSubjectId: "owner",
      now: 100,
      options,
    });

    expect(() =>
      runOpenClawStateWriteTransaction(
        (database) =>
          memoryIdentityLifecycle.createMemoryIdentityBindingFromApprovedChannelPairing({
            database,
            approval: {
              accountId: "default",
              channel: "telegram",
              requestId: "caller-forged-request",
              stableSenderId: "caller-forged-sender",
            },
            principalId: principal.principalId,
            creatorProfileId: "caller-forged-creator",
            now: 101,
          }),
        options,
      ),
    ).toThrow("requires a consumed channel pairing approval");
    expect(
      Object.keys(memoryIdentityLifecycle).filter((method) => method.startsWith("create")),
    ).toEqual(["createMemoryIdentityBindingFromApprovedChannelPairing"]);
    expect(
      resolveMemoryIdentityBinding({
        channel: "telegram",
        accountId: "default",
        stableSenderId: "caller-forged-sender",
        now: 101,
        options,
      }),
    ).toEqual({ kind: "unbound" });
  });

  it("does not merge verified users into autonomous principals", () => {
    const options = createStateOptions();
    const user = ensureEnterpriseMemoryPrincipal({
      issuer: "example-idp",
      stableSubjectId: "human-owner",
      now: 100,
      options,
    });
    const service = ensureExplicitMemoryPrincipal({
      kind: "service",
      stableSubjectId: "scheduled-task",
      now: 100,
      options,
    });

    expect(() =>
      mergeMemoryPrincipals({
        sourcePrincipalId: user.principalId,
        targetPrincipalId: service.principalId,
        now: 101,
        options,
      }),
    ).toThrow("compatible principal kinds");
  });
});
