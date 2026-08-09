import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { isImageMediaFact, readPersistedMediaFacts } from "../../../media/media-facts.js";
import { resolveImageSanitizationLimits } from "../../image-sanitization.js";
import { resolveAttemptWorkspaceSandbox } from "./attempt-setup.js";
import { detectAndLoadPromptMedia } from "./images.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { readPersistedMediaImageLayout } from "./prompt-image-metadata.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/** Materializes fact-carried native media before a plugin harness owns transport. */
export async function preparePluginHarnessPromptImages(params: {
  runParams: RunEmbeddedAgentParams;
  runtime: {
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
    model: EmbeddedRunAttemptParams["model"];
  };
  pluginHarnessOwnsTransport: boolean;
}): Promise<{
  inputMedia?: RunEmbeddedAgentParams["inputMedia"];
  images: RunEmbeddedAgentParams["images"];
  imageOrder: RunEmbeddedAgentParams["imageOrder"];
  media: RunEmbeddedAgentParams["media"];
  videoOmissions: string[];
}> {
  const { runParams, runtime } = params;
  if (!params.pluginHarnessOwnsTransport) {
    return {
      ...(runParams.inputMedia ? { inputMedia: runParams.inputMedia } : {}),
      images: runParams.images,
      imageOrder: runParams.imageOrder,
      media: runParams.media,
      videoOmissions: [],
    };
  }
  const existingMedia = runParams.inputMedia ?? runParams.images;
  const passthrough = () => ({
    ...(runParams.inputMedia ? { inputMedia: runParams.inputMedia } : {}),
    images: runParams.images,
    imageOrder: runParams.imageOrder,
    media: runParams.media,
    videoOmissions: [],
  });
  const persistedMessage =
    runParams.userTurnTranscriptRecorder?.message ??
    (await runParams.userTurnTranscriptRecorder?.resolveMessage());
  const persistedMedia = persistedMessage ? (readPersistedMediaFacts(persistedMessage) ?? []) : [];
  const hydrationMedia = persistedMedia.length > 0 ? persistedMedia : runParams.media;
  if (
    !existingMedia?.length &&
    !hydrationMedia?.some(isImageMediaFact) &&
    !hydrationMedia?.length
  ) {
    return passthrough();
  }

  const workspace = await resolveAttemptWorkspaceSandbox({
    ...runParams,
    cwd: undefined,
    sessionId: runtime.sessionId,
    sessionKey: runtime.sessionKey,
    workspaceDir: runtime.workspaceDir,
  });
  const pluginHarnessModel = { ...runtime.model };
  delete pluginHarnessModel.nativeVideoInput;
  const result = await detectAndLoadPromptMedia({
    prompt: "",
    media: hydrationMedia,
    mediaImageLayout: persistedMessage
      ? readPersistedMediaImageLayout(persistedMessage)
      : undefined,
    workspaceDir: workspace.effectiveWorkspace,
    // Plugin harnesses have no v1 video input contract even when their catalog
    // model originated from a provider that supports the OpenClaw harness.
    model: pluginHarnessModel,
    existingMedia,
    handledVideoSourceIndexes: runParams.handledVideoSourceIndexes,
    handledVideoSourceIds: runParams.handledVideoSourceIds,
    imageOrder: runParams.imageOrder,
    maxBytes: MAX_IMAGE_BYTES,
    maxDimensionPx: resolveImageSanitizationLimits(runParams.config).maxDimensionPx,
    localRoots: workspace.effectiveFsWorkspaceOnly
      ? [workspace.effectiveWorkspace, workspace.resolvedWorkspace]
      : undefined,
    workspaceOnly: workspace.effectiveFsWorkspaceOnly,
    sandbox:
      workspace.sandbox?.enabled && workspace.sandbox.fsBridge
        ? { root: workspace.sandbox.workspaceDir, bridge: workspace.sandbox.fsBridge }
        : undefined,
  });
  const failedImageCount = result.failedMediaCount - result.videoOmissions.length;
  if (failedImageCount > 0) {
    throw new Error(
      `failed to hydrate ${failedImageCount} structured image attachment(s) for plugin harness input`,
    );
  }
  return {
    ...(runParams.inputMedia || result.media.some((part) => part.type === "video")
      ? { inputMedia: result.media }
      : {}),
    images: result.images,
    imageOrder: result.images.length > 0 ? result.images.map(() => "inline" as const) : undefined,
    media: hydrationMedia?.length ? hydrationMedia : undefined,
    videoOmissions: result.videoOmissions.map((omission) => omission.text),
  };
}
