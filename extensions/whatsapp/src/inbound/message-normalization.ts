// Whatsapp plugin module normalizes inbound identity and access facts.
import type { AnyMessageContent, WAMessage } from "baileys";
import {
  claimWhatsAppDirectPeer,
  prepareWhatsAppDirectPeer,
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
    const directPeerPreparation = directLid
      ? await prepareWhatsAppDirectPeer({
          accountId: options.accountId,
          jid: directLid,
          mapping: await socketSession.resolveInboundJidMapping(remoteJid),
        })
      : null;
    if (directPeerPreparation?.kind === "error") {
      return { kind: "retryable-error", error: directPeerPreparation.error };
    }
    let directPeer = directPeerPreparation?.peer ?? null;
    let from = group
      ? remoteJid
      : directPeer
        ? directPeer.peerId
        : await socketSession.resolveInboundJid(remoteJid);
    if (!from) {
      return null;
    }
    let senderE164 = group
      ? participantJid
        ? await socketSession.resolveInboundJid(participantJid)
        : null
      : directPeer
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
    const checkAccess = async () =>
      await checkInboundAccessControl({
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
    let access = await checkAccess();
    if (!access.allowed) {
      return null;
    }

    if (directPeerPreparation?.kind === "prepared") {
      const claimed = await claimWhatsAppDirectPeer(directPeerPreparation);
      if (claimed.kind === "error") {
        return { kind: "retryable-error", error: claimed.error };
      }
      if (claimed.peerId !== directPeer?.peerId || claimed.e164 !== directPeer?.e164) {
        // A concurrent admitted message may win the stable identity claim. Recheck
        // policy with that authoritative owner before routing this message.
        directPeer = claimed;
        from = claimed.peerId;
        senderE164 = claimed.e164;
        access = await checkAccess();
        if (!access.allowed) {
          return null;
        }
      }
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
