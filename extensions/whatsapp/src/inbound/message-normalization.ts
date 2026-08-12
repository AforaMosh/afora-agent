// Whatsapp plugin module normalizes inbound identity and access facts.
import type { AnyMessageContent, WAMessage } from "baileys";
import {
  resolveWhatsAppDirectPeer,
  type WhatsAppDirectPeerResolutionError,
} from "../direct-peer-owner.js";
import { normalizeExactWhatsAppLidJid } from "../identity.js";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  checkInboundAccessControl,
  type AcceptedInboundAccessControlResult,
} from "./access-control.js";
import { isRecentOutboundMessage } from "./dedupe.js";
import { hasInboundUserContent } from "./extract.js";
import type { WhatsAppGroupMetadataCacheOwner } from "./group-metadata-cache.js";
import { isJidGroup } from "./runtime-api.js";
import type { WhatsAppAttachedSocketSession } from "./socket-session.js";

export type WhatsAppNormalizedInboundMessage = {
  id?: string;
  remoteJid: string;
  group: boolean;
  participantJid?: string;
  senderJid?: string;
  from: string;
  senderE164: string | null;
  groupSubject?: string;
  groupParticipants?: string[];
  messageTimestampMs?: number;
  access: AcceptedInboundAccessControlResult;
};

export type WhatsAppInboundNormalizationResult =
  | WhatsAppNormalizedInboundMessage
  | { kind: "retryable-error"; error: WhatsAppDirectPeerResolutionError }
  | null;

export function createWhatsAppInboundMessageNormalizer(options: {
  cfg: OpenClawConfig;
  loadConfig?: () => OpenClawConfig;
  accountId: string;
  verbose: boolean;
  socketSession: WhatsAppAttachedSocketSession;
  groupMetadata: WhatsAppGroupMetadataCacheOwner;
  parseTimestampSeconds: (value: unknown) => number | undefined;
  logVerbose: (message: string) => void;
}) {
  const { socketSession, groupMetadata } = options;
  const shouldSkipRecentOutboundEcho = (msg: WAMessage): boolean => {
    const id = msg.key?.id ?? undefined;
    const remoteJid = msg.key?.remoteJid;
    if (
      !msg.key?.fromMe ||
      !id ||
      !remoteJid ||
      !isRecentOutboundMessage({
        accountId: options.accountId,
        remoteJid,
        alternateRemoteJid: msg.key?.remoteJidAlt,
        messageId: id,
      })
    ) {
      return false;
    }
    options.logVerbose(`Skipping recent outbound WhatsApp echo ${id} for ${remoteJid}`);
    return true;
  };

  const normalize = async (msg: WAMessage): Promise<WhatsAppInboundNormalizationResult> => {
    const id = msg.key?.id ?? undefined;
    const remoteJid = msg.key?.remoteJid;
    if (!remoteJid || remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast")) {
      return null;
    }

    const group = isJidGroup(remoteJid) === true;
    // Gateway-originated echoes must never become new inbound work, including
    // self-chat replies that return on the same upsert stream.
    if (shouldSkipRecentOutboundEcho(msg)) {
      return null;
    }
    // Receipts, presence, and protocol messages share the upsert stream. Gate
    // access control on actual user content to avoid unsolicited pairing replies.
    if (!hasInboundUserContent(msg.message ?? undefined)) {
      return null;
    }

    const participantJid = msg.key?.participant ?? undefined;
    const directLid = group ? null : normalizeExactWhatsAppLidJid(remoteJid);
    const canonicalRemoteJid = directLid ?? remoteJid;
    const directPeer = directLid
      ? await resolveWhatsAppDirectPeer({
          accountId: options.accountId,
          jid: directLid,
          mapping: await socketSession.resolveInboundJidMapping(remoteJid),
        })
      : null;
    if (directPeer?.kind === "error") {
      return { kind: "retryable-error", error: directPeer.error };
    }
    const from = group
      ? remoteJid
      : directPeer?.kind === "resolved"
        ? directPeer.peerId
        : await socketSession.resolveInboundJid(remoteJid);
    if (!from) {
      return null;
    }
    const senderE164 = group
      ? participantJid
        ? await socketSession.resolveInboundJid(participantJid)
        : null
      : directPeer?.kind === "resolved"
        ? directPeer.e164
        : from;
    const senderJid = group ? participantJid : (directLid ?? remoteJid);

    let groupSubject: string | undefined;
    let groupParticipants: string[] | undefined;
    if (group) {
      const meta = await groupMetadata.get(remoteJid);
      groupSubject = meta.subject;
      groupParticipants = meta.participants;
    }
    const messageTimestampSeconds = options.parseTimestampSeconds(msg.messageTimestamp);
    const messageTimestampMs =
      messageTimestampSeconds !== undefined ? messageTimestampSeconds * 1000 : undefined;
    const access = await checkInboundAccessControl({
      cfg: options.loadConfig?.() ?? options.cfg,
      accountId: options.accountId,
      from,
      selfE164: socketSession.self.e164 ?? null,
      senderE164,
      senderJid,
      group,
      pushName: msg.pushName ?? undefined,
      isFromMe: Boolean(msg.key?.fromMe),
      messageTimestampMs,
      connectedAtMs: socketSession.connectedAtMs,
      verbose: options.verbose,
      sock: {
        sendMessage: (jid: string, content: AnyMessageContent) =>
          socketSession.sendTrackedMessage(jid, content),
      },
      remoteJid: canonicalRemoteJid,
    });
    if (!access.allowed) {
      return null;
    }

    return {
      id,
      remoteJid: canonicalRemoteJid,
      group,
      participantJid,
      senderJid,
      from,
      senderE164,
      groupSubject,
      groupParticipants,
      messageTimestampMs,
      access,
    };
  };

  return { normalize, shouldSkipRecentOutboundEcho } as const;
}
