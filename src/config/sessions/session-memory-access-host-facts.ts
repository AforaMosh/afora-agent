/** Core-internal capture of trusted runtime facts for session-memory authorization. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  AudienceRef,
  MemoryAccessContext,
  MemoryActorEvidence,
  MemoryOperation,
  MemoryVerifiedMembership,
  VerifiedPrincipalRef,
} from "../../memory-host-sdk/host/authorization.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteScope } from "./session-accessor.sqlite-scope.js";

const trustedHostFactsBrand: unique symbol = Symbol("openclaw.trusted-memory-access-host-facts");
const trustedHostFacts = new WeakSet<object>();
const hostFactSnapshots = new WeakMap<
  TrustedMemoryAccessHostFacts,
  TrustedMemoryAccessHostFactsSnapshot
>();

const AUDIENCE_KINDS = [
  "user",
  "conversation",
  "role",
  "agent-shared",
  "agent",
  "internal",
] as const;
const ACTOR_KINDS = ["human", "agent", "service", "system"] as const;
const ASSURANCE_KINDS = ["gateway-profile", "adapter-attested", "oidc", "service"] as const;
const COLLABORATION_MODES = ["shared", "read-only", "suggest", "draft"] as const;
const COLLABORATION_ROLES = ["admin", "owner", "member", "viewer"] as const;
const DELIVERY_SINK_KINDS = ["private", "channel", "session", "internal"] as const;
const MEMORY_OPERATIONS = [
  "retrieve",
  "read",
  "append",
  "replace",
  "derive",
  "deposit",
  "project",
  "publish",
  "import",
  "export",
  "delete",
  "sync",
  "status",
  "policy-admin",
] as const satisfies readonly MemoryOperation[];

export type SessionMemoryAccessContextFailureCode =
  | "identity-revoked"
  | "invalid-context"
  | "outside-view"
  | "session-rebound";

export type SessionMemoryAccessHostFacts = Omit<
  MemoryAccessContext,
  | "contextFingerprint"
  | "sessionId"
  | "sessionIdentityRevision"
  | "subject"
  | "subjectRevision"
  | "version"
>;

export type TrustedMemoryAccessHostFacts = Readonly<{
  version: 1;
  operation: MemoryOperation;
  hostFactsRevision: string;
}>;

export type TrustedMemoryAccessHostFactsSnapshot = Readonly<{
  facts: SessionMemoryAccessHostFacts;
  scope: SessionAccessScope;
  stateOptions: OpenClawStateDatabaseOptions;
}>;

export class SessionMemoryAccessContextError extends Error {
  constructor(readonly code: SessionMemoryAccessContextFailureCode) {
    super(code);
    this.name = "SessionMemoryAccessContextError";
  }
}

export function failSessionMemoryAccessContext(
  code: SessionMemoryAccessContextFailureCode = "invalid-context",
): never {
  throw new SessionMemoryAccessContextError(code);
}

export function sessionMemoryAccessContextFailureCode(
  error: unknown,
): SessionMemoryAccessContextFailureCode {
  return error instanceof SessionMemoryAccessContextError ? error.code : "invalid-context";
}

function requireText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    failSessionMemoryAccessContext();
  }
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    failSessionMemoryAccessContext();
  }
  return value as T;
}

function ownDataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    failSessionMemoryAccessContext();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    failSessionMemoryAccessContext();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([...required, ...optional]);
  if (
    Object.getOwnPropertySymbols(value).length > 0 ||
    Object.keys(descriptors).length !==
      required.length + optional.filter((key) => key in descriptors).length ||
    !required.every((key) => key in descriptors) ||
    !Object.keys(descriptors).every((key) => allowed.has(key))
  ) {
    failSessionMemoryAccessContext();
  }
  const output: Record<string, unknown> = {};
  for (const key of [...required, ...optional]) {
    const descriptor = descriptors[key];
    if (!descriptor) {
      continue;
    }
    if (descriptor.enumerable !== true || !("value" in descriptor)) {
      failSessionMemoryAccessContext();
    }
    output[key] = descriptor.value;
  }
  return output;
}

function normalizeTimestamp(
  value: unknown,
  now: number,
  staleCode: SessionMemoryAccessContextFailureCode,
): string {
  const timestamp = requireText(value);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || milliseconds <= now) {
    failSessionMemoryAccessContext(staleCode);
  }
  return new Date(milliseconds).toISOString();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeSet<T>(
  values: readonly T[],
  key: (value: T) => string,
  rejectDuplicates = false,
): T[] {
  const entries = new Map<string, T>();
  for (const value of values) {
    const entryKey = key(value);
    if (rejectDuplicates && entries.has(entryKey)) {
      failSessionMemoryAccessContext();
    }
    entries.set(entryKey, value);
  }
  return [...entries.entries()]
    .toSorted(([left], [right]) => compareText(left, right))
    .map(([, value]) => value);
}

function normalizeAudience(value: unknown): AudienceRef {
  const record = ownDataRecord(value, ["kind", "id"]);
  return {
    kind: requireEnum(record.kind, AUDIENCE_KINDS),
    id: requireText(record.id),
  };
}

function normalizeAudiences(value: unknown): AudienceRef[] {
  if (!Array.isArray(value)) {
    failSessionMemoryAccessContext();
  }
  return normalizeSet(value.map(normalizeAudience), (entry) => `${entry.kind}\0${entry.id}`);
}

function normalizeStringSet(value: unknown): string[] {
  if (!Array.isArray(value)) {
    failSessionMemoryAccessContext();
  }
  return normalizeSet(value.map(requireText), (entry) => entry);
}

function normalizeOperationSet(value: unknown): MemoryOperation[] {
  if (!Array.isArray(value)) {
    failSessionMemoryAccessContext();
  }
  return normalizeSet(
    value.map((entry) => requireEnum(entry, MEMORY_OPERATIONS)),
    (entry) => entry,
  );
}

function normalizeActor(value: unknown, now: number): MemoryActorEvidence {
  const record = ownDataRecord(
    value,
    ["kind"],
    ["actorKind", "assurance", "evidenceRevision", "expiresAt", "principalId", "transportAuditRef"],
  );
  if (record.kind === "unattributed") {
    if (
      record.actorKind !== undefined ||
      record.assurance !== undefined ||
      record.expiresAt !== undefined ||
      record.principalId !== undefined ||
      record.transportAuditRef === undefined ||
      record.evidenceRevision === undefined
    ) {
      failSessionMemoryAccessContext();
    }
    return {
      kind: "unattributed",
      transportAuditRef: requireText(record.transportAuditRef),
      evidenceRevision: requireText(record.evidenceRevision),
    };
  }
  if (
    record.kind !== "principal" ||
    record.actorKind === undefined ||
    record.assurance === undefined ||
    record.evidenceRevision === undefined ||
    record.principalId === undefined ||
    record.transportAuditRef !== undefined
  ) {
    failSessionMemoryAccessContext();
  }
  return {
    kind: "principal",
    actorKind: requireEnum(record.actorKind, ACTOR_KINDS),
    principalId: requireText(record.principalId),
    assurance: requireEnum(record.assurance, ASSURANCE_KINDS),
    evidenceRevision: requireText(record.evidenceRevision),
    ...(record.expiresAt === undefined
      ? {}
      : { expiresAt: normalizeTimestamp(record.expiresAt, now, "identity-revoked") }),
  };
}

function normalizeVerifiedPrincipals(value: unknown, now: number): VerifiedPrincipalRef[] {
  if (!Array.isArray(value)) {
    failSessionMemoryAccessContext();
  }
  return normalizeSet(
    value.map((entry) => {
      const record = ownDataRecord(
        entry,
        ["assurance", "evidenceRevision", "principalId"],
        ["expiresAt"],
      );
      return {
        principalId: requireText(record.principalId),
        assurance: requireEnum(record.assurance, ASSURANCE_KINDS),
        evidenceRevision: requireText(record.evidenceRevision),
        ...(record.expiresAt === undefined
          ? {}
          : { expiresAt: normalizeTimestamp(record.expiresAt, now, "identity-revoked") }),
      } satisfies VerifiedPrincipalRef;
    }),
    (entry) => entry.principalId,
    true,
  );
}

function normalizeConversation(value: unknown): MemoryAccessContext["conversation"] {
  if (value === undefined) {
    return undefined;
  }
  const record = ownDataRecord(value, [
    "accountId",
    "channel",
    "conversationPrincipalId",
    "evidenceRevision",
  ]);
  return {
    conversationPrincipalId: requireText(record.conversationPrincipalId),
    channel: requireText(record.channel),
    accountId: requireText(record.accountId),
    evidenceRevision: requireText(record.evidenceRevision),
  };
}

function normalizeDelivery(value: unknown): MemoryAccessContext["delivery"] {
  const record = ownDataRecord(value, [
    "audiences",
    "deliveryRevision",
    "egressCapabilityIds",
    "egressRegistryRevision",
    "sinkKind",
  ]);
  return {
    sinkKind: requireEnum(record.sinkKind, DELIVERY_SINK_KINDS),
    audiences: normalizeAudiences(record.audiences),
    egressCapabilityIds: normalizeStringSet(record.egressCapabilityIds),
    egressRegistryRevision: requireText(record.egressRegistryRevision),
    deliveryRevision: requireText(record.deliveryRevision),
  };
}

function normalizeCollaboration(value: unknown): MemoryAccessContext["collaboration"] {
  const record = ownDataRecord(value, ["kind"], ["decisionRevision", "mode", "role"]);
  if (record.kind === "not-applicable") {
    if (
      record.decisionRevision !== undefined ||
      record.mode !== undefined ||
      record.role !== undefined
    ) {
      failSessionMemoryAccessContext();
    }
    return { kind: "not-applicable" };
  }
  if (
    record.kind !== "gateway-session" ||
    record.decisionRevision === undefined ||
    record.mode === undefined ||
    record.role === undefined
  ) {
    failSessionMemoryAccessContext();
  }
  return {
    kind: "gateway-session",
    mode: requireEnum(record.mode, COLLABORATION_MODES),
    role: requireEnum(record.role, COLLABORATION_ROLES),
    decisionRevision: requireText(record.decisionRevision),
  };
}

function normalizeMemberships(value: unknown, now: number): MemoryVerifiedMembership[] {
  if (!Array.isArray(value)) {
    failSessionMemoryAccessContext();
  }
  return normalizeSet(
    value.map((entry) => {
      const record = ownDataRecord(entry, [
        "evidenceRevision",
        "expiresAt",
        "groupId",
        "observedAt",
        "principalId",
        "provider",
      ]);
      return {
        principalId: requireText(record.principalId),
        groupId: requireText(record.groupId),
        provider: requireText(record.provider),
        evidenceRevision: requireText(record.evidenceRevision),
        observedAt: requireText(record.observedAt),
        expiresAt: normalizeTimestamp(record.expiresAt, now, "identity-revoked"),
      } satisfies MemoryVerifiedMembership;
    }),
    (entry) => `${entry.principalId}\0${entry.groupId}\0${entry.provider}`,
    true,
  );
}

function normalizeDelegation(value: unknown): MemoryAccessContext["delegation"] {
  if (value === undefined) {
    return undefined;
  }
  const record = ownDataRecord(value, [
    "allowedOperations",
    "capabilitySnapshotId",
    "depth",
    "maximumAudiences",
    "parentContextId",
    "parentMemoryPlanId",
    "rootContextId",
    "rootPrincipalId",
    "storeCapToken",
  ]);
  if (!Number.isInteger(record.depth) || (record.depth as number) < 1) {
    failSessionMemoryAccessContext();
  }
  return {
    rootPrincipalId: requireText(record.rootPrincipalId),
    rootContextId: requireText(record.rootContextId),
    parentContextId: requireText(record.parentContextId),
    parentMemoryPlanId: requireText(record.parentMemoryPlanId),
    capabilitySnapshotId: requireText(record.capabilitySnapshotId),
    allowedOperations: normalizeOperationSet(record.allowedOperations),
    maximumAudiences: normalizeAudiences(record.maximumAudiences),
    storeCapToken: requireText(record.storeCapToken),
    depth: record.depth as number,
  };
}

function normalizeHostFacts(value: unknown, now: number): SessionMemoryAccessHostFacts {
  const record = ownDataRecord(
    value,
    [
      "actor",
      "agentId",
      "collaboration",
      "contextId",
      "delivery",
      "hostFactsRevision",
      "operation",
      "requestId",
      "runId",
      "sessionKey",
      "verifiedMemberships",
      "verifiedPrincipals",
    ],
    ["conversation", "delegation"],
  );
  const conversation = normalizeConversation(record.conversation);
  const delegation = normalizeDelegation(record.delegation);
  return {
    contextId: requireText(record.contextId),
    requestId: requireText(record.requestId),
    runId: requireText(record.runId),
    agentId: requireText(record.agentId),
    sessionKey: requireText(record.sessionKey),
    actor: normalizeActor(record.actor, now),
    verifiedPrincipals: normalizeVerifiedPrincipals(record.verifiedPrincipals, now),
    ...(conversation === undefined ? {} : { conversation }),
    delivery: normalizeDelivery(record.delivery),
    collaboration: normalizeCollaboration(record.collaboration),
    verifiedMemberships: normalizeMemberships(record.verifiedMemberships, now),
    ...(delegation === undefined ? {} : { delegation }),
    operation: requireEnum(record.operation, MEMORY_OPERATIONS),
    hostFactsRevision: requireText(record.hostFactsRevision),
  };
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

function brandAndFreeze<T extends object>(value: T): T {
  Object.defineProperty(value, trustedHostFactsBrand, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  trustedHostFacts.add(value);
  return deepFreeze(value);
}

export function isTrustedMemoryAccessHostFacts(
  value: unknown,
): value is TrustedMemoryAccessHostFacts {
  return Boolean(
    value &&
    typeof value === "object" &&
    trustedHostFacts.has(value) &&
    (value as Record<PropertyKey, unknown>)[trustedHostFactsBrand] === true &&
    Object.isFrozen(value),
  );
}

/**
 * Core-internal ingress bridge. Only authenticated runtime code may capture a
 * raw facts bag here; the context factory accepts the opaque handle only.
 * Keep this module out of session-accessor and plugin-SDK barrels.
 */
export function issueTrustedMemoryAccessHostFactsFromCore(params: {
  facts: unknown;
  scope: SessionAccessScope;
  stateOptions?: OpenClawStateDatabaseOptions;
}): TrustedMemoryAccessHostFacts {
  // Expiry checks belong to the host clock. Accepting a caller-provided time
  // lets untrusted callers backdate expired evidence into a current context.
  const now = Date.now();
  const facts = normalizeHostFacts(params.facts, now);
  const resolvedScope = resolveSqliteScope(params.scope);
  if (facts.agentId !== resolvedScope.agentId || facts.sessionKey !== resolvedScope.sessionKey) {
    failSessionMemoryAccessContext("outside-view");
  }
  const scope: SessionAccessScope = {
    agentId: resolvedScope.agentId,
    sessionKey: resolvedScope.sessionKey,
    ...(params.scope.defaultAgentId ? { defaultAgentId: params.scope.defaultAgentId } : {}),
    ...(params.scope.env ? { env: params.scope.env } : {}),
    ...(params.scope.storePath ? { storePath: params.scope.storePath } : {}),
  };
  const hostFacts = brandAndFreeze({
    version: 1 as const,
    operation: facts.operation,
    hostFactsRevision: facts.hostFactsRevision,
  }) as TrustedMemoryAccessHostFacts;
  hostFactSnapshots.set(
    hostFacts,
    deepFreeze({ facts, scope, stateOptions: { ...(params.stateOptions ?? {}) } }),
  );
  return hostFacts;
}

/** Returns the private runtime snapshot for an exact handle minted in this process. */
export function readTrustedMemoryAccessHostFacts(
  value: unknown,
): TrustedMemoryAccessHostFactsSnapshot | undefined {
  return isTrustedMemoryAccessHostFacts(value) ? hostFactSnapshots.get(value) : undefined;
}
