import { generateSecureUuid } from "../../infra/secure-random.js";
import type { SessionMemorySubject } from "../../memory-host-sdk/host/authorization.js";

const trustedSeedBrand: unique symbol = Symbol("openclaw.trusted-session-memory-subject-seed");
const trustedIssuerBrand: unique symbol = Symbol("openclaw.trusted-session-memory-subject-issuer");
const trustedSnapshotBrand: unique symbol = Symbol(
  "openclaw.trusted-session-memory-subject-snapshot",
);
const trustedSeeds = new WeakSet<object>();
const trustedIssuers = new WeakSet<object>();
const trustedSnapshots = new WeakSet<object>();

export type SessionMemoryScope = "conversation" | "shared-main" | "group" | "channel";

export type TrustedSessionMemorySubjectSeed = Readonly<{
  [trustedSeedBrand]: true;
  subject: SessionMemorySubject;
  subjectRevision: string;
  creationBindingId?: string;
  canonicalConversationRef?: string;
}>;

/**
 * A core-only issuer defers identity resolution to the write transaction. Its
 * closure is intentionally non-serializable so untrusted context cannot mint a subject.
 */
export type TrustedSessionMemorySubjectIssuer = Readonly<{
  [trustedIssuerBrand]: true;
  issue: () => TrustedSessionMemorySubjectSeed;
}>;

export type TrustedSessionMemorySubjectSnapshot = Readonly<{
  [trustedSnapshotBrand]: true;
  sessionKey: string;
  sessionId: string;
  sessionScope: SessionMemoryScope;
  sessionIdentityRevision: string;
  subjectRevision: string;
  subject: SessionMemorySubject;
  creationBindingId?: string;
  canonicalConversationRef?: string;
}>;

export class SessionMemorySubjectReboundError extends Error {
  readonly code = "SESSION_MEMORY_SUBJECT_REBOUND";

  constructor(sessionId: string) {
    super(`Session memory subject snapshot conflicts with reused session id: ${sessionId}`);
    this.name = "SessionMemorySubjectReboundError";
  }
}

export class InvalidSessionMemorySubjectSeedError extends Error {
  readonly code = "INVALID_SESSION_MEMORY_SUBJECT_SEED";

  constructor() {
    super("Session memory subject seed is not host-trusted");
    this.name = "InvalidSessionMemorySubjectSeedError";
  }
}

export function requireSessionMemorySubjectText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(`${label} must not be empty`);
  }
  return normalized;
}

function assertSubjectEvidenceKind(
  value: string,
): asserts value is Extract<SessionMemorySubject, { kind: "user" }>["creationEvidence"]["kind"] {
  if (
    value !== "gateway-profile" &&
    value !== "channel-binding" &&
    value !== "adapter-attested" &&
    value !== "explicit-service"
  ) {
    throw new TypeError("unsupported session memory subject evidence kind");
  }
}

function assertAmbiguousReason(
  value: string,
): asserts value is Extract<SessionMemorySubject, { kind: "ambiguous" }>["reason"] {
  if (value !== "shared-main" && value !== "unbound" && value !== "conflicting-bindings") {
    throw new TypeError("unsupported ambiguous session memory subject reason");
  }
}

function cloneSubject(subject: SessionMemorySubject): SessionMemorySubject {
  if (subject.version !== 1) {
    throw new TypeError("unsupported session memory subject version");
  }
  switch (subject.kind) {
    case "user": {
      assertSubjectEvidenceKind(subject.creationEvidence.kind);
      return {
        version: 1,
        kind: "user",
        principalId: requireSessionMemorySubjectText(subject.principalId, "principalId"),
        creationEvidence: {
          kind: subject.creationEvidence.kind,
          revision: requireSessionMemorySubjectText(
            subject.creationEvidence.revision,
            "creation evidence revision",
          ),
        },
      };
    }
    case "conversation":
      return {
        version: 1,
        kind: "conversation",
        conversationPrincipalId: requireSessionMemorySubjectText(
          subject.conversationPrincipalId,
          "conversationPrincipalId",
        ),
        channel: requireSessionMemorySubjectText(subject.channel, "channel").toLowerCase(),
        accountId: requireSessionMemorySubjectText(subject.accountId, "accountId"),
      };
    case "service":
    case "agent":
    case "system":
      return {
        version: 1,
        kind: subject.kind,
        principalId: requireSessionMemorySubjectText(subject.principalId, "principalId"),
      };
    case "ambiguous":
      assertAmbiguousReason(subject.reason);
      return { version: 1, kind: "ambiguous", reason: subject.reason };
  }
  throw new TypeError("unsupported session memory subject kind");
}

function deepFreeze<T extends object>(value: T): T {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object" && !Object.isFrozen(nested)) {
      deepFreeze(nested as object);
    }
  }
  return Object.freeze(value);
}

export function createTrustedSessionMemorySubjectSeed(params: {
  subject: SessionMemorySubject;
  subjectRevision?: string;
  creationBindingId?: string;
  canonicalConversationRef?: string;
}): TrustedSessionMemorySubjectSeed {
  const subject = cloneSubject(params.subject);
  const creationBindingId =
    params.creationBindingId === undefined
      ? undefined
      : requireSessionMemorySubjectText(params.creationBindingId, "creationBindingId");
  const requiresBindingId =
    subject.kind === "user" && subject.creationEvidence.kind === "channel-binding";
  if (requiresBindingId !== (creationBindingId !== undefined)) {
    throw new TypeError("channel-binding subjects must carry exactly one creationBindingId");
  }
  const seed = {
    subject,
    subjectRevision: requireSessionMemorySubjectText(
      params.subjectRevision ?? generateSecureUuid(),
      "subjectRevision",
    ),
    ...(creationBindingId ? { creationBindingId } : {}),
    ...(params.canonicalConversationRef
      ? {
          canonicalConversationRef: requireSessionMemorySubjectText(
            params.canonicalConversationRef,
            "canonicalConversationRef",
          ),
        }
      : {}),
  } as Omit<TrustedSessionMemorySubjectSeed, typeof trustedSeedBrand> & {
    [trustedSeedBrand]?: true;
  };
  Object.defineProperty(seed, trustedSeedBrand, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  trustedSeeds.add(seed);
  return deepFreeze(seed) as TrustedSessionMemorySubjectSeed;
}

export function isTrustedSessionMemorySubjectSeed(
  value: unknown,
): value is TrustedSessionMemorySubjectSeed {
  return Boolean(
    value &&
    typeof value === "object" &&
    trustedSeeds.has(value) &&
    (value as Record<symbol, unknown>)[trustedSeedBrand] === true &&
    Object.isFrozen(value),
  );
}

export function createTrustedSessionMemorySubjectIssuer(
  issue: () => TrustedSessionMemorySubjectSeed,
): TrustedSessionMemorySubjectIssuer {
  const issuer = { issue } as Omit<TrustedSessionMemorySubjectIssuer, typeof trustedIssuerBrand> & {
    [trustedIssuerBrand]?: true;
  };
  Object.defineProperty(issuer, trustedIssuerBrand, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  trustedIssuers.add(issuer);
  return Object.freeze(issuer) as TrustedSessionMemorySubjectIssuer;
}

export function isTrustedSessionMemorySubjectIssuer(
  value: unknown,
): value is TrustedSessionMemorySubjectIssuer {
  return Boolean(
    value &&
    typeof value === "object" &&
    trustedIssuers.has(value) &&
    (value as Record<symbol, unknown>)[trustedIssuerBrand] === true &&
    Object.isFrozen(value),
  );
}

export function issueTrustedSessionMemorySubject(
  issuer: TrustedSessionMemorySubjectIssuer,
): TrustedSessionMemorySubjectSeed {
  if (!isTrustedSessionMemorySubjectIssuer(issuer)) {
    throw new InvalidSessionMemorySubjectSeedError();
  }
  const seed = issuer.issue();
  if (!isTrustedSessionMemorySubjectSeed(seed)) {
    throw new InvalidSessionMemorySubjectSeedError();
  }
  return seed;
}

export function createTrustedSessionMemorySubjectSnapshot(params: {
  sessionKey: string;
  sessionId: string;
  sessionScope: SessionMemoryScope;
  sessionIdentityRevision: string;
  subjectRevision: string;
  subject: SessionMemorySubject;
  creationBindingId?: string;
  canonicalConversationRef?: string;
}): TrustedSessionMemorySubjectSnapshot {
  const snapshot = {
    sessionKey: requireSessionMemorySubjectText(params.sessionKey, "sessionKey"),
    sessionId: requireSessionMemorySubjectText(params.sessionId, "sessionId"),
    sessionScope: params.sessionScope,
    sessionIdentityRevision: requireSessionMemorySubjectText(
      params.sessionIdentityRevision,
      "sessionIdentityRevision",
    ),
    subjectRevision: requireSessionMemorySubjectText(params.subjectRevision, "subjectRevision"),
    subject: cloneSubject(params.subject),
    ...(params.creationBindingId
      ? {
          creationBindingId: requireSessionMemorySubjectText(
            params.creationBindingId,
            "creationBindingId",
          ),
        }
      : {}),
    ...(params.canonicalConversationRef
      ? {
          canonicalConversationRef: requireSessionMemorySubjectText(
            params.canonicalConversationRef,
            "canonicalConversationRef",
          ),
        }
      : {}),
  } as Omit<TrustedSessionMemorySubjectSnapshot, typeof trustedSnapshotBrand> & {
    [trustedSnapshotBrand]?: true;
  };
  Object.defineProperty(snapshot, trustedSnapshotBrand, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  trustedSnapshots.add(snapshot);
  return deepFreeze(snapshot) as TrustedSessionMemorySubjectSnapshot;
}

export function isTrustedSessionMemorySubjectSnapshot(
  value: unknown,
): value is TrustedSessionMemorySubjectSnapshot {
  return Boolean(
    value &&
    typeof value === "object" &&
    trustedSnapshots.has(value) &&
    (value as Record<symbol, unknown>)[trustedSnapshotBrand] === true &&
    Object.isFrozen(value),
  );
}

/** Copies exact persisted provenance; snapshot-shaped caller data is not lineage proof. */
export function prepareSessionMemorySubjectLineageSeed(
  snapshot: TrustedSessionMemorySubjectSnapshot,
): TrustedSessionMemorySubjectSeed {
  if (!isTrustedSessionMemorySubjectSnapshot(snapshot)) {
    throw new InvalidSessionMemorySubjectSeedError();
  }
  return createTrustedSessionMemorySubjectSeed({
    subject: snapshot.subject,
    subjectRevision: snapshot.subjectRevision,
    ...(snapshot.creationBindingId ? { creationBindingId: snapshot.creationBindingId } : {}),
    ...(snapshot.canonicalConversationRef
      ? { canonicalConversationRef: snapshot.canonicalConversationRef }
      : {}),
  });
}
