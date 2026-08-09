import path from "node:path";
import type { GatewayClientInfo } from "../../../packages/gateway-protocol/src/client-info.js";
import type { RuntimeMsgContext as MsgContext } from "../../auto-reply/templating.js";
import type { MediaFact } from "../../media/media-facts.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { UserTurnInput } from "../../sessions/user-turn-transcript.js";
import { INTERNAL_MESSAGE_CHANNEL, isOperatorUiClient } from "../../utils/message-channel.js";
import {
  type ChatImageContent,
  type OffloadedRef,
  type PersistedInboundMedia,
  persistInboundImagesForTranscript,
} from "../chat-attachments.js";
import { isAcpBridgeClient } from "./chat-origin-routing.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { prepareChatSendAttachments } from "./chat-send-attachments.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { normalizeOptionalChatText } from "./chat-text-normalization.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

type PreparedChatSendAttachments = Extract<
  Awaited<ReturnType<typeof prepareChatSendAttachments>>,
  { ok: true }
>["value"];

type ChatSendUserTurnInputController = {
  baseInput: UserTurnInput;
  setInputPromise: (input: Promise<UserTurnInput>) => void;
};

async function persistChatSendImages(params: {
  images: ChatImageContent[];
  offloadedRefs: OffloadedRef[];
  client: GatewayRequestHandlerOptions["client"];
  logGateway: GatewayRequestContext["logGateway"];
}): Promise<PersistedInboundMedia[]> {
  if (
    (params.images.length === 0 && params.offloadedRefs.length === 0) ||
    isAcpBridgeClient(params.client)
  ) {
    return [];
  }
  return await persistInboundImagesForTranscript({
    images: params.images,
    offloadedRefs: params.offloadedRefs,
    log: params.logGateway,
    logContext: "chat.send",
  });
}

export function applyChatSendManagedMedia(ctx: MsgContext, media: MediaFact[]): void {
  if ((!ctx.media || ctx.media.length === 0) && media.length > 0) {
    ctx.media = media;
  }
}

function buildChatSendUserTurnMedia(
  savedMedia: PersistedInboundMedia[],
  parsedMedia: readonly MediaFact[],
): MediaFact[] {
  const savedBySourceIndex = new Map(
    savedMedia.map((entry) => [entry.sourceIndex, entry] as const),
  );
  return parsedMedia.flatMap((fact) => {
    const sourceIndex = fact.sourceIndex;
    const saved = sourceIndex === undefined ? undefined : savedBySourceIndex.get(sourceIndex);
    if (fact.path || fact.url) {
      return [fact];
    }
    return saved
      ? [
          {
            ...fact,
            sourceId: saved.id,
            path: saved.path,
            contentType: fact.contentType ?? saved.contentType,
          },
        ]
      : [];
  });
}

function buildChatSendPromptMedia(
  attachments: PreparedChatSendAttachments,
): MediaFact[] | undefined {
  const media = attachments.parsedMedia.filter(
    (fact) =>
      Boolean(fact.path ?? fact.url) &&
      (fact.kind === "image" || fact.kind === "sticker" || fact.kind === "video"),
  );
  return media.length > 0 ? media : undefined;
}

function buildChatSendMessageContext(params: {
  agentId: string;
  client: GatewayRequestHandlerOptions["client"];
  clientInfo?: GatewayClientInfo;
  clientRunId: string;
  mediaPathOffloads: MediaFact[];
  mediaPathOffloadWorkspaceDir?: string;
  originatingRoute: AdmittedChatSend["originatingRoute"];
  parsedMessage: string;
  sessionKey: string;
  suppressCommandInterpretation: boolean;
  systemInputProvenance?: InputProvenance;
  systemProvenanceReceipt?: string;
  toolBindings?: Readonly<Record<string, unknown>>;
}) {
  const commandBody = params.parsedMessage;
  const commandSource =
    !params.suppressCommandInterpretation && params.parsedMessage.trim().startsWith("/")
      ? "text"
      : undefined;
  const messageForAgent = params.systemProvenanceReceipt
    ? [params.systemProvenanceReceipt, params.parsedMessage].filter(Boolean).join("\n\n")
    : params.parsedMessage;
  const queuedFollowupOwnerDeviceId = normalizeOptionalChatText(params.client?.connect?.device?.id);
  const queuedFollowupOwnerConnId = normalizeOptionalChatText(params.client?.connId);
  const queuedFollowupOwnerKey = queuedFollowupOwnerDeviceId
    ? `device:${queuedFollowupOwnerDeviceId}`
    : queuedFollowupOwnerConnId
      ? `connection:${queuedFollowupOwnerConnId}`
      : undefined;
  const { originatingChannel, originatingTo, accountId, messageThreadId, explicitDeliverRoute } =
    params.originatingRoute;
  // Current and historical turns must reach the single LLM timestamp boundary
  // with identical bare text. Stamping this live turn would bust the prompt cache.
  const ctx: MsgContext = {
    Body: messageForAgent,
    BodyForAgent: messageForAgent,
    BodyForCommands: commandBody,
    RawBody: params.parsedMessage,
    CommandBody: commandBody,
    InputProvenance: params.systemInputProvenance,
    SessionKey: params.sessionKey,
    AgentId: params.agentId,
    Provider: INTERNAL_MESSAGE_CHANNEL,
    Surface: INTERNAL_MESSAGE_CHANNEL,
    OriginatingChannel: originatingChannel,
    OriginatingTo: originatingTo,
    ExplicitDeliverRoute: explicitDeliverRoute,
    AccountId: accountId,
    MessageThreadId: messageThreadId,
    ChatType: "direct",
    ...(commandSource ? { CommandSource: commandSource } : {}),
    CommandAuthorized: !params.suppressCommandInterpretation,
    CommandTurn: commandSource
      ? {
          kind: "text-slash",
          source: commandSource,
          authorized: true,
          body: commandBody,
        }
      : {
          kind: "normal",
          source: "message",
          authorized: false,
          body: commandBody,
        },
    ...(params.suppressCommandInterpretation ? { CommandInterpretationSuppressed: true } : {}),
    MessageSid: params.clientRunId,
    SessionCreation: resolveOperatorSessionCreation(params.client),
    ApprovalReviewerDeviceId: queuedFollowupOwnerDeviceId,
    ...(!isOperatorUiClient(params.clientInfo)
      ? {
          SenderId: params.clientInfo?.id,
          SenderName: params.clientInfo?.displayName,
          SenderUsername: params.clientInfo?.displayName,
        }
      : {}),
    GatewayClientScopes: params.client?.connect?.scopes ?? [],
    GatewayClientCaps: params.client?.connect?.caps ?? [],
    GatewayRunToolBindings: params.toolBindings,
  };
  if (params.mediaPathOffloads.length > 0) {
    // Pre-staged offloads must use structured facts and marker text so the
    // dispatch path renders their prompt note without staging them a second time.
    ctx.media = params.mediaPathOffloads.map((fact) => ({
      ...fact,
      workspaceDir: params.mediaPathOffloadWorkspaceDir ?? path.dirname(fact.path ?? ""),
    }));
  }
  return {
    accountId,
    ctx,
    isInternalTextSlashCommandTurn: commandSource === "text",
    queuedFollowupOwnerKey,
  };
}

/** Assemble transcript media and the portable inbound context after chat.send ACK. */
export function prepareChatSendUserTurn(params: {
  request: Pick<
    NormalizedChatSendRequest,
    | "clientInfo"
    | "normalizedAttachments"
    | "suppressCommandInterpretation"
    | "systemInputProvenance"
    | "systemProvenanceReceipt"
    | "toolBindings"
  >;
  session: Pick<PreparedChatSendSession, "agentId" | "clientRunId" | "sessionKey">;
  admission: Pick<AdmittedChatSend, "originatingRoute">;
  attachments: PreparedChatSendAttachments;
  client: GatewayRequestHandlerOptions["client"];
  logGateway: GatewayRequestContext["logGateway"];
  userTurn: ChatSendUserTurnInputController;
}) {
  const { request, session, admission, attachments, client, logGateway, userTurn } = params;
  const persistedMediaForTranscriptPromise = persistChatSendImages({
    images: attachments.parsedImages,
    offloadedRefs: attachments.offloadedRefs,
    client,
    logGateway,
  });
  const preparedUserTurnMediaPromise: Promise<MediaFact[]> =
    request.normalizedAttachments.length > 0
      ? persistedMediaForTranscriptPromise.then((media) =>
          buildChatSendUserTurnMedia(media, attachments.parsedMedia),
        )
      : Promise.resolve([]);
  userTurn.setInputPromise(
    preparedUserTurnMediaPromise.then((media) => {
      const imageFactIndexes = media.flatMap((fact, index) =>
        fact.contentType?.startsWith("image/") ? [index] : [],
      );
      return {
        ...userTurn.baseInput,
        ...(media.length > 0 ? { media } : {}),
        ...(media.length > 0 && attachments.imageOrder.length > 0
          ? {
              mediaImageLayout: {
                // Native video may precede images, so image slots follow actual
                // persisted fact positions rather than their image-only ordinal.
                slots: attachments.imageOrder.map((kind, imageIndex) => ({
                  kind,
                  factIndex: imageFactIndexes[imageIndex] ?? imageIndex,
                })),
              },
            }
          : {}),
      };
    }),
  );
  const pluginBoundMediaPromise =
    attachments.explicitOriginTargetsPlugin && attachments.parsedMedia.length > 0
      ? preparedUserTurnMediaPromise
      : Promise.resolve([]);
  void pluginBoundMediaPromise.catch(() => undefined);
  const messageContext = buildChatSendMessageContext({
    agentId: session.agentId,
    client,
    clientInfo: request.clientInfo,
    clientRunId: session.clientRunId,
    mediaPathOffloads: attachments.mediaPathOffloads,
    mediaPathOffloadWorkspaceDir: attachments.mediaPathOffloadWorkspaceDir,
    originatingRoute: admission.originatingRoute,
    parsedMessage: attachments.parsedMessage,
    sessionKey: session.sessionKey,
    suppressCommandInterpretation: request.suppressCommandInterpretation,
    systemInputProvenance: request.systemInputProvenance,
    systemProvenanceReceipt: request.systemProvenanceReceipt,
    toolBindings: request.toolBindings,
  });
  const mediaPathOffloadsIncludeImages = attachments.mediaPathOffloadTypes.some((type) =>
    type.startsWith("image/"),
  );
  return {
    ...messageContext,
    pluginBoundMediaPromise,
    replyOptionImages: mediaPathOffloadsIncludeImages
      ? undefined
      : attachments.parsedImages.length > 0
        ? attachments.parsedImages
        : undefined,
    replyOptionMedia: buildChatSendPromptMedia(attachments),
  };
}
