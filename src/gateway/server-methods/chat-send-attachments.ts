import path from "node:path";
import { performance } from "node:perf_hooks";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { ensureSandboxWorkspaceForSession } from "../../agents/sandbox/context.js";
import {
  stageSandboxMedia,
  type StageSandboxMediaResult,
} from "../../auto-reply/reply/stage-sandbox-media.js";
import type { MsgContext, TemplateContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { DEFAULT_MAX_BYTES } from "../../media-understanding/defaults.constants.js";
import type { MediaFact } from "../../media/media-facts.js";
import { parseInboundMediaUri } from "../../media/media-reference.js";
import { deleteMediaBuffer, MEDIA_MAX_BYTES } from "../../media/store.js";
import { resolveChatAttachmentPolicy } from "../chat-attachment-policy.js";
import {
  MediaOffloadError,
  type OffloadedRef,
  logAttachmentFailure,
  parseMessageWithAttachments,
  stripImageMediaMarkers,
  UnsupportedAttachmentError,
} from "../chat-attachments.js";
import { resolveGatewayModelInputCapabilities } from "../session-utils.js";
import {
  explicitOriginTargetsAcpSession,
  explicitOriginTargetsPluginBinding,
} from "./chat-origin-routing.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { roundedChatSendTimingMs } from "./chat-server-timing.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function isPdfOffloadedRef(ref: OffloadedRef): boolean {
  const mime = ref.mimeType.trim().toLowerCase();
  if (mime === "application/pdf" || mime.endsWith("+pdf")) {
    return true;
  }
  return path.extname(ref.path.split(/[?#]/u)[0] ?? "").toLowerCase() === ".pdf";
}

// Managed inbound PDFs can be read host-side from the media-store root, even
// for locked-down agents, so sandbox staging may safely fall back to that path.
function isManagedInboundPdfOffloadRef(ref: OffloadedRef): boolean {
  if (!isPdfOffloadedRef(ref)) {
    return false;
  }
  try {
    return parseInboundMediaUri(ref.mediaRef) !== null;
  } catch {
    return false;
  }
}

function shouldPassThroughManagedInboundPdfOffloadRef(ref: OffloadedRef): boolean {
  // Oversized managed PDFs remain host-readable. A sandbox copy only hits the
  // 5 MB staging cap without making the attachment more available.
  return ref.sizeBytes > MEDIA_MAX_BYTES && isManagedInboundPdfOffloadRef(ref);
}

function canHydrateChatSendVideo(
  ref: Pick<OffloadedRef, "mimeType" | "sizeBytes">,
  supportsNativeVideo: boolean,
): boolean {
  return (
    supportsNativeVideo &&
    ref.mimeType.startsWith("video/") &&
    ref.sizeBytes <= DEFAULT_MAX_BYTES.video
  );
}

// Stage media before ACK so permanent client errors stay 4xx and retryable
// staging failures stay 5xx. Managed PDFs retain their host-readable fallback.
async function prestageMediaPathOffloads(params: {
  offloadedRefs: OffloadedRef[];
  parsedMedia: readonly MediaFact[];
  includeImageRefs?: boolean;
  supportsNativeVideo: boolean;
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
}): Promise<{ media: MediaFact[]; paths: string[]; types: string[]; workspaceDir?: string }> {
  const mediaPathRefs = params.offloadedRefs.filter((ref) => {
    // Native model inputs hydrate directly from their managed claim checks;
    // staging video would apply the unrelated 5 MB sandbox tool-file ceiling.
    if (canHydrateChatSendVideo(ref, params.supportsNativeVideo)) {
      return false;
    }
    return params.includeImageRefs || !ref.mimeType.startsWith("image/");
  });
  if (mediaPathRefs.length === 0) {
    return { media: [], paths: [], types: [] };
  }
  const selectedSourceIds = new Set(mediaPathRefs.map((ref) => ref.id));
  const parsedMedia = params.parsedMedia.filter(
    (fact) => fact.sourceId !== undefined && selectedSourceIds.has(fact.sourceId),
  );
  const projectRefs = (stagedPaths: ReadonlyMap<string, string> = new Map()) => ({
    media: parsedMedia.map((fact) => {
      const stagedPath = fact.sourceId ? stagedPaths.get(fact.sourceId) : undefined;
      return stagedPath && stagedPath !== fact.path ? { ...fact, path: stagedPath } : fact;
    }),
    paths: mediaPathRefs.map((ref) => stagedPaths.get(ref.id) ?? ref.path),
    types: mediaPathRefs.map((ref) => ref.mimeType),
  });
  const refsToStage = mediaPathRefs.filter(
    (ref) => !shouldPassThroughManagedInboundPdfOffloadRef(ref),
  );
  if (refsToStage.length === 0) {
    return projectRefs();
  }

  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
    const sandbox = await ensureSandboxWorkspaceForSession({
      config: params.cfg,
      sessionKey: params.sessionKey,
      workspaceDir,
    });
    if (!sandbox) {
      return projectRefs();
    }

    // The parser admits more than the sandbox can stage. Reject non-PDF files
    // in that gap as permanent 4xx instead of a retryable staging failure.
    const oversizedForSandbox = refsToStage.filter((ref) => ref.sizeBytes > MEDIA_MAX_BYTES);
    if (oversizedForSandbox.length > 0) {
      const details = oversizedForSandbox
        .map((ref) => `${ref.label} (${ref.sizeBytes} bytes)`)
        .join(", ");
      throw new UnsupportedAttachmentError(
        "non-image-too-large-for-sandbox",
        `attachments exceed sandbox staging limit (${MEDIA_MAX_BYTES} bytes): ${details}`,
      );
    }

    const stagingCtx: MsgContext = {
      media: refsToStage.map((ref) => ({ path: ref.path, contentType: ref.mimeType })),
    };
    let stageResult: StageSandboxMediaResult;
    try {
      stageResult = await stageSandboxMedia({
        ctx: stagingCtx,
        sessionCtx: stagingCtx as TemplateContext,
        cfg: params.cfg,
        sessionKey: params.sessionKey,
        workspaceDir,
      });
    } catch (stageErr) {
      // Only managed inbound PDFs have a host-readable fallback. Other files
      // must fail before ACK or the agent silently loses the attachment.
      if (refsToStage.some((ref) => !isManagedInboundPdfOffloadRef(ref))) {
        throw stageErr;
      }
      return projectRefs();
    }

    // stageSandboxMedia preserves an absolute source path when no copy lands;
    // the staged map is the authoritative success signal.
    const stagedSources = stageResult.staged;
    const missing = refsToStage.filter((_ref, index) => !stagedSources.has(index));
    const unstageable = missing.filter((ref) => !isManagedInboundPdfOffloadRef(ref));
    if (unstageable.length > 0) {
      throw new Error(
        `attachment staging incomplete: ${stagedSources.size}/${refsToStage.length} paths staged into sandbox workspace (missing: ${unstageable.map((ref) => ref.path).join(", ")})`,
      );
    }
    const stagedMedia = stagingCtx.media ?? [];
    // Preserve request order while mixing sandbox-relative paths with managed
    // host paths used by pass-through or fallback PDFs.
    const stagedPaths = new Map<string, string>();
    refsToStage.forEach((ref, index) => {
      if (stagedSources.has(index) && stagedMedia[index]?.path) {
        stagedPaths.set(ref.id, stagedMedia[index].path);
      }
    });
    return {
      ...projectRefs(stagedPaths),
      workspaceDir: sandbox.workspaceDir,
    };
  } catch (err) {
    await Promise.allSettled(
      params.offloadedRefs.map((ref) => deleteMediaBuffer(ref.id, "inbound")),
    );
    if (err instanceof MediaOffloadError || err instanceof UnsupportedAttachmentError) {
      throw err;
    }
    throw new MediaOffloadError(
      `[Gateway Error] Failed to stage attachments into agent workspace: ${formatErrorMessage(err)}`,
      { cause: err },
    );
  }
}

/** Parse and pre-stage attachments before the caller's synchronous pre-ACK checks. */
export async function prepareChatSendAttachments(params: {
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  admission: AdmittedChatSend;
  respond: GatewayRequestHandlerOptions["respond"];
  context: GatewayRequestHandlerOptions["context"];
}) {
  const { request, session, admission, respond, context } = params;
  const { inboundMessage, normalizedAttachments, explicitOrigin } = request;
  const { cfg, sessionKey, agentId, resolvedSessionModel, clientRunId } = session;
  const {
    activeRunAbort,
    chatSendTraceAttributes,
    cleanupAdmittedRun,
    finishAbortedChatSend,
    lifecycleGeneration,
  } = admission;
  let parsedMessage = inboundMessage;
  let parsedImages: Awaited<ReturnType<typeof parseMessageWithAttachments>>["images"] = [];
  let imageOrder: Awaited<ReturnType<typeof parseMessageWithAttachments>>["imageOrder"] = [];
  let parsedMedia: MediaFact[] = [];
  let offloadedRefs: OffloadedRef[] = [];
  let mediaPathOffloadPaths: string[] = [];
  let mediaPathOffloadTypes: string[] = [];
  let mediaPathOffloads: MediaFact[] = [];
  let mediaPathOffloadWorkspaceDir: string | undefined;
  let supportsNativeVideo = false;
  const explicitOriginTargetsPlugin = explicitOriginTargetsPluginBinding(explicitOrigin);
  let prepareAttachmentsMs: number | undefined;

  if (normalizedAttachments.length > 0) {
    const prepareAttachmentsStartedAtMs = performance.now();
    try {
      await measureDiagnosticsTimelineSpan(
        "gateway.chat_send.prepare_attachments",
        async () => {
          const modelInputCapabilities = await resolveGatewayModelInputCapabilities({
            loadGatewayModelCatalog: context.loadGatewayModelCatalog,
            loadGatewayModelCatalogSnapshot: context.loadGatewayModelCatalogSnapshot,
            agentId,
            provider: resolvedSessionModel.provider,
            model: resolvedSessionModel.model,
          });
          const supportsImages =
            modelInputCapabilities.supportsImages ||
            explicitOriginTargetsAcpSession(explicitOrigin) ||
            explicitOriginTargetsPlugin;
          supportsNativeVideo = modelInputCapabilities.supportsVideo;
          const parsed = await parseMessageWithAttachments(inboundMessage, normalizedAttachments, {
            limits: resolveChatAttachmentPolicy(cfg),
            log: context.logGateway,
            supportsImages,
            acceptNonImage: true,
          });
          parsedMessage = supportsImages
            ? parsed.message
            : stripImageMediaMarkers(parsed.message, parsed.offloadedRefs);
          parsedImages = parsed.images;
          imageOrder = parsed.imageOrder;
          parsedMedia = parsed.media;
          offloadedRefs = parsed.offloadedRefs;
          ({
            media: mediaPathOffloads,
            paths: mediaPathOffloadPaths,
            types: mediaPathOffloadTypes,
            workspaceDir: mediaPathOffloadWorkspaceDir,
          } = await prestageMediaPathOffloads({
            offloadedRefs,
            parsedMedia,
            includeImageRefs: !supportsImages,
            supportsNativeVideo,
            cfg,
            sessionKey,
            agentId,
          }));
        },
        {
          phase: "agent-turn",
          config: cfg,
          attributes: {
            ...chatSendTraceAttributes,
            attachmentCount: normalizedAttachments.length,
          },
        },
      );
      prepareAttachmentsMs = roundedChatSendTimingMs(
        performance.now() - prepareAttachmentsStartedAtMs,
      );
    } catch (err) {
      if (
        activeRunAbort.controller.signal.aborted &&
        context.chatRunState.hasAbortMarker(clientRunId)
      ) {
        finishAbortedChatSend();
        return { ok: false as const };
      }
      cleanupAdmittedRun({ force: true });
      clearAgentRunContext(clientRunId, lifecycleGeneration);
      logAttachmentFailure(context.logGateway, "chat.send attachment parse/stage failed", err);
      respond(
        false,
        undefined,
        errorShape(
          err instanceof MediaOffloadError ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
          String(err),
        ),
      );
      return { ok: false as const };
    }
  }
  return {
    ok: true as const,
    value: {
      explicitOriginTargetsPlugin,
      imageOrder,
      mediaPathOffloadPaths,
      mediaPathOffloadTypes,
      mediaPathOffloads,
      mediaPathOffloadWorkspaceDir,
      offloadedRefs,
      parsedImages,
      parsedMedia,
      parsedMessage,
      prepareAttachmentsMs,
      supportsNativeVideo,
    },
  };
}
