/** Core-only construction of a memory authorization context from persisted session provenance. */
import { stableStringify } from "@openclaw/normalization-core";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { sha256Hex } from "../../infra/crypto-digest.js";
import type {
  MemoryAccessContext,
  MemoryOperation,
} from "../../memory-host-sdk/host/authorization.js";
import {
  failSessionMemoryAccessContext,
  readTrustedMemoryAccessHostFacts,
  sessionMemoryAccessContextFailureCode,
  type SessionMemoryAccessContextFailureCode,
  type SessionMemoryAccessHostFacts,
  type TrustedMemoryAccessHostFacts,
} from "./session-memory-access-host-facts.js";
import {
  readCurrentSessionMemorySubjectAuthority,
  type SessionMemorySubjectAuthority,
} from "./session-memory-subject-access.js";
import {
  SessionMemorySubjectReboundError,
  type TrustedSessionMemorySubjectSnapshot,
} from "./session-memory-subject.js";

const trustedAccessContextBrand: unique symbol = Symbol(
  "openclaw.trusted-session-memory-access-context",
);
const trustedAccessContexts = new WeakSet<object>();
const accessContextSnapshots = new WeakMap<
  TrustedSessionMemoryAccessContext,
  MemoryAccessContext
>();

/** Opaque in-process handle; the serializable DTO remains in this module's private WeakMap. */
export type TrustedSessionMemoryAccessContext = Readonly<{
  version: 1;
  operation: MemoryOperation;
  contextFingerprint: string;
}>;

export type { SessionMemoryAccessContextFailureCode, TrustedMemoryAccessHostFacts };

function fail(code: SessionMemoryAccessContextFailureCode = "invalid-context"): never {
  return failSessionMemoryAccessContext(code);
}

function failureCode(error: unknown): SessionMemoryAccessContextFailureCode {
  if (error instanceof SessionMemorySubjectReboundError) {
    return "session-rebound";
  }
  return sessionMemoryAccessContextFailureCode(error);
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
  Object.defineProperty(value, trustedAccessContextBrand, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  trustedAccessContexts.add(value);
  return deepFreeze(value);
}

function isTrustedSessionMemoryAccessContextHandle(
  value: unknown,
): value is TrustedSessionMemoryAccessContext {
  return Boolean(
    value &&
    typeof value === "object" &&
    trustedAccessContexts.has(value) &&
    (value as Record<PropertyKey, unknown>)[trustedAccessContextBrand] === true &&
    Object.isFrozen(value),
  );
}

function authorityFailure(
  authority: SessionMemorySubjectAuthority,
): SessionMemoryAccessContextFailureCode {
  return authority.kind === "denied" && authority.reason === "shared-main-private-subject"
    ? "outside-view"
    : authority.kind === "denied" && authority.reason === "ambiguous"
      ? "invalid-context"
      : "identity-revoked";
}

function snapshotMatches(
  left: TrustedSessionMemorySubjectSnapshot,
  right: TrustedSessionMemorySubjectSnapshot,
): boolean {
  return (
    left.sessionKey === right.sessionKey &&
    left.sessionId === right.sessionId &&
    left.sessionIdentityRevision === right.sessionIdentityRevision &&
    left.subjectRevision === right.subjectRevision &&
    stableStringify(left.subject) === stableStringify(right.subject) &&
    left.creationBindingId === right.creationBindingId &&
    left.canonicalConversationRef === right.canonicalConversationRef
  );
}

function authorityMatches(
  left: SessionMemorySubjectAuthority,
  right: SessionMemorySubjectAuthority,
): boolean {
  return stableStringify(left) === stableStringify(right);
}

function assertHostFactsMatchCurrentIdentity(
  facts: SessionMemoryAccessHostFacts,
  snapshot: TrustedSessionMemorySubjectSnapshot,
  authority: SessionMemorySubjectAuthority,
): void {
  if (authority.kind !== "current") {
    fail(authorityFailure(authority));
  }
  if (snapshot.subject.kind === "conversation") {
    const conversation = facts.conversation;
    if (
      !conversation ||
      conversation.conversationPrincipalId !== snapshot.subject.conversationPrincipalId ||
      conversation.channel !== snapshot.subject.channel ||
      conversation.accountId !== snapshot.subject.accountId
    ) {
      fail("outside-view");
    }
    return;
  }
  const principalId = authority.currentPrincipalId;
  const assurance = authority.assurance;
  const evidenceRevision = authority.evidenceRevision;
  if (!principalId || !assurance || !evidenceRevision) {
    fail("identity-revoked");
  }
  const principal = facts.verifiedPrincipals.find((entry) => entry.principalId === principalId);
  if (
    !principal ||
    principal.assurance !== assurance ||
    principal.evidenceRevision !== evidenceRevision ||
    (authority.expiresAt === undefined
      ? principal.expiresAt !== undefined
      : principal.expiresAt !== new Date(authority.expiresAt).toISOString())
  ) {
    fail("identity-revoked");
  }
}

function resolveHostFactsSnapshot(value: unknown) {
  const snapshot = readTrustedMemoryAccessHostFacts(value);
  if (!snapshot) {
    fail();
  }
  return snapshot;
}

/** Creates a context only from an exact core-issued host-facts handle and a fresh subject read. */
export function createTrustedSessionMemoryAccessContext(params: {
  hostFacts: TrustedMemoryAccessHostFacts;
}): Result<TrustedSessionMemoryAccessContext, SessionMemoryAccessContextFailureCode> {
  try {
    // Recheck identity authority against the host-owned current time, not a
    // time supplied by the context caller.
    const now = Date.now();
    const host = resolveHostFactsSnapshot(params.hostFacts);
    const current = readCurrentSessionMemorySubjectAuthority(host.scope, host.stateOptions, now);
    if (!current) {
      fail("session-rebound");
    }
    assertHostFactsMatchCurrentIdentity(host.facts, current.snapshot, current.authority);
    const dtoWithoutFingerprint = {
      version: 1 as const,
      ...host.facts,
      sessionKey: current.snapshot.sessionKey,
      sessionId: current.snapshot.sessionId,
      sessionIdentityRevision: current.snapshot.sessionIdentityRevision,
      subjectRevision: current.snapshot.subjectRevision,
      subject: current.snapshot.subject,
    } satisfies Omit<MemoryAccessContext, "contextFingerprint">;
    const contextFingerprint = `sha256:${sha256Hex(stableStringify(dtoWithoutFingerprint))}`;
    // Recheck after all host facts have been bound. Any reset, rehome, revoke,
    // or binding merge between reads makes the context unusable rather than stale.
    const rechecked = readCurrentSessionMemorySubjectAuthority(host.scope, host.stateOptions, now);
    if (!rechecked || !snapshotMatches(current.snapshot, rechecked.snapshot)) {
      fail("session-rebound");
    }
    if (!authorityMatches(current.authority, rechecked.authority)) {
      fail(authorityFailure(rechecked.authority));
    }
    assertHostFactsMatchCurrentIdentity(host.facts, rechecked.snapshot, rechecked.authority);
    const dto = deepFreeze({
      ...dtoWithoutFingerprint,
      contextFingerprint,
    } satisfies MemoryAccessContext);
    const context = brandAndFreeze({
      version: 1 as const,
      operation: dto.operation,
      contextFingerprint,
    }) as TrustedSessionMemoryAccessContext;
    accessContextSnapshots.set(context, dto);
    return ok(context);
  } catch (error) {
    return err(failureCode(error));
  }
}

/** True only for an exact opaque context minted by this module in this process. */
export function isTrustedSessionMemoryAccessContext(
  value: unknown,
): value is TrustedSessionMemoryAccessContext {
  return isTrustedSessionMemoryAccessContextHandle(value);
}

/** Core-only bridge to the frozen serializable DTO passed to the selected memory plugin. */
export function readTrustedSessionMemoryAccessContext(
  value: unknown,
): MemoryAccessContext | undefined {
  return isTrustedSessionMemoryAccessContext(value) ? accessContextSnapshots.get(value) : undefined;
}
