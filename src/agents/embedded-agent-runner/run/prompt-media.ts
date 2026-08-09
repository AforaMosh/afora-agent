import {
  createNativeVideoAdmissionAccumulator,
  decodedBase64Bytes,
  formatNativeVideoOmission,
  type NativeVideoOmissionReason,
  resolveNativeVideoInputContract,
} from "@openclaw/llm-core";
import { safeFileURLToPath } from "../../../infra/local-file-access.js";
import type {
  ImageContent,
  MediaContent,
  Model,
  ModelInputContent,
  VideoContent,
} from "../../../llm/types.js";
import {
  isVideoMediaFact,
  normalizeMediaFacts,
  type MediaFact,
} from "../../../media/media-facts.js";
import { classifyMediaReferenceSource } from "../../../media/media-reference.js";
import type { PromptImageOrderEntry } from "../../../media/prompt-image-order.js";
import {
  finalizeRuntimePromptImages,
  readRuntimePromptImageFactIndexes,
} from "../../../media/runtime-prompt-image-provenance.js";
import { resolveUserPath } from "../../../utils.js";
import type { SandboxFsBridge } from "../../sandbox/fs-bridge.js";
import type { ImageFactIndex, MediaImageLayout } from "./prompt-image-metadata.js";

export type DetectedPromptMediaRef = {
  raw: string;
  type: "path" | "media-uri";
  resolved: string;
};

export type PromptImageLoadParams = {
  prompt: string;
  media?: readonly MediaFact[];
  workspaceDir: string;
  model: Pick<Model, "input" | "nativeVideoInput">;
  existingImages?: ImageContent[];
  existingImageFactIndexes?: readonly ImageFactIndex[];
  imageOrder?: PromptImageOrderEntry[];
  mediaImageLayout?: MediaImageLayout;
  maxBytes?: number;
  maxDimensionPx?: number;
  workspaceOnly?: boolean;
  localRoots?: readonly string[];
  sandbox?: { root: string; bridge: SandboxFsBridge };
};

export type PromptImageLoadResult = {
  images: ImageContent[];
  imageFactIndexes: ImageFactIndex[];
  detectedRefs: DetectedPromptMediaRef[];
  failedMediaCount: number;
  loadedCount: number;
  skippedCount: number;
};

type PromptVideoOmission = {
  factIndex: ImageFactIndex;
  sourceId?: string;
  sourceIndex: number;
  reason: NativeVideoOmissionReason;
  text: string;
};

export type PromptMediaLoadParams = Omit<PromptImageLoadParams, "existingImages"> & {
  existingMedia?: MediaContent[];
  existingMediaFactIndexes?: readonly ImageFactIndex[];
  /** Current-attempt descriptions already delivered as text, keyed by producer source index. */
  handledVideoSourceIndexes?: readonly number[];
  handledVideoSourceIds?: readonly string[];
};

export type PromptMediaLoadResult = PromptImageLoadResult & {
  media: MediaContent[];
  orderedBlocks: ModelInputContent[];
  videoOmissions: PromptVideoOmission[];
};

export type PromptMediaReadOptions = {
  kind: "image" | "video";
  maxBytes?: number;
  workspaceOnly?: boolean;
  localRoots?: readonly string[];
  sandbox?: { root: string; bridge: SandboxFsBridge };
};

type PromptMediaDependencies = {
  detectImages: (params: PromptImageLoadParams) => Promise<PromptImageLoadResult>;
  loadMedia: (
    ref: DetectedPromptMediaRef,
    workspaceDir: string,
    options: PromptMediaReadOptions,
  ) => Promise<MediaContent | null>;
};

type PromptMediaEntry = { media: MediaContent; factIndex: ImageFactIndex; order: number };

function videoFactReference(fact: MediaFact): DetectedPromptMediaRef | undefined {
  const inboundUri = [fact.url, fact.path].find((value) => value?.startsWith("media://inbound/"));
  const identity = inboundUri ?? fact.path ?? fact.url;
  if (!identity) {
    return undefined;
  }
  const classification = classifyMediaReferenceSource(identity);
  if (classification.isHttpUrl || classification.isDataUrl || classification.hasUnsupportedScheme) {
    return undefined;
  }
  let resolved = identity;
  if (classification.isFileUrl) {
    try {
      resolved = safeFileURLToPath(identity);
    } catch {
      return undefined;
    }
  } else if (resolved.startsWith("~")) {
    resolved = resolveUserPath(resolved);
  }
  return { raw: identity, resolved, type: inboundUri ? "media-uri" : "path" };
}

/** Hydrates image/video facts through the image owner's existing secure read boundary. */
export async function hydrateNativePromptMedia(
  params: PromptMediaLoadParams,
  dependencies: PromptMediaDependencies,
): Promise<PromptMediaLoadResult> {
  const existingMedia = params.existingMedia ?? [];
  const existingMediaFactIndexes =
    params.existingMediaFactIndexes ?? readRuntimePromptImageFactIndexes(existingMedia);
  const existingImageFactIndexes =
    params.existingImageFactIndexes ??
    existingMediaFactIndexes?.filter((_factIndex, index) => existingMedia[index]?.type === "image");
  const imageResult = await dependencies.detectImages({
    ...params,
    existingImages: existingMedia.filter((media): media is ImageContent => media.type === "image"),
    existingImageFactIndexes,
  });
  const mediaFacts = normalizeMediaFacts(params.media);
  const videoFacts = mediaFacts.flatMap((fact, factIndex) =>
    isVideoMediaFact(fact) ? [{ fact, factIndex }] : [],
  );
  const existingVideos = existingMedia.flatMap((media, index) =>
    media.type === "video"
      ? [{ video: media, factIndex: existingMediaFactIndexes?.[index], order: index }]
      : [],
  );
  if (videoFacts.length === 0 && existingVideos.length === 0) {
    return {
      ...imageResult,
      media: imageResult.images,
      orderedBlocks: imageResult.images,
      videoOmissions: [],
    };
  }

  const videoEntries: PromptMediaEntry[] = [];
  const videoOmissions: PromptVideoOmission[] = [];
  const videoOmissionOrders: number[] = [];
  const videoRefs: DetectedPromptMediaRef[] = [];
  let failedMediaCount = imageResult.failedMediaCount;
  let loadedCount = imageResult.loadedCount;
  let skippedCount = imageResult.skippedCount;
  let sequence = 0;
  const handledVideoSourceIndexes = new Set(params.handledVideoSourceIndexes ?? []);
  const handledVideoSourceIds = new Set(params.handledVideoSourceIds ?? []);
  const isHandledVideoFact = (fact: MediaFact, factIndex: number): boolean =>
    (fact.sourceId !== undefined && handledVideoSourceIds.has(fact.sourceId)) ||
    handledVideoSourceIndexes.has(fact.sourceIndex ?? factIndex);
  const omitVideo = (
    reason: NativeVideoOmissionReason,
    factIndex: ImageFactIndex,
    fact?: MediaFact,
    order?: number,
  ): void => {
    const sourceIndex = fact?.sourceIndex ?? factIndex ?? order ?? videoFacts.length + sequence;
    videoOmissions.push({
      factIndex,
      sourceIndex,
      ...(fact?.sourceId ? { sourceId: fact.sourceId } : {}),
      reason,
      text: formatNativeVideoOmission(reason),
    });
    videoOmissionOrders.push(order ?? sourceIndex);
    failedMediaCount++;
    skippedCount++;
    sequence++;
  };
  const takeExistingVideo = (factIndex: number) => {
    // A factless block is a distinct producer result, never a positional stand-in
    // for a managed fact. Stealing it here loses plugin insertion order and identity.
    const existingVideoIndex = existingVideos.findIndex((entry) => entry.factIndex === factIndex);
    return existingVideoIndex >= 0 ? existingVideos.splice(existingVideoIndex, 1)[0] : undefined;
  };
  const videoCandidates = [
    ...videoFacts.map(({ fact, factIndex }) => {
      const existing = takeExistingVideo(factIndex);
      return {
        fact,
        factIndex: factIndex as ImageFactIndex,
        existing,
        order: existing?.order ?? fact.sourceIndex ?? factIndex,
      };
    }),
    ...existingVideos.map((existing) => ({
      fact: undefined,
      factIndex: (existing.factIndex ?? null) as ImageFactIndex,
      existing,
      order: existing.order,
    })),
  ].toSorted((left, right) => left.order - right.order);
  const videoContract = resolveNativeVideoInputContract(params.model);
  if (!videoContract) {
    for (const { fact, factIndex, order } of videoCandidates) {
      if (!fact || !isHandledVideoFact(fact, factIndex ?? order)) {
        omitVideo("unsupported", factIndex, fact, order);
      }
    }
    return finalizePromptMediaResult({
      imageResult,
      videoEntries,
      videoOmissions,
      videoOmissionOrders,
      videoRefs,
      failedMediaCount,
      loadedCount,
      skippedCount,
      existingMedia,
      mediaFacts,
    });
  }
  const admission = createNativeVideoAdmissionAccumulator({
    contract: videoContract,
    initialAggregateDecodedBytes:
      videoContract.aggregateScope === "all-inline-media"
        ? imageResult.images.reduce(
            (total, image) => total + (decodedBase64Bytes(image.data) ?? 0),
            0,
          )
        : 0,
  });
  const acceptVideo = (
    video: VideoContent,
    factIndex: ImageFactIndex,
    fact?: MediaFact,
    order?: number,
  ): boolean => {
    const result = admission.admit(video);
    if (!result.ok) {
      omitVideo(result.reason, factIndex, fact, order);
      return false;
    }
    videoEntries.push({
      media: { ...video, mimeType: result.wireMimeType },
      factIndex,
      order: order ?? fact?.sourceIndex ?? factIndex ?? videoFacts.length + sequence++,
    });
    return true;
  };
  for (const { fact, factIndex, existing, order } of videoCandidates) {
    if (fact && isHandledVideoFact(fact, factIndex ?? order)) {
      continue;
    }
    const knownSizeReason = fact ? admission.assessDecodedBytes(fact.sizeBytes ?? 0) : undefined;
    if (knownSizeReason) {
      omitVideo(knownSizeReason, factIndex, fact, order);
      continue;
    }
    if (existing) {
      acceptVideo(existing.video, factIndex, fact, order);
      continue;
    }
    if (!fact) {
      continue;
    }
    const ref = videoFactReference(fact);
    if (!ref) {
      omitVideo("unavailable", factIndex, fact, order);
      continue;
    }
    videoRefs.push(ref);
    const loaded = await dependencies.loadMedia(ref, fact.workspaceDir ?? params.workspaceDir, {
      kind: "video",
      maxBytes: videoContract.maxDecodedBytesPerItem,
      workspaceOnly: params.workspaceOnly,
      localRoots: params.localRoots ?? (params.workspaceOnly ? [params.workspaceDir] : undefined),
      sandbox: params.sandbox,
    });
    if (loaded?.type === "video") {
      if (acceptVideo(loaded, factIndex, fact, order)) {
        loadedCount++;
      }
    } else {
      omitVideo(loaded ? "mime" : "unavailable", factIndex, fact, order);
    }
  }
  return finalizePromptMediaResult({
    imageResult,
    videoEntries,
    videoOmissions,
    videoOmissionOrders,
    videoRefs,
    failedMediaCount,
    loadedCount,
    skippedCount,
    existingMedia,
    mediaFacts,
  });
}

function finalizePromptMediaResult(params: {
  imageResult: PromptImageLoadResult;
  videoEntries: PromptMediaEntry[];
  videoOmissions: PromptVideoOmission[];
  videoOmissionOrders: readonly number[];
  videoRefs: DetectedPromptMediaRef[];
  failedMediaCount: number;
  loadedCount: number;
  skippedCount: number;
  existingMedia?: readonly MediaContent[];
  mediaFacts?: readonly MediaFact[];
}): PromptMediaLoadResult {
  const usedExistingMediaIndexes = new Set<number>();
  const imageEntries: PromptMediaEntry[] = params.imageResult.images.map((image, index) => {
    const factIndex = params.imageResult.imageFactIndexes[index] ?? null;
    const existingIndex =
      params.existingMedia?.findIndex(
        (candidate, candidateIndex) =>
          !usedExistingMediaIndexes.has(candidateIndex) &&
          candidate.type === "image" &&
          candidate.data === image.data &&
          candidate.mimeType === image.mimeType,
      ) ?? -1;
    if (existingIndex >= 0) {
      usedExistingMediaIndexes.add(existingIndex);
    }
    return {
      media: image,
      factIndex,
      order:
        existingIndex >= 0
          ? existingIndex
          : factIndex === null
            ? Number.MAX_SAFE_INTEGER
            : (params.mediaFacts?.[factIndex]?.sourceIndex ?? factIndex),
    };
  });
  const outcomeBlocks = [
    ...imageEntries.map((entry) => ({ kind: "media" as const, ...entry })),
    ...params.videoEntries.map((entry) => ({ kind: "media" as const, ...entry })),
    ...params.videoOmissions.map((omission, index) => ({
      kind: "omission" as const,
      factIndex: omission.factIndex,
      order: params.videoOmissionOrders[index] ?? omission.sourceIndex,
      omission,
    })),
  ];
  // Existing block position is authoritative after input hooks. Hydrated facts
  // use their parser-owned source index, and factless insertions stay interleaved.
  const ordered = outcomeBlocks.toSorted((left, right) => left.order - right.order);
  const mediaEntries = ordered.flatMap((entry) =>
    entry.kind === "media" ? [{ image: entry.media, factIndex: entry.factIndex }] : [],
  );
  const finalized = finalizeRuntimePromptImages(mediaEntries);
  let mediaIndex = 0;
  const orderedBlocks = ordered.map(
    (entry): ModelInputContent =>
      entry.kind === "media"
        ? (finalized.images[mediaIndex++] ?? entry.media)
        : { type: "text", text: entry.omission.text },
  );
  return {
    media: finalized.images,
    images: params.imageResult.images,
    imageFactIndexes: params.imageResult.imageFactIndexes,
    orderedBlocks,
    videoOmissions: params.videoOmissions,
    detectedRefs: [...params.imageResult.detectedRefs, ...params.videoRefs],
    failedMediaCount: params.failedMediaCount,
    loadedCount: params.loadedCount,
    skippedCount: params.skippedCount,
  };
}
