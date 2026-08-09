/**
 * Core-owned attestation for the subject used to initialize an inbound channel session.
 *
 * Public SDK context/runner helpers remain deliberately unprivileged. Only the paired,
 * per-plugin core facade holds an opaque ingress object that this module recognizes.
 */
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { TrustedSessionMemorySubjectIssuer } from "../../config/sessions/session-memory-subject.js";
import type { DmScope } from "../../config/types.base.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../../sessions/session-key-utils.js";

export type ChannelInboundMemorySubjectFacts = Readonly<{
  agentId: unknown;
  accountId: unknown;
  channel: unknown;
  conversationId: unknown;
  conversationKind: unknown;
  dmScope: unknown;
  nativeChannelId: unknown;
  senderId: unknown;
  sessionKey: unknown;
}>;

type CoreChannelInboundMemorySubjectIngressRecord = Readonly<{
  ownsChannel: (channel: unknown) => boolean;
}>;

type RegisteredChannelInboundMemorySubjectFacts = Readonly<{
  facts: ChannelInboundMemorySubjectFacts;
  ingress: object;
}>;

type ChannelInboundMemorySubjectMarker = Readonly<{
  facts: ChannelInboundMemorySubjectFacts;
  ingress: object;
}>;

type BoundChannelInboundMemorySubjectIssuer = Readonly<{
  finalChannel: string;
  ingress: object;
  issuer: TrustedSessionMemorySubjectIssuer;
  sessionKey: string;
}>;

// Ingress authority is identity-only: serialization or a structural lookalike cannot recreate
// the private WeakSet membership. The callback also rechecks live channel ownership at use time.
const trustedIngresses = new WeakSet<object>();
const ingressRecords = new WeakMap<object, CoreChannelInboundMemorySubjectIngressRecord>();
const registeredFacts = new WeakMap<object, RegisteredChannelInboundMemorySubjectFacts>();
const attestedMarkers = new WeakMap<object, ChannelInboundMemorySubjectMarker>();
const boundIssuers = new WeakMap<object, BoundChannelInboundMemorySubjectIssuer>();

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeRequiredText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeChannel(value: unknown): string | undefined {
  return normalizeRequiredText(value)?.toLowerCase();
}

function normalizeAccountId(value: unknown): string | undefined {
  return normalizeRequiredText(value);
}

function normalizeAgentId(value: unknown): string | undefined {
  return normalizeRequiredText(value);
}

function normalizeDmScope(value: unknown): DmScope | undefined {
  const normalized = normalizeRequiredText(value)?.toLowerCase();
  return normalized === "main" ||
    normalized === "per-peer" ||
    normalized === "per-channel-peer" ||
    normalized === "per-account-channel-peer"
    ? normalized
    : undefined;
}

function normalizeBoundSessionKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() !== value || !value) {
    return undefined;
  }
  return normalizeSessionKeyPreservingOpaquePeerIds(value) || undefined;
}

function getTrustedIngressRecord(
  ingress: unknown,
): CoreChannelInboundMemorySubjectIngressRecord | undefined {
  if (!ingress || typeof ingress !== "object" || !trustedIngresses.has(ingress)) {
    return undefined;
  }
  return ingressRecords.get(ingress);
}

function hasLiveIngressChannel(ingress: unknown, channel: unknown): boolean {
  const record = getTrustedIngressRecord(ingress);
  return Boolean(record && normalizeChannel(channel) && record.ownsChannel(channel));
}

function createFacts(params: ChannelInboundMemorySubjectFacts): ChannelInboundMemorySubjectFacts {
  return Object.freeze({ ...params });
}

/** Creates the non-SDK ingress capability held only by a core-injected paired facade. */
export function createCoreChannelInboundMemorySubjectIngress(params: {
  ownsChannel: (channel: unknown) => boolean;
}): object {
  const ingress = Object.freeze(Object.create(null)) as object;
  trustedIngresses.add(ingress);
  ingressRecords.set(
    ingress,
    Object.freeze({
      ownsChannel: params.ownsChannel,
    }),
  );
  return ingress;
}

/** Registers pre-extra structured facts only for a live, trusted core ingress facade. */
export function registerCoreChannelInboundMemorySubjectFacts(
  ctx: object,
  ingress: unknown,
  params: ChannelInboundMemorySubjectFacts,
): void {
  const record = getTrustedIngressRecord(ingress);
  if (!record || !record.ownsChannel(params.channel)) {
    return;
  }
  registeredFacts.set(
    ctx,
    Object.freeze({
      facts: createFacts(params),
      ingress,
    }),
  );
}

/** Marks an exact facade-built context only when its paired ingress runs the matching channel. */
export function attestCoreChannelInboundMemorySubjectContext(params: {
  ctx: object;
  ingress: unknown;
  runChannel: unknown;
}): void {
  const record = getTrustedIngressRecord(params.ingress);
  const registered = registeredFacts.get(params.ctx);
  if (
    !record ||
    !registered ||
    registered.ingress !== params.ingress ||
    !record.ownsChannel(params.runChannel) ||
    !hasLiveIngressChannel(params.ingress, params.runChannel) ||
    normalizeChannel(registered.facts.channel) !== normalizeChannel(params.runChannel)
  ) {
    // A public runner may see a previously facade-built object. Do not leave an
    // old attestation available for its later bind step.
    attestedMarkers.delete(params.ctx);
    boundIssuers.delete(params.ctx);
    registeredFacts.delete(params.ctx);
    return;
  }
  attestedMarkers.set(
    params.ctx,
    Object.freeze({ facts: registered.facts, ingress: params.ingress as object }),
  );
}

/**
 * Only core assembly may transfer an already-attested marker to its finalized context clone.
 * The builder registry and any session-bound issuer remain identity-bound to their original ctx.
 */
export function transferChannelInboundMemorySubjectMarker(source: object, target: object): void {
  const marker = attestedMarkers.get(source);
  if (marker) {
    attestedMarkers.set(target, marker);
    // A routed clone is the sole final context. Retaining the source marker
    // would let a later public runner bind the same facade-built object.
    attestedMarkers.delete(source);
    registeredFacts.delete(source);
  }
}

async function createIssuer(params: {
  facts: ChannelInboundMemorySubjectFacts;
  finalChannel: string;
  ingress: object;
}): Promise<TrustedSessionMemorySubjectIssuer> {
  const {
    createTrustedSessionMemorySubjectIssuer,
    prepareAmbiguousSessionMemorySubjectSeed,
    prepareChannelBindingSessionMemorySubjectSeed,
    prepareConversationSessionMemorySubjectSeed,
  } = await import("../../config/sessions/session-memory-subject.js");

  let issued = false;
  return createTrustedSessionMemorySubjectIssuer(() => {
    // This runs only inside the writer transaction. Rechecking here closes the
    // gap between facade attestation and a detached metadata write after unload.
    if (issued || !hasLiveIngressChannel(params.ingress, params.finalChannel)) {
      issued = true;
      return prepareAmbiguousSessionMemorySubjectSeed("unbound");
    }
    issued = true;
    const { facts } = params;
    if (facts.conversationKind === "direct") {
      if (facts.dmScope === "main") {
        return prepareAmbiguousSessionMemorySubjectSeed("shared-main");
      }
      if (
        !isNonEmptyText(facts.channel) ||
        !isNonEmptyText(facts.accountId) ||
        !isNonEmptyText(facts.senderId)
      ) {
        return prepareAmbiguousSessionMemorySubjectSeed("unbound");
      }
      return prepareChannelBindingSessionMemorySubjectSeed({
        channel: facts.channel,
        accountId: facts.accountId,
        stableSenderId: facts.senderId,
      });
    }

    if (facts.conversationKind === "group" || facts.conversationKind === "channel") {
      const conversationId = facts.nativeChannelId ?? facts.conversationId;
      if (
        !isNonEmptyText(facts.channel) ||
        !isNonEmptyText(facts.accountId) ||
        !isNonEmptyText(conversationId)
      ) {
        return prepareAmbiguousSessionMemorySubjectSeed("unbound");
      }
      return prepareConversationSessionMemorySubjectSeed({
        channel: facts.channel,
        accountId: facts.accountId,
        conversationId,
      });
    }

    return prepareAmbiguousSessionMemorySubjectSeed("unbound");
  });
}

function resolveFinalizedTargetFacts(params: {
  ctx: FinalizedMsgContext;
  facts: ChannelInboundMemorySubjectFacts;
  sessionKey: string;
}):
  | { facts: ChannelInboundMemorySubjectFacts; finalChannel: string; sessionKey: string }
  | undefined {
  const { ctx, facts, sessionKey } = params;
  const factsChannel = normalizeChannel(facts.channel);
  const finalChannel = normalizeChannel(ctx.OriginatingChannel);
  const factsAccountId = normalizeAccountId(facts.accountId);
  const finalAccountId = normalizeAccountId(ctx.AccountId);
  const factsAgentId = normalizeAgentId(facts.agentId);
  const finalAgentId = normalizeAgentId(ctx.AgentId);
  const factsSessionKey = normalizeBoundSessionKey(facts.sessionKey);
  const contextSessionKey = normalizeBoundSessionKey(ctx.SessionKey);
  const finalSessionKey = normalizeBoundSessionKey(sessionKey);
  const factsDmScope = normalizeDmScope(facts.dmScope);
  const finalDmScope = normalizeDmScope(ctx.DmScope);
  if (
    !factsChannel ||
    !finalChannel ||
    factsChannel !== finalChannel ||
    factsAccountId !== finalAccountId ||
    !factsAgentId ||
    !finalAgentId ||
    factsAgentId !== finalAgentId ||
    !factsSessionKey ||
    !contextSessionKey ||
    !finalSessionKey ||
    factsSessionKey !== contextSessionKey ||
    factsSessionKey !== finalSessionKey ||
    (facts.accountId !== undefined && !factsAccountId) ||
    (ctx.AccountId !== undefined && !finalAccountId) ||
    (facts.dmScope !== undefined && !factsDmScope) ||
    (ctx.DmScope !== undefined && !finalDmScope)
  ) {
    return undefined;
  }
  const sharedMain = factsDmScope === "main" || finalDmScope === "main";
  if (!sharedMain && factsDmScope !== finalDmScope) {
    return undefined;
  }
  return {
    facts: createFacts({
      ...facts,
      agentId: factsAgentId,
      accountId: factsAccountId,
      channel: factsChannel,
      dmScope: sharedMain ? "main" : factsDmScope,
      sessionKey: factsSessionKey,
    }),
    finalChannel,
    sessionKey: finalSessionKey,
  };
}

/** Binds an attested marker to the exact final metadata key selected by the core turn. */
export async function bindAttestedChannelInboundMemorySubject(
  ctx: FinalizedMsgContext,
  sessionKey: string,
): Promise<void> {
  const marker = attestedMarkers.get(ctx);
  if (!marker || boundIssuers.has(ctx)) {
    return;
  }
  // Consume the ephemeral marker before the dynamic import below. A public
  // runner cannot turn a facade-built context into authority while it awaits.
  attestedMarkers.delete(ctx);
  registeredFacts.delete(ctx);
  const target = resolveFinalizedTargetFacts({ ctx, facts: marker.facts, sessionKey });
  if (!target || !hasLiveIngressChannel(marker.ingress, target.finalChannel)) {
    return;
  }
  const issuer = await createIssuer({
    facts: target.facts,
    finalChannel: target.finalChannel,
    ingress: marker.ingress,
  });
  if (!hasLiveIngressChannel(marker.ingress, target.finalChannel)) {
    return;
  }
  boundIssuers.set(
    ctx,
    Object.freeze({
      finalChannel: target.finalChannel,
      ingress: marker.ingress,
      issuer,
      sessionKey: target.sessionKey,
    }),
  );
}

/** Returns an issuer only for the exact context identity and canonical record key. */
export function getBoundChannelInboundMemorySubjectIssuer(
  ctx: FinalizedMsgContext,
  sessionKey: string,
): TrustedSessionMemorySubjectIssuer | undefined {
  const bound = boundIssuers.get(ctx);
  const normalizedSessionKey = normalizeBoundSessionKey(sessionKey);
  if (
    !bound ||
    !normalizedSessionKey ||
    bound.sessionKey !== normalizedSessionKey ||
    !hasLiveIngressChannel(bound.ingress, bound.finalChannel)
  ) {
    if (bound) {
      boundIssuers.delete(ctx);
    }
    return undefined;
  }
  return bound.issuer;
}

/** Clears the exact-turn capability after dispatch, including no-record terminal paths. */
export function clearBoundChannelInboundMemorySubject(ctx: object): void {
  boundIssuers.delete(ctx);
  attestedMarkers.delete(ctx);
  registeredFacts.delete(ctx);
}
