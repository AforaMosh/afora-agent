// Whatsapp plugin module owns stable direct-peer compatibility identity.
import { createHash } from "node:crypto";
import { readChannelAllowFromStore } from "openclaw/plugin-sdk/channel-pairing";
import { normalizeWhatsAppLidJid } from "./identity.js";
import { getWhatsAppRuntime } from "./runtime.js";
import type { WhatsAppJidMappingOutcome } from "./targets-runtime.js";

const DIRECT_PEER_OWNER_NAMESPACE = "direct-peer-owner-v1";
const DIRECT_PEER_OWNER_MAX_ENTRIES = 50_000;

type StoredDirectPeerOwner = {
  accountId: string;
  lid: string;
  owner: "lid";
};

type WhatsAppDirectPeerResolution =
  | {
      kind: "resolved";
      peerId: string;
      lid: string;
      e164: string | null;
      mapping: WhatsAppJidMappingOutcome;
    }
  | {
      kind: "error";
      error: WhatsAppDirectPeerResolutionError;
    };

export class WhatsAppDirectPeerResolutionError extends Error {
  readonly code: "mapping-error" | "owner-state-error";
  readonly mapping?: Extract<WhatsAppJidMappingOutcome, { kind: "error" }>;

  constructor(
    message: string,
    options: {
      code: WhatsAppDirectPeerResolutionError["code"];
      cause?: unknown;
      mapping?: Extract<WhatsAppJidMappingOutcome, { kind: "error" }>;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "WhatsAppDirectPeerResolutionError";
    this.code = options.code;
    this.mapping = options.mapping;
  }
}

function ownerStore() {
  return getWhatsAppRuntime().state.openKeyedStore<StoredDirectPeerOwner>({
    namespace: DIRECT_PEER_OWNER_NAMESPACE,
    maxEntries: DIRECT_PEER_OWNER_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

function ownerKey(accountId: string, lid: string): string {
  return createHash("sha256").update(`${accountId}\n${lid}`).digest("hex");
}

function formatMappingError(mapping: Extract<WhatsAppJidMappingOutcome, { kind: "error" }>) {
  const relevantOutcome = mapping.reason === "mapping-conflict" ? "mapped" : "error";
  const sources = [
    ...new Set(
      mapping.evidence
        .filter((entry) => entry.outcome === relevantOutcome)
        .map((entry) => entry.source),
    ),
  ].toSorted();
  const sourceSummary = sources.length > 0 ? sources.join(", ") : "configured sources";
  if (mapping.reason === "mapping-conflict") {
    return `WhatsApp LID mapping conflict across ${sourceSummary} (${mapping.distinctValueCount} distinct values); reconcile mapping sources and retry.`;
  }
  return `WhatsApp LID mapping lookup failed across ${sourceSummary}; repair the failing source and retry.`;
}

function ownerStateError(cause: unknown): WhatsAppDirectPeerResolution {
  return {
    kind: "error",
    error: new WhatsAppDirectPeerResolutionError(
      "WhatsApp direct-peer owner state is unavailable; repair plugin state and retry.",
      { code: "owner-state-error", cause },
    ),
  };
}

async function recordLidOwner(params: {
  accountId: string;
  lid: string;
}): Promise<WhatsAppDirectPeerResolution | null> {
  const store = ownerStore();
  const key = ownerKey(params.accountId, params.lid);
  try {
    const created = await store.registerIfAbsent(key, {
      accountId: params.accountId,
      lid: params.lid,
      owner: "lid",
    });
    if (created) {
      return null;
    }
    const existing = await store.lookup(key);
    return existing?.owner === "lid" && existing.lid === params.lid
      ? null
      : ownerStateError(new Error("direct-peer owner record is invalid"));
  } catch (error) {
    return ownerStateError(error);
  }
}

export async function resolveWhatsAppDirectPeer(params: {
  accountId: string;
  jid: string;
  mapping: WhatsAppJidMappingOutcome;
}): Promise<WhatsAppDirectPeerResolution> {
  const lid = normalizeWhatsAppLidJid(params.jid);
  if (!lid) {
    return ownerStateError(new Error("direct peer is not a canonical LID"));
  }
  if (params.mapping.kind === "error") {
    return {
      kind: "error",
      error: new WhatsAppDirectPeerResolutionError(formatMappingError(params.mapping), {
        code: "mapping-error",
        mapping: params.mapping,
      }),
    };
  }

  const store = ownerStore();
  let stored: StoredDirectPeerOwner | undefined;
  try {
    stored = await store.lookup(ownerKey(params.accountId, lid));
  } catch (error) {
    return ownerStateError(error);
  }
  if (stored) {
    if (stored.owner !== "lid" || stored.lid !== lid || stored.accountId !== params.accountId) {
      return ownerStateError(new Error("direct-peer owner record is invalid"));
    }
    return {
      kind: "resolved",
      peerId: lid,
      lid,
      e164: params.mapping.kind === "mapped" ? params.mapping.e164 : null,
      mapping: params.mapping,
    };
  }

  let pairedEntries: string[];
  try {
    pairedEntries = await readChannelAllowFromStore("whatsapp", process.env, params.accountId);
  } catch (error) {
    return ownerStateError(error);
  }

  const exactLidPairing = pairedEntries.some((entry) => normalizeWhatsAppLidJid(entry) === lid);
  if (params.mapping.kind === "mapped" && !exactLidPairing) {
    return {
      kind: "resolved",
      peerId: params.mapping.e164,
      lid,
      e164: params.mapping.e164,
      mapping: params.mapping,
    };
  }

  const writeError = await recordLidOwner({ accountId: params.accountId, lid });
  if (writeError) {
    return writeError;
  }
  return {
    kind: "resolved",
    peerId: lid,
    lid,
    e164: params.mapping.kind === "mapped" ? params.mapping.e164 : null,
    mapping: params.mapping,
  };
}

export async function clearWhatsAppDirectPeerOwners(accountId: string): Promise<void> {
  const store = ownerStore();
  const entries = await store.entries();
  await Promise.all(
    entries
      .filter((entry) => entry.value.accountId === accountId)
      .map(async (entry) => await store.delete(entry.key)),
  );
}
