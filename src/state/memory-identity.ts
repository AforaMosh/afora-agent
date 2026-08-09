import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  clearAuditIdentityKeyCacheForDatabase,
  pseudonymizeExecutionIdentityRef,
} from "../audit/audit-identity.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import { consumeChannelPairingMemoryIdentityApproval } from "../pairing/memory-identity-approval.js";
import { MEMORY_IDENTITY_SCHEMA_SQL } from "./memory-identity-schema.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { resolveUserProfileId, resolveUserProfileIdInTransaction } from "./user-profiles.js";

export type MemoryPrincipalKind =
  | "gateway-profile"
  | "enterprise"
  | "service"
  | "agent"
  | "system"
  | "conversation";

export type MemoryPrincipal = Readonly<{
  principalId: string;
  kind: MemoryPrincipalKind;
  userProfileId?: string;
  issuer?: string;
  state: "active" | "revoked" | "merged";
  evidenceRevision: string;
  mergedInto?: string;
  expiresAt?: number;
  revokedAt?: number;
  createdAt: number;
  updatedAt: number;
}>;

export type MemoryIdentityBindingAssurance = "adapter-attested" | "oidc";
export type MemoryIdentityVerificationMethod = "pairing" | "oauth" | "admin-link";

export type MemoryIdentityBinding = Readonly<{
  bindingId: string;
  channel: string;
  accountId: string;
  principalId: string;
  adapterId: string;
  assurance: MemoryIdentityBindingAssurance;
  verificationMethod: MemoryIdentityVerificationMethod;
  evidenceRevision: string;
  createdBy: string;
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
}>;

export type MemoryIdentityBindingResolution =
  | Readonly<{
      kind: "verified";
      bindingId: string;
      principalId: string;
      assurance: MemoryIdentityBindingAssurance;
      evidenceRevision: string;
      expiresAt?: number;
    }>
  | Readonly<{ kind: "unbound" }>
  | Readonly<{ kind: "conflicting-bindings" }>;

export type MemoryPrincipalResolution =
  | Readonly<{ kind: "current"; principal: MemoryPrincipal }>
  | Readonly<{ kind: "missing" | "revoked" | "expired" | "merge-cycle" }>;

type MemoryIdentityDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "memory_identity_bindings" | "memory_principals"
>;
type MemoryPrincipalRow = Selectable<MemoryIdentityDatabase["memory_principals"]>;
type MemoryIdentityBindingRow = Selectable<MemoryIdentityDatabase["memory_identity_bindings"]>;

const ensuredDatabases = new WeakSet<DatabaseSync>();
const MAX_PRINCIPAL_MERGE_DEPTH = 64;

function memoryIdentityDb(db: DatabaseSync) {
  return getNodeSqliteKysely<MemoryIdentityDatabase>(db);
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(`${label} must not be empty`);
  }
  return normalized;
}

function normalizeChannel(value: string): string {
  return requireText(value, "channel").toLowerCase();
}

function requireVerificationMethod(value: string): MemoryIdentityVerificationMethod {
  const normalized = requireText(value, "verificationMethod");
  if (normalized === "pairing" || normalized === "oauth" || normalized === "admin-link") {
    return normalized;
  }
  throw new TypeError("verificationMethod must be pairing, oauth, or admin-link");
}

function optionalNumber(value: number | null): number | undefined {
  return value === null ? undefined : value;
}

function toMemoryPrincipal(row: MemoryPrincipalRow): MemoryPrincipal {
  return {
    principalId: row.principal_id,
    kind: row.kind as MemoryPrincipalKind,
    ...(row.user_profile_id ? { userProfileId: row.user_profile_id } : {}),
    ...(row.issuer ? { issuer: row.issuer } : {}),
    state: row.state as MemoryPrincipal["state"],
    evidenceRevision: row.evidence_revision,
    ...(row.merged_into ? { mergedInto: row.merged_into } : {}),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMemoryIdentityBinding(row: MemoryIdentityBindingRow): MemoryIdentityBinding {
  return {
    bindingId: row.binding_id,
    channel: row.channel,
    accountId: row.account_id,
    principalId: row.principal_id,
    adapterId: row.adapter_id,
    assurance: row.assurance as MemoryIdentityBindingAssurance,
    verificationMethod: requireVerificationMethod(row.verification_method),
    evidenceRevision: row.evidence_revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  };
}

function isVerifiedMemoryUserPrincipal(principal: MemoryPrincipal): boolean {
  return principal.kind === "gateway-profile" || principal.kind === "enterprise";
}

function memoryPrincipalMergeClass(kind: MemoryPrincipalKind): string {
  switch (kind) {
    case "gateway-profile":
    case "enterprise":
      return "verified-user";
    default:
      return kind;
  }
}

/** Creates the additive shared tables only on the first identity operation. */
export function ensureMemoryIdentitySchema(options: OpenClawStateDatabaseOptions = {}): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.exec(MEMORY_IDENTITY_SCHEMA_SQL); // sqlite-allow-raw -- Canonical additive lazy schema.
    },
    options,
    { operationLabel: "memory-identity.schema.ensure" },
  );
  // Only cache after commit; a rollback must retry the schema creation.
  ensuredDatabases.add(database.db);
}

function readPrincipalRow(db: DatabaseSync, principalId: string): MemoryPrincipalRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    memoryIdentityDb(db)
      .selectFrom("memory_principals")
      .selectAll()
      .where("principal_id", "=", principalId),
  );
}

function resolvePrincipalInDatabase(
  db: DatabaseSync,
  principalId: string,
  now: number,
): MemoryPrincipalResolution {
  let currentId = principalId;
  const visited = new Set<string>();
  for (let depth = 0; depth < MAX_PRINCIPAL_MERGE_DEPTH; depth += 1) {
    if (visited.has(currentId)) {
      return { kind: "merge-cycle" };
    }
    visited.add(currentId);
    const row = readPrincipalRow(db, currentId);
    if (!row) {
      return { kind: "missing" };
    }
    if (row.state === "merged") {
      if (!row.merged_into) {
        return { kind: "missing" };
      }
      currentId = row.merged_into;
      continue;
    }
    if (row.state === "revoked") {
      return { kind: "revoked" };
    }
    if (row.expires_at !== null && row.expires_at <= now) {
      return { kind: "expired" };
    }
    return { kind: "current", principal: toMemoryPrincipal(row) };
  }
  return { kind: "merge-cycle" };
}

function identityLookupHmac(params: { db: DatabaseSync; scope: string; value: string }): string {
  // This domain is distinct from audit pseudonyms. The database stores only
  // this keyed lookup token, never the provider's raw sender/subject value.
  return pseudonymizeExecutionIdentityRef({
    db: params.db,
    kind: "principal",
    scope: params.scope,
    value: params.value,
  });
}

function bindingLookupScope(channel: string, accountId: string): string {
  return `memory-identity-binding:v1:${channel}\u0000${accountId}`;
}

function principalLookupScope(kind: MemoryPrincipalKind, issuer: string): string {
  return `memory-principal:v1:${kind}\u0000${issuer}`;
}

function runMemoryIdentityTransaction<T>(
  options: OpenClawStateDatabaseOptions,
  operationLabel: string,
  operation: (db: DatabaseSync) => T,
): T {
  ensureMemoryIdentitySchema(options);
  let database: DatabaseSync | undefined;
  try {
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        database = db;
        return operation(db);
      },
      options,
      { operationLabel },
    );
  } catch (error) {
    // The keyed HMAC helper may create its key in this transaction. Never keep
    // a cache entry for a key whose outer transaction rolled back.
    if (database) {
      clearAuditIdentityKeyCacheForDatabase(database);
    }
    throw error;
  }
}

function ensureOpaquePrincipal(params: {
  kind: Exclude<MemoryPrincipalKind, "gateway-profile">;
  issuer: string;
  stableSubjectId: string;
  expiresAt?: number;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): MemoryPrincipal {
  const issuer = requireText(params.issuer, "issuer");
  const stableSubjectId = requireText(params.stableSubjectId, "stableSubjectId");
  const now = params.now ?? Date.now();
  if (params.expiresAt !== undefined && params.expiresAt <= now) {
    throw new TypeError("expiresAt must be in the future");
  }
  return runMemoryIdentityTransaction(params.options ?? {}, "memory-principal.ensure", (db) => {
    const subjectKey = identityLookupHmac({
      db,
      scope: principalLookupScope(params.kind, issuer),
      value: stableSubjectId,
    });
    const kysely = memoryIdentityDb(db);
    let row = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("memory_principals")
        .selectAll()
        .where("kind", "=", params.kind)
        .where("issuer", "=", issuer)
        .where("subject_key", "=", subjectKey),
    );
    if (!row) {
      const principalId = generateSecureUuid();
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("memory_principals")
          .values({
            principal_id: principalId,
            kind: params.kind,
            user_profile_id: null,
            issuer,
            subject_key: subjectKey,
            state: "active",
            evidence_revision: generateSecureUuid(),
            merged_into: null,
            expires_at: params.expiresAt ?? null,
            revoked_at: null,
            created_at: now,
            updated_at: now,
          })
          .onConflict((conflict) => conflict.doNothing()),
      );
      row = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("memory_principals")
          .selectAll()
          .where("kind", "=", params.kind)
          .where("issuer", "=", issuer)
          .where("subject_key", "=", subjectKey),
      );
    }
    if (!row) {
      throw new Error("memory principal could not be created");
    }
    const resolved = resolvePrincipalInDatabase(db, row.principal_id, now);
    if (resolved.kind !== "current") {
      throw new Error(`memory principal is not current: ${resolved.kind}`);
    }
    return resolved.principal;
  });
}

function ensureGatewayProfileMemoryPrincipalInDatabase(params: {
  db: DatabaseSync;
  requestedProfileId: string;
  resolvedProfileId: string;
  now: number;
}): MemoryPrincipal | undefined {
  const kysely = memoryIdentityDb(params.db);
  let head = executeSqliteQueryTakeFirstSync(
    params.db,
    kysely
      .selectFrom("memory_principals")
      .selectAll()
      .where("user_profile_id", "=", params.resolvedProfileId),
  );
  if (!head) {
    const principalId = generateSecureUuid();
    executeSqliteQuerySync(
      params.db,
      kysely
        .insertInto("memory_principals")
        .values({
          principal_id: principalId,
          kind: "gateway-profile",
          user_profile_id: params.resolvedProfileId,
          issuer: null,
          subject_key: null,
          state: "active",
          evidence_revision: generateSecureUuid(),
          merged_into: null,
          expires_at: null,
          revoked_at: null,
          created_at: params.now,
          updated_at: params.now,
        })
        .onConflict((conflict) => conflict.doNothing()),
    );
    head = executeSqliteQueryTakeFirstSync(
      params.db,
      kysely
        .selectFrom("memory_principals")
        .selectAll()
        .where("user_profile_id", "=", params.resolvedProfileId),
    );
  }
  if (!head) {
    throw new Error("Gateway profile memory principal could not be created");
  }
  if (params.requestedProfileId !== params.resolvedProfileId) {
    const source = executeSqliteQueryTakeFirstSync(
      params.db,
      kysely
        .selectFrom("memory_principals")
        .selectAll()
        .where("user_profile_id", "=", params.requestedProfileId),
    );
    if (source && source.principal_id !== head.principal_id && source.state !== "revoked") {
      executeSqliteQuerySync(
        params.db,
        kysely
          .updateTable("memory_principals")
          .set({ state: "merged", merged_into: head.principal_id, updated_at: params.now })
          .where("principal_id", "=", source.principal_id),
      );
    }
  }
  const resolved = resolvePrincipalInDatabase(params.db, head.principal_id, params.now);
  return resolved.kind === "current" ? resolved.principal : undefined;
}

/** Resolves one authenticated durable Gateway profile into its canonical principal. */
function ensureGatewayProfileMemoryPrincipal(
  profileId: string,
  options: OpenClawStateDatabaseOptions = {},
): MemoryPrincipal | undefined {
  const requestedProfileId = requireText(profileId, "profileId");
  const resolvedProfileId = resolveUserProfileId(requestedProfileId, options);
  if (!resolvedProfileId) {
    return undefined;
  }
  const now = Date.now();
  return runMemoryIdentityTransaction(options, "memory-principal.gateway-profile.ensure", (db) =>
    ensureGatewayProfileMemoryPrincipalInDatabase({
      db,
      requestedProfileId,
      resolvedProfileId,
      now,
    }),
  );
}

/**
 * Ensures a profile principal inside the caller's approval transaction.
 * The caller must ensure the additive identity schema before opening it.
 */
function ensureGatewayProfileMemoryPrincipalInTransaction(params: {
  database: OpenClawStateDatabase;
  profileId: string;
  now?: number;
}): MemoryPrincipal | undefined {
  const requestedProfileId = requireText(params.profileId, "profileId");
  const resolvedProfileId = resolveUserProfileIdInTransaction({
    database: params.database,
    profileId: requestedProfileId,
  });
  if (!resolvedProfileId) {
    return undefined;
  }
  return ensureGatewayProfileMemoryPrincipalInDatabase({
    db: params.database.db,
    requestedProfileId,
    resolvedProfileId,
    now: params.now ?? Date.now(),
  });
}

function ensureEnterpriseMemoryPrincipal(params: {
  issuer: string;
  stableSubjectId: string;
  expiresAt?: number;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): MemoryPrincipal {
  return ensureOpaquePrincipal({ ...params, kind: "enterprise" });
}

function ensureExplicitMemoryPrincipal(params: {
  kind: "service" | "agent" | "system";
  issuer?: string;
  stableSubjectId: string;
  expiresAt?: number;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): MemoryPrincipal {
  return ensureOpaquePrincipal({
    ...params,
    issuer: params.issuer ?? "openclaw",
  });
}

function ensureConversationMemoryPrincipal(params: {
  channel: string;
  accountId: string;
  conversationId: string;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): MemoryPrincipal {
  const channel = normalizeChannel(params.channel);
  const accountId = requireText(params.accountId, "accountId");
  return ensureOpaquePrincipal({
    kind: "conversation",
    issuer: channel,
    stableSubjectId: JSON.stringify([
      accountId,
      requireText(params.conversationId, "conversationId"),
    ]),
    now: params.now,
    options: params.options,
  });
}

type MemoryIdentityBindingRecordParams = {
  channel: string;
  accountId: string;
  stableSenderId: string;
  principalId: string;
  adapterId: string;
  assurance: MemoryIdentityBindingAssurance;
  verificationMethod: MemoryIdentityVerificationMethod;
  evidenceRevision: string;
  createdBy: string;
  expiresAt?: number;
  now?: number;
};

/** Records verified channel-to-principal evidence without retaining the raw sender identifier. */
function createMemoryIdentityBindingInDatabase(
  params: MemoryIdentityBindingRecordParams,
  db: DatabaseSync,
): MemoryIdentityBinding {
  const channel = normalizeChannel(params.channel);
  const accountId = requireText(params.accountId, "accountId");
  const stableSenderId = requireText(params.stableSenderId, "stableSenderId");
  const principalId = requireText(params.principalId, "principalId");
  const adapterId = requireText(params.adapterId, "adapterId");
  const verificationMethod = requireVerificationMethod(params.verificationMethod);
  const evidenceRevision = requireText(params.evidenceRevision, "evidenceRevision");
  const createdBy = requireText(params.createdBy, "createdBy");
  const now = params.now ?? Date.now();
  if (params.expiresAt !== undefined && params.expiresAt <= now) {
    throw new TypeError("expiresAt must be in the future");
  }
  const principal = resolvePrincipalInDatabase(db, principalId, now);
  if (principal.kind !== "current") {
    throw new Error(`memory binding principal is not current: ${principal.kind}`);
  }
  if (principal.principal.kind !== "gateway-profile" && principal.principal.kind !== "enterprise") {
    throw new Error(
      `memory binding principal must be a verified user: ${principal.principal.kind}`,
    );
  }
  const bindingId = generateSecureUuid();
  const senderLookupHmac = identityLookupHmac({
    db,
    scope: bindingLookupScope(channel, accountId),
    value: stableSenderId,
  });
  const dbQuery = memoryIdentityDb(db);
  executeSqliteQuerySync(
    db,
    dbQuery.insertInto("memory_identity_bindings").values({
      binding_id: bindingId,
      channel,
      account_id: accountId,
      sender_lookup_hmac: senderLookupHmac,
      principal_id: principal.principal.principalId,
      adapter_id: adapterId,
      assurance: params.assurance,
      verification_method: verificationMethod,
      evidence_revision: evidenceRevision,
      created_by: createdBy,
      created_at: now,
      expires_at: params.expiresAt ?? null,
      revoked_at: null,
      revoked_by: null,
      revocation_reason: null,
    }),
  );
  const row = executeSqliteQueryTakeFirstSync(
    db,
    dbQuery.selectFrom("memory_identity_bindings").selectAll().where("binding_id", "=", bindingId),
  );
  if (!row) {
    throw new Error("memory identity binding could not be created");
  }
  return toMemoryIdentityBinding(row);
}

/**
 * Writes an admin link only from a one-shot pairing proof minted while its
 * request was consumed. OAuth gets its own verifier rather than widening this
 * pairing-only owner boundary.
 */
function createMemoryIdentityBindingFromApprovedChannelPairing(params: {
  database: OpenClawStateDatabase;
  approval: unknown;
  principalId: string;
  creatorProfileId: string;
  now?: number;
}): MemoryIdentityBinding {
  try {
    const approval = consumeChannelPairingMemoryIdentityApproval({
      approval: params.approval,
      database: params.database,
    });
    if (!approval) {
      throw new TypeError("memory identity binding requires a consumed channel pairing approval");
    }
    const createdBy = resolveUserProfileIdInTransaction({
      database: params.database,
      profileId: requireText(params.creatorProfileId, "creatorProfileId"),
    });
    if (!createdBy) {
      throw new Error("memory identity binding creator is not current");
    }
    return createMemoryIdentityBindingInDatabase(
      {
        channel: approval.channel,
        accountId: approval.accountId,
        stableSenderId: approval.stableSenderId,
        principalId: params.principalId,
        adapterId: approval.channel,
        assurance: "adapter-attested",
        verificationMethod: "admin-link",
        evidenceRevision: `pairing-request:${approval.requestId}`,
        createdBy,
        now: params.now,
      },
      params.database.db,
    );
  } catch (error) {
    // The keyed HMAC helper may have created its key in the surrounding
    // transaction. Let the retry reconstruct it after that transaction rolls back.
    clearAuditIdentityKeyCacheForDatabase(params.database.db);
    throw error;
  }
}

/** Revokes a binding while retaining its verification history. */
function revokeMemoryIdentityBinding(params: {
  bindingId: string;
  revokedBy: string;
  reason?: string;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): boolean {
  const bindingId = requireText(params.bindingId, "bindingId");
  const revokedBy = requireText(params.revokedBy, "revokedBy");
  const reason = params.reason?.trim() || null;
  const now = params.now ?? Date.now();
  return runMemoryIdentityTransaction(
    params.options ?? {},
    "memory-identity-binding.revoke",
    (db) => {
      const result = executeSqliteQuerySync(
        db,
        memoryIdentityDb(db)
          .updateTable("memory_identity_bindings")
          .set({ revoked_at: now, revoked_by: revokedBy, revocation_reason: reason })
          .where("binding_id", "=", bindingId)
          .where("revoked_at", "is", null),
      );
      return Number(result.numAffectedRows ?? 0n) > 0;
    },
  );
}

/** Resolves active evidence to exactly one current merge head; ambiguity fails closed. */
function resolveMemoryIdentityBinding(params: {
  channel: string;
  accountId: string;
  stableSenderId: string;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): MemoryIdentityBindingResolution {
  const channel = normalizeChannel(params.channel);
  const accountId = requireText(params.accountId, "accountId");
  const stableSenderId = requireText(params.stableSenderId, "stableSenderId");
  const options = params.options ?? {};
  const now = params.now ?? Date.now();
  ensureMemoryIdentitySchema(options);
  const { db } = openOpenClawStateDatabase(options);
  const senderLookupHmac = identityLookupHmac({
    db,
    scope: bindingLookupScope(channel, accountId),
    value: stableSenderId,
  });
  const active = resolveCurrentMemoryIdentityBindingsByLookup({
    db,
    channel,
    accountId,
    senderLookupHmac,
    now,
  });
  if (active.length === 0) {
    return { kind: "unbound" };
  }
  // More than one active record is operationally ambiguous. A renewal must
  // revoke the superseded evidence rather than leave issuance nondeterministic.
  if (active.length !== 1) {
    return { kind: "conflicting-bindings" };
  }
  const activeBinding = active[0];
  if (!activeBinding) {
    return { kind: "conflicting-bindings" };
  }
  const { row, principal } = activeBinding;
  return {
    kind: "verified",
    bindingId: row.binding_id,
    principalId: principal.principalId,
    assurance: row.assurance as MemoryIdentityBindingAssurance,
    evidenceRevision: row.evidence_revision,
    ...(optionalNumber(row.expires_at) === undefined
      ? {}
      : { expiresAt: row.expires_at ?? undefined }),
  };
}

function resolveCurrentMemoryIdentityBindingsByLookup(params: {
  db: DatabaseSync;
  channel: string;
  accountId: string;
  senderLookupHmac: string;
  now: number;
}): Array<{ row: MemoryIdentityBindingRow; principal: MemoryPrincipal }> {
  const rows = executeSqliteQuerySync(
    params.db,
    memoryIdentityDb(params.db)
      .selectFrom("memory_identity_bindings")
      .selectAll()
      .where("channel", "=", params.channel)
      .where("account_id", "=", params.accountId)
      .where("sender_lookup_hmac", "=", params.senderLookupHmac)
      .orderBy("created_at", "asc")
      .orderBy("binding_id", "asc"),
  ).rows;
  const active: Array<{ row: MemoryIdentityBindingRow; principal: MemoryPrincipal }> = [];
  for (const row of rows) {
    if (row.revoked_at !== null || (row.expires_at !== null && row.expires_at <= params.now)) {
      continue;
    }
    const principal = resolvePrincipalInDatabase(params.db, row.principal_id, params.now);
    if (principal.kind === "current" && isVerifiedMemoryUserPrincipal(principal.principal)) {
      active.push({ row, principal: principal.principal });
    }
  }
  return active;
}

/** Rechecks one captured binding and its current principal merge head. */
function resolveCurrentMemoryIdentityBinding(params: {
  bindingId: string;
  principalId: string;
  evidenceRevision: string;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): MemoryIdentityBindingResolution {
  const options = params.options ?? {};
  const now = params.now ?? Date.now();
  ensureMemoryIdentitySchema(options);
  const { db } = openOpenClawStateDatabase(options);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    memoryIdentityDb(db)
      .selectFrom("memory_identity_bindings")
      .selectAll()
      .where("binding_id", "=", requireText(params.bindingId, "bindingId")),
  );
  if (
    !row ||
    row.evidence_revision !== requireText(params.evidenceRevision, "evidenceRevision") ||
    row.revoked_at !== null ||
    (row.expires_at !== null && row.expires_at <= now)
  ) {
    return { kind: "unbound" };
  }
  const active = resolveCurrentMemoryIdentityBindingsByLookup({
    db,
    channel: row.channel,
    accountId: row.account_id,
    senderLookupHmac: row.sender_lookup_hmac,
    now,
  });
  if (active.length !== 1 || active[0]?.row.binding_id !== row.binding_id) {
    return { kind: "unbound" };
  }
  const bindingPrincipal = active[0].principal;
  const capturedPrincipal = resolvePrincipalInDatabase(
    db,
    requireText(params.principalId, "principalId"),
    now,
  );
  if (
    capturedPrincipal.kind !== "current" ||
    !isVerifiedMemoryUserPrincipal(capturedPrincipal.principal) ||
    bindingPrincipal.principalId !== capturedPrincipal.principal.principalId
  ) {
    return { kind: "unbound" };
  }
  return {
    kind: "verified",
    bindingId: row.binding_id,
    principalId: bindingPrincipal.principalId,
    assurance: row.assurance as MemoryIdentityBindingAssurance,
    evidenceRevision: row.evidence_revision,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  };
}

function resolveMemoryPrincipal(
  principalId: string,
  options: OpenClawStateDatabaseOptions = {},
  now = Date.now(),
): MemoryPrincipalResolution {
  ensureMemoryIdentitySchema(options);
  return resolvePrincipalInDatabase(
    openOpenClawStateDatabase(options).db,
    requireText(principalId, "principalId"),
    now,
  );
}

/** Leaves a durable tombstone that redirects future authority checks to one head. */
function mergeMemoryPrincipals(params: {
  sourcePrincipalId: string;
  targetPrincipalId: string;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): MemoryPrincipal {
  const sourcePrincipalId = requireText(params.sourcePrincipalId, "sourcePrincipalId");
  const targetPrincipalId = requireText(params.targetPrincipalId, "targetPrincipalId");
  if (sourcePrincipalId === targetPrincipalId) {
    throw new TypeError("memory principal cannot merge into itself");
  }
  const now = params.now ?? Date.now();
  return runMemoryIdentityTransaction(params.options ?? {}, "memory-principal.merge", (db) => {
    const source = resolvePrincipalInDatabase(db, sourcePrincipalId, now);
    const target = resolvePrincipalInDatabase(db, targetPrincipalId, now);
    if (source.kind !== "current" || target.kind !== "current") {
      throw new Error("memory principal merge requires two current principals");
    }
    if (source.principal.principalId === target.principal.principalId) {
      return target.principal;
    }
    if (
      memoryPrincipalMergeClass(source.principal.kind) !==
      memoryPrincipalMergeClass(target.principal.kind)
    ) {
      throw new Error("memory principal merge requires compatible principal kinds");
    }
    executeSqliteQuerySync(
      db,
      memoryIdentityDb(db)
        .updateTable("memory_principals")
        .set({ state: "merged", merged_into: target.principal.principalId, updated_at: now })
        .where("principal_id", "=", source.principal.principalId),
    );
    return target.principal;
  });
}

function revokeMemoryPrincipal(params: {
  principalId: string;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): boolean {
  const principalId = requireText(params.principalId, "principalId");
  const now = params.now ?? Date.now();
  return runMemoryIdentityTransaction(params.options ?? {}, "memory-principal.revoke", (db) => {
    const result = executeSqliteQuerySync(
      db,
      memoryIdentityDb(db)
        .updateTable("memory_principals")
        .set({ state: "revoked", revoked_at: now, updated_at: now })
        .where("principal_id", "=", principalId)
        .where("state", "=", "active"),
    );
    return Number(result.numAffectedRows ?? 0n) > 0;
  });
}

/** Core-owned lifecycle for canonical principals and verified transport bindings. */
export const memoryIdentityLifecycle = Object.freeze({
  createMemoryIdentityBindingFromApprovedChannelPairing,
  ensureConversationMemoryPrincipal,
  ensureEnterpriseMemoryPrincipal,
  ensureExplicitMemoryPrincipal,
  ensureGatewayProfileMemoryPrincipal,
  ensureGatewayProfileMemoryPrincipalInTransaction,
  mergeMemoryPrincipals,
  resolveCurrentMemoryIdentityBinding,
  resolveMemoryIdentityBinding,
  resolveMemoryPrincipal,
  revokeMemoryIdentityBinding,
  revokeMemoryPrincipal,
});
