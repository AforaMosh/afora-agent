// Resolves native visual attachments that belong to the current reply turn.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ImageContent, MediaContent } from "../../llm/types.js";
import {
  isImageAttachment,
  normalizeAttachments,
} from "../../media-understanding/attachments.normalize.js";
import {
  stripExtractedFileImageMetadata,
  type ExtractedFileImage,
} from "../../media-understanding/extracted-file-images.js";
import type { MediaAttachment } from "../../media-understanding/types.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import { readRuntimePromptImageFactIndexes } from "../../media/runtime-prompt-image-provenance.js";
import type { RuntimeMsgContext as MsgContext } from "../templating.js";
import { resolveAgentTurnAttachments } from "./agent-turn-attachments.js";

type CurrentImageAttachment = MediaAttachment & { path: string };

type OrderedTurnMedia = {
  media: MediaContent;
  sourceIndex?: number;
  sequence: number;
};

type OrderedImageSlot = {
  imageOrder: PromptImageOrderEntry;
  sourceIndex?: number;
  sequence: number;
};

function collectCurrentImageAttachments(ctx: MsgContext): CurrentImageAttachment[] {
  return normalizeAttachments(ctx).flatMap((attachment) => {
    const mediaPath = normalizeOptionalString(attachment.path);
    return mediaPath && isImageAttachment(attachment) ? [{ ...attachment, path: mediaPath }] : [];
  });
}

function collectDescribedImageAttachmentIndexes(ctx: MsgContext): Set<number> {
  return new Set(
    ctx.MediaUnderstanding?.filter((output) => output.kind === "image.description").map(
      (output) => output.attachmentIndex,
    ) ?? [],
  );
}

function createUndescribedImageContext(
  ctx: MsgContext,
  undescribedAttachments: CurrentImageAttachment[],
): MsgContext {
  const media = undescribedAttachments.map((attachment) => ({
    sourceId: attachment.sourceId,
    sourceIndex: attachment.sourceIndex,
    path: attachment.path,
    contentType: attachment.mime,
    kind: attachment.kind,
    workspaceDir: attachment.workspaceDir,
    sizeBytes: attachment.sizeBytes,
  }));
  return {
    ...ctx,
    media,
  };
}

function appendOrderedImages(params: {
  mediaEntries: OrderedTurnMedia[];
  imageSlots: OrderedImageSlot[];
  images: ImageContent[] | undefined;
  imageOrder?: PromptImageOrderEntry[];
  sourceIndex?: number;
}) {
  const images = params.images ?? [];
  if (!params.imageOrder || params.imageOrder.length === 0) {
    for (const image of images) {
      params.mediaEntries.push({
        media: image,
        sourceIndex: params.sourceIndex,
        sequence: params.mediaEntries.length,
      });
      params.imageSlots.push({
        imageOrder: "inline",
        sourceIndex: params.sourceIndex,
        sequence: params.imageSlots.length,
      });
    }
    return;
  }

  let inlineIndex = 0;
  for (const imageOrder of params.imageOrder) {
    const image = imageOrder === "inline" ? images[inlineIndex++] : undefined;
    if (image) {
      params.mediaEntries.push({
        media: image,
        sourceIndex: params.sourceIndex,
        sequence: params.mediaEntries.length,
      });
    }
    params.imageSlots.push({
      imageOrder,
      sourceIndex: params.sourceIndex,
      sequence: params.imageSlots.length,
    });
  }
  while (inlineIndex < images.length) {
    const image = images[inlineIndex++];
    if (!image) {
      continue;
    }
    params.mediaEntries.push({
      media: image,
      sourceIndex: params.sourceIndex,
      sequence: params.mediaEntries.length,
    });
    params.imageSlots.push({
      imageOrder: "inline",
      sourceIndex: params.sourceIndex,
      sequence: params.imageSlots.length,
    });
  }
}

function resolveMergedTurnInputMedia(
  mediaEntries: OrderedTurnMedia[],
  imageSlots: OrderedImageSlot[],
  handledVideoSourceIndexes: number[],
  handledVideoSourceIds: string[],
): {
  inputMedia?: MediaContent[];
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  imageSourceIndexes?: Array<number | undefined>;
} {
  const merged = mediaEntries.toSorted((left, right) => {
    if (left.sourceIndex !== undefined && right.sourceIndex !== undefined) {
      return left.sourceIndex - right.sourceIndex || left.sequence - right.sequence;
    }
    if (left.sourceIndex !== undefined || right.sourceIndex !== undefined) {
      return left.sequence - right.sequence;
    }
    return left.sequence - right.sequence;
  });
  const inputMedia = merged.map((entry) => entry.media);
  const images = inputMedia.filter((media): media is ImageContent => media.type === "image");
  const orderedImageSlots = imageSlots.toSorted((left, right) => {
    if (left.sourceIndex !== undefined && right.sourceIndex !== undefined) {
      return left.sourceIndex - right.sourceIndex || left.sequence - right.sequence;
    }
    return left.sequence - right.sequence;
  });
  if (
    inputMedia.length === 0 &&
    orderedImageSlots.length === 0 &&
    handledVideoSourceIndexes.length === 0 &&
    handledVideoSourceIds.length === 0
  )
    return {};
  const result = {
    ...(inputMedia.length > 0 ? { inputMedia } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(orderedImageSlots.length > 0
      ? { imageOrder: orderedImageSlots.map((entry) => entry.imageOrder) }
      : {}),
    ...(handledVideoSourceIndexes.length > 0 ? { handledVideoSourceIndexes } : {}),
    ...(handledVideoSourceIds.length > 0 ? { handledVideoSourceIds } : {}),
  };
  Object.defineProperty(result, "imageSourceIndexes", {
    value: orderedImageSlots.map((entry) => entry.sourceIndex),
  });
  return result;
}

/** Resolves native current-turn media while preserving image-only compatibility projections. */
export async function resolveCurrentTurnInputMedia(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  inputMedia?: MediaContent[];
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  extractedFileImages?: ExtractedFileImage[];
}): Promise<{
  inputMedia?: MediaContent[];
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  imageSourceIndexes?: Array<number | undefined>;
  handledVideoSourceIndexes?: number[];
  handledVideoSourceIds?: string[];
}> {
  const preparedMedia = params.inputMedia ?? params.images;
  const mediaEntries: OrderedTurnMedia[] = [];
  const imageSlots: OrderedImageSlot[] = [];
  const preparedFactIndexes = readRuntimePromptImageFactIndexes(preparedMedia ?? []);
  for (const [index, media] of (preparedMedia ?? []).entries()) {
    mediaEntries.push({
      media,
      sourceIndex: preparedFactIndexes?.[index] ?? undefined,
      sequence: mediaEntries.length,
    });
  }
  appendOrderedImages({
    mediaEntries: [],
    imageSlots,
    images: [],
    imageOrder: params.imageOrder,
  });
  const normalizedAttachments = normalizeAttachments(params.ctx);
  const handledVideoSourceIndexes =
    params.ctx.MediaUnderstanding?.flatMap((output) => {
      if (output.kind !== "video.description") return [];
      const attachment = normalizedAttachments[output.attachmentIndex];
      return [attachment?.sourceIndex ?? output.attachmentIndex];
    }) ?? [];
  const handledVideoSourceIds =
    params.ctx.MediaUnderstanding?.flatMap((output) => {
      if (output.kind !== "video.description") return [];
      const sourceId = normalizedAttachments[output.attachmentIndex]?.sourceId;
      return sourceId ? [sourceId] : [];
    }) ?? [];
  for (const image of params.extractedFileImages ?? []) {
    appendOrderedImages({
      mediaEntries,
      imageSlots,
      images: [stripExtractedFileImageMetadata(image)],
      sourceIndex: image.attachmentIndex,
    });
  }

  const currentImageAttachments = collectCurrentImageAttachments(params.ctx);
  if (currentImageAttachments.length === 0) {
    return resolveMergedTurnInputMedia(
      mediaEntries,
      imageSlots,
      handledVideoSourceIndexes,
      handledVideoSourceIds,
    );
  }
  const describedImageIndexes = collectDescribedImageAttachmentIndexes(params.ctx);
  const undescribedImageAttachments = currentImageAttachments.filter(
    (attachment) => !describedImageIndexes.has(attachment.index),
  );
  if (undescribedImageAttachments.length === 0) {
    return resolveMergedTurnInputMedia(
      mediaEntries,
      imageSlots,
      handledVideoSourceIndexes,
      handledVideoSourceIds,
    );
  }

  try {
    // Only send undescribed current images natively; described images already exist as text context.
    const resolved = await resolveAgentTurnAttachments({
      ctx: createUndescribedImageContext(params.ctx, undescribedImageAttachments),
      cfg: params.cfg,
      includeRecentHistoryImages: false,
    });
    const images = resolved.attachments.map(
      (attachment): ImageContent => ({
        type: "image",
        data: attachment.data,
        mimeType: attachment.mediaType,
      }),
    );
    if (images.length < undescribedImageAttachments.length) {
      logVerbose(
        `agent-runner: native OpenClaw media resolution produced ${images.length}/${undescribedImageAttachments.length} current image attachment(s); falling back to prompt image refs`,
      );
      return resolveMergedTurnInputMedia(
        mediaEntries,
        imageSlots,
        handledVideoSourceIndexes,
        handledVideoSourceIds,
      );
    }
    for (const [index, image] of images.entries()) {
      appendOrderedImages({
        mediaEntries,
        imageSlots,
        images: [image],
        sourceIndex:
          undescribedImageAttachments[index]?.sourceIndex ??
          undescribedImageAttachments[index]?.index,
      });
    }
    return resolveMergedTurnInputMedia(
      mediaEntries,
      imageSlots,
      handledVideoSourceIndexes,
      handledVideoSourceIds,
    );
  } catch (error) {
    logVerbose(
      `agent-runner: media attachment image resolution failed, proceeding without native images: ${formatErrorMessage(error)}`,
    );
    return resolveMergedTurnInputMedia(
      mediaEntries,
      imageSlots,
      handledVideoSourceIndexes,
      handledVideoSourceIds,
    );
  }
}
