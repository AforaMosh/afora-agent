import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BYTES } from "../../../media-understanding/defaults.constants.js";
import { attachRuntimePromptMediaFacts } from "../../../media/media-facts.js";
import {
  finalizeRuntimePromptImages,
  readRuntimePromptImageFactIndexes,
} from "../../../media/runtime-prompt-image-provenance.js";
import { buildPersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import type { AgentMessage } from "../../runtime/index.js";
import { createHostSandboxFsBridge } from "../../test-helpers/host-sandbox-fs-bridge.js";
import { detectAndLoadPromptMedia, hydratePromptMediaMessages } from "./images.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";
// The ISO-BMFF isom brand is sufficient for the canonical MIME sniffer to
// distinguish a genuine MP4 container from image bytes with an .mp4 suffix.
const TINY_MP4_BUFFER = Buffer.from(
  "0000001c6674797069736f6d0000000069736f6d0000000000000000",
  "hex",
);

const NATIVE_VIDEO_INPUT = {
  wireFamily: "google-inline-data",
  mimeTypes: { "video/mp4": "video/mp4" },
  maxDecodedBytesPerItem: DEFAULT_MAX_BYTES.video,
  maxItems: 4,
  maxAggregateDecodedBytes: DEFAULT_MAX_BYTES.video,
  aggregateScope: "video",
  maxSerializedRequestBytesExclusive: 20_000_000,
} as const;

function nativeVideoModel(input: Array<"text" | "image" | "video">) {
  return { input, nativeVideoInput: NATIVE_VIDEO_INPUT };
}

async function withVideoFixture<T>(
  run: (fixture: { workspaceDir: string; videoPath: string }) => Promise<T>,
): Promise<T> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-video-"));
  const videoPath = path.join(workspaceDir, "clip.mp4");
  await fs.writeFile(videoPath, TINY_MP4_BUFFER);
  try {
    return await run({ workspaceDir, videoPath });
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
}

describe("native prompt video hydration", () => {
  it("uses the independent video size limit instead of the image sanitization limit", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      const result = await detectAndLoadPromptMedia({
        prompt: "describe the clip",
        media: [{ path: videoPath, contentType: "video/mp4", sizeBytes: TINY_MP4_BUFFER.length }],
        workspaceDir,
        model: nativeVideoModel(["text", "video"]),
        maxBytes: 1,
        workspaceOnly: true,
      });

      expect(result.media).toEqual([
        { type: "video", data: TINY_MP4_BUFFER.toString("base64"), mimeType: "video/mp4" },
      ]);
      expect(result.images).toEqual([]);
      expect(result.imageFactIndexes).toEqual([]);
      expect(readRuntimePromptImageFactIndexes(result.media)).toEqual([0]);
      expect(result.loadedCount).toBe(1);
      expect(result.failedMediaCount).toBe(0);
    });
  });

  it("interleaves image and video blocks in canonical fact order", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      const firstImagePath = path.join(workspaceDir, "first.png");
      const lastImagePath = path.join(workspaceDir, "last.png");
      await fs.writeFile(firstImagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
      await fs.writeFile(lastImagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
      const result = await detectAndLoadPromptMedia({
        prompt: "compare",
        media: [
          { path: firstImagePath, contentType: "image/png" },
          { path: videoPath, contentType: "video/mp4" },
          { path: lastImagePath, contentType: "image/png" },
        ],
        workspaceDir,
        model: nativeVideoModel(["text", "image", "video"]),
        workspaceOnly: true,
      });

      expect(result.media.map((block) => block.type)).toEqual(["image", "video", "image"]);
      expect(result.images).toHaveLength(2);
      expect(result.imageFactIndexes).toEqual([0, 2]);
      expect(readRuntimePromptImageFactIndexes(result.media)).toEqual([0, 1, 2]);
      expect(result.loadedCount).toBe(3);
    });
  });

  it("does not send video to a model without the declared video modality", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      const result = await detectAndLoadPromptMedia({
        prompt: "the fallback caption remains in text",
        media: [{ path: videoPath, contentType: "video/mp4" }],
        existingMedia: finalizeRuntimePromptImages([
          {
            image: {
              type: "video" as const,
              data: TINY_MP4_BUFFER.toString("base64"),
              mimeType: "video/mp4",
            },
            factIndex: 0,
          },
        ]).images,
        workspaceDir,
        model: { input: ["text", "image"] },
      });

      expect(result.media).toEqual([]);
      expect(result.failedMediaCount).toBe(1);
      expect(result.videoOmissions).toEqual([expect.objectContaining({ reason: "unsupported" })]);
    });
  });

  it("does not rehydrate a video already covered by a fallback caption", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      const result = await detectAndLoadPromptMedia({
        prompt: "already described",
        media: [{ sourceIndex: 0, path: videoPath, contentType: "video/mp4" }],
        handledVideoIdentities: [{ sourceIndex: 0 }],
        workspaceDir,
        model: nativeVideoModel(["text", "video"]),
      });

      expect(result.media).toEqual([]);
      expect(result.failedMediaCount).toBe(0);
      expect(result.loadedCount).toBe(0);
    });
  });

  it("skips only the exact handled pair when IDs and indexes overlap", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      const sameIdPath = path.join(workspaceDir, "same-id.mp4");
      const sameIndexPath = path.join(workspaceDir, "same-index.mp4");
      await Promise.all([
        fs.writeFile(sameIdPath, TINY_MP4_BUFFER),
        fs.writeFile(sameIndexPath, TINY_MP4_BUFFER),
      ]);
      const result = await detectAndLoadPromptMedia({
        prompt: "only the exact pair was described",
        media: [
          { sourceId: "duplicate-id", sourceIndex: 5, path: videoPath, kind: "video" },
          { sourceId: "duplicate-id", sourceIndex: 6, path: sameIdPath, kind: "video" },
          { sourceId: "other-id", sourceIndex: 5, path: sameIndexPath, kind: "video" },
        ],
        handledVideoIdentities: [{ sourceId: "duplicate-id", sourceIndex: 5 }],
        workspaceDir,
        model: nativeVideoModel(["text", "video"]),
        workspaceOnly: true,
      });

      expect(result.videoOmissions).toEqual([]);
      expect(result.media.filter((entry) => entry.type === "video")).toHaveLength(2);
      expect(result.loadedCount).toBe(2);
      expect(result.failedMediaCount).toBe(0);
    });
  });

  it("rejects an attachment whose recorded size exceeds the native video limit", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      const result = await detectAndLoadPromptMedia({
        prompt: "too large",
        media: [
          { path: videoPath, contentType: "video/mp4", sizeBytes: DEFAULT_MAX_BYTES.video + 1 },
        ],
        workspaceDir,
        model: nativeVideoModel(["text", "video"]),
      });

      expect(result.media).toEqual([]);
      expect(result.failedMediaCount).toBe(1);
      expect(result.skippedCount).toBe(1);
      expect(result.videoOmissions).toEqual([
        expect.objectContaining({ sourceIndex: 0, reason: "item-size" }),
      ]);
    });
  });

  it("rejects image bytes that are mislabeled as a video attachment", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      await fs.writeFile(videoPath, Buffer.from(TINY_PNG_BASE64, "base64"));
      const result = await detectAndLoadPromptMedia({
        prompt: "mislabeled",
        media: [{ path: videoPath, contentType: "video/mp4" }],
        workspaceDir,
        model: nativeVideoModel(["text", "video"]),
        workspaceOnly: true,
      });

      expect(result.media).toEqual([]);
      expect(result.failedMediaCount).toBe(1);
    });
  });

  it("resolves local file URLs without weakening workspace boundaries", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      const result = await detectAndLoadPromptMedia({
        prompt: "file url",
        media: [{ url: pathToFileURL(videoPath).href, contentType: "video/mp4" }],
        workspaceDir,
        model: nativeVideoModel(["text", "video"]),
        workspaceOnly: true,
      });

      expect(result.media[0]).toMatchObject({ type: "video", mimeType: "video/mp4" });
    });
  });

  it("reads managed inbound video host-side when the sandbox deliberately did not stage it", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-video-inbound-"));
    const workspaceDir = path.join(stateDir, "workspace-agent");
    const inboundDir = path.join(stateDir, "media", "inbound");
    const mediaId = "unstaged.mp4";
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(path.join(inboundDir, mediaId), TINY_MP4_BUFFER);
    const environment = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    try {
      const result = await detectAndLoadPromptMedia({
        prompt: "managed inbound",
        media: [{ url: `media://inbound/${mediaId}`, contentType: "video/mp4" }],
        workspaceDir,
        model: nativeVideoModel(["text", "video"]),
        workspaceOnly: true,
        maxBytes: 1,
        sandbox: { root: workspaceDir, bridge: createHostSandboxFsBridge(workspaceDir) },
      });

      expect(result.media).toEqual([
        { type: "video", data: TINY_MP4_BUFFER.toString("base64"), mimeType: "video/mp4" },
      ]);
      expect(result.failedMediaCount).toBe(0);
    } finally {
      environment.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["traversal", "media://inbound/../secret.mp4"],
    ["encoded traversal", "media://inbound/%2e%2e%2fsecret.mp4"],
    ["remote URL", "https://example.test/secret.mp4"],
  ])("rejects an unsafe %s video reference", async (_label, url) => {
    const result = await detectAndLoadPromptMedia({
      prompt: "unsafe",
      media: [{ url, contentType: "video/mp4" }],
      workspaceDir: os.tmpdir(),
      model: nativeVideoModel(["text", "video"]),
      workspaceOnly: true,
    });

    expect(result.media).toEqual([]);
    expect(result.failedMediaCount).toBe(1);
    expect(result.videoOmissions).toEqual([
      expect.objectContaining({ sourceIndex: 0, reason: "unavailable" }),
    ]);
  });

  it("reuses inline video blocks without duplicating their attachment facts", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      const video = {
        type: "video" as const,
        data: TINY_MP4_BUFFER.toString("base64"),
        mimeType: "video/mp4",
      };
      const result = await detectAndLoadPromptMedia({
        prompt: "already inline",
        media: [{ path: videoPath, contentType: "video/mp4" }],
        existingMedia: finalizeRuntimePromptImages([{ image: video, factIndex: 0 }]).images,
        workspaceDir,
        model: nativeVideoModel(["text", "video"]),
      });

      expect(result.media).toEqual([video]);
      expect(result.loadedCount).toBe(0);
      expect(readRuntimePromptImageFactIndexes(result.media)).toEqual([0]);
    });
  });

  it("does not consume an active inline video for an earlier suppressed fact", async () => {
    const video = {
      type: "video" as const,
      data: TINY_MP4_BUFFER.toString("base64"),
      mimeType: "video/mp4",
    };
    const result = await detectAndLoadPromptMedia({
      prompt: "only the second clip is native",
      media: [
        { kind: "video", sourceIndex: 0 },
        { kind: "video", contentType: "video/mp4" },
      ],
      handledVideoIdentities: [{ sourceIndex: 0 }],
      existingMedia: finalizeRuntimePromptImages([{ image: video, factIndex: 1 }]).images,
      workspaceDir: os.tmpdir(),
      model: nativeVideoModel(["text", "video"]),
    });

    expect(result.media).toEqual([video]);
    expect(result.failedMediaCount).toBe(0);
    expect(readRuntimePromptImageFactIndexes(result.media)).toEqual([1]);
  });

  it("does not consume an active inline video for an earlier oversized fact", async () => {
    const video = {
      type: "video" as const,
      data: TINY_MP4_BUFFER.toString("base64"),
      mimeType: "video/mp4",
    };
    const result = await detectAndLoadPromptMedia({
      prompt: "only the second clip fits",
      media: [
        { kind: "video", sizeBytes: DEFAULT_MAX_BYTES.video + 1 },
        { kind: "video", contentType: "video/mp4" },
      ],
      existingMedia: finalizeRuntimePromptImages([{ image: video, factIndex: 1 }]).images,
      workspaceDir: os.tmpdir(),
      model: nativeVideoModel(["text", "video"]),
    });

    expect(result.media).toEqual([video]);
    expect(result.failedMediaCount).toBe(1);
    expect(readRuntimePromptImageFactIndexes(result.media)).toEqual([1]);
  });

  it.each([
    { label: "invalid MIME", data: "dmlkZW8=", mimeType: "image/png", reason: "mime" },
    { label: "invalid base64", data: "not-base64!", mimeType: "video/mp4", reason: "invalid" },
    { label: "empty base64", data: "", mimeType: "video/mp4", reason: "invalid" },
  ])("rejects inline video with $label", async ({ data, mimeType, reason }) => {
    const result = await detectAndLoadPromptMedia({
      prompt: "invalid inline video",
      existingMedia: [{ type: "video", data, mimeType }],
      workspaceDir: os.tmpdir(),
      model: nativeVideoModel(["text", "video"]),
    });

    expect(result.media).toEqual([]);
    expect(result.failedMediaCount).toBe(1);
    expect(result.videoOmissions).toEqual([expect.objectContaining({ reason })]);
  });

  it("returns one ordered omission for each factless video on an unsupported final route", async () => {
    const videos = ["first", "second"].map((data) => ({
      type: "video" as const,
      data: Buffer.from(data).toString("base64"),
      mimeType: "video/mp4",
    }));
    const result = await detectAndLoadPromptMedia({
      prompt: "compare",
      existingMedia: videos,
      workspaceDir: os.tmpdir(),
      model: { input: ["text", "video"] },
    });

    expect(result.media).toEqual([]);
    expect(result.videoOmissions).toHaveLength(2);
    expect(result.orderedBlocks).toEqual([
      { type: "text", text: "(video omitted: model does not support videos)" },
      { type: "text", text: "(video omitted: model does not support videos)" },
    ]);
  });

  it("preserves source order when a route count limit delivers one clip and omits the next", async () => {
    const video = {
      type: "video" as const,
      data: TINY_MP4_BUFFER.toString("base64"),
      mimeType: "video/mp4",
    };
    const result = await detectAndLoadPromptMedia({
      prompt: "compare",
      existingMedia: [video, video],
      workspaceDir: os.tmpdir(),
      model: {
        input: ["text", "video"],
        nativeVideoInput: { ...NATIVE_VIDEO_INPUT, maxItems: 1 },
      },
    });

    expect(result.videoOmissions).toEqual([expect.objectContaining({ reason: "count" })]);
    expect(result.orderedBlocks).toEqual([
      video,
      { type: "text", text: "(video omitted: too many video attachments)" },
    ]);
  });

  it("keeps a prepended factless clip ahead of an exact managed fact", async () => {
    const factless = {
      type: "video" as const,
      data: TINY_MP4_BUFFER.toString("base64"),
      mimeType: "video/mp4",
    };
    const managed = {
      ...factless,
      data: Buffer.concat([TINY_MP4_BUFFER, Buffer.from("managed")]).toString("base64"),
    };
    const { images: existingMedia } = finalizeRuntimePromptImages([
      { image: factless, factIndex: null },
      { image: managed, factIndex: 0 },
    ]);

    const result = await detectAndLoadPromptMedia({
      prompt: "compare",
      media: [{ kind: "video", sourceId: "managed", sourceIndex: 1 }],
      existingMedia,
      workspaceDir: os.tmpdir(),
      model: {
        input: ["text", "video"],
        nativeVideoInput: { ...NATIVE_VIDEO_INPUT, maxItems: 1 },
      },
    });

    expect(result.media).toEqual([factless]);
    expect(readRuntimePromptImageFactIndexes(result.media)).toEqual([null]);
    expect(result.videoOmissions).toEqual([
      expect.objectContaining({ factIndex: 0, reason: "count", sourceId: "managed" }),
    ]);
    expect(result.orderedBlocks).toEqual([
      factless,
      { type: "text", text: "(video omitted: too many video attachments)" },
    ]);
  });

  it("turns aggregate overflow into one bounded omission", async () => {
    const video = {
      type: "video" as const,
      data: TINY_MP4_BUFFER.toString("base64"),
      mimeType: "video/mp4",
    };
    const result = await detectAndLoadPromptMedia({
      prompt: "watch",
      existingMedia: [video],
      workspaceDir: os.tmpdir(),
      model: {
        input: ["text", "video"],
        nativeVideoInput: { ...NATIVE_VIDEO_INPUT, maxAggregateDecodedBytes: 1 },
      },
    });

    expect(result.videoOmissions).toEqual([expect.objectContaining({ reason: "aggregate" })]);
    expect(result.orderedBlocks).toEqual([
      { type: "text", text: "(video omitted: total video size exceeds the limit)" },
    ]);
  });

  it("retains explicit mixed-media provenance when deriving the legacy image projection", async () => {
    const image = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
    const video = {
      type: "video" as const,
      data: TINY_MP4_BUFFER.toString("base64"),
      mimeType: "video/mp4",
    };
    const { images: existingMedia } = finalizeRuntimePromptImages<typeof image | typeof video>([
      { image: video, factIndex: 1 },
      { image, factIndex: 0 },
    ]);
    const result = await detectAndLoadPromptMedia({
      prompt: "preserve ownership",
      media: [{ kind: "image" }, { kind: "video" }],
      existingMedia,
      workspaceDir: os.tmpdir(),
      model: nativeVideoModel(["text", "image", "video"]),
    });

    expect(result.media).toEqual([video, image]);
    expect(result.imageFactIndexes).toEqual([0]);
    expect(readRuntimePromptImageFactIndexes(result.media)).toEqual([1, 0]);
  });
});

describe("native prompt video replay", () => {
  it("projects factless queued video against the replay route contract", async () => {
    const message = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "queued" },
        {
          type: "video" as const,
          data: TINY_MP4_BUFFER.toString("base64"),
          mimeType: "video/mp4",
        },
      ],
    } as unknown as AgentMessage;

    const [replayed] = await hydratePromptMediaMessages([message], {
      workspaceDir: os.tmpdir(),
      model: { input: ["text", "video"] },
    });

    expect((replayed as unknown as { content: unknown[] }).content).toEqual([
      { type: "text", text: "queued" },
      { type: "text", text: "(video omitted: model does not support videos)" },
    ]);
  });

  it("makes expired or deleted attachment facts visible without duplicating retry notices", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      await fs.rm(videoPath);
      const message = {
        role: "user" as const,
        content: "watch the expired clip",
        __openclaw: { media: [{ path: videoPath, contentType: "video/mp4" }] },
      } as unknown as AgentMessage;
      const options = {
        workspaceDir,
        model: nativeVideoModel(["text", "video"]),
        workspaceOnly: true,
      };
      const [first] = await hydratePromptMediaMessages([message], options);
      const [retried] = await hydratePromptMediaMessages([first!], options);

      expect((first as unknown as { content: unknown[] }).content).toEqual([
        { type: "text", text: "watch the expired clip" },
        { type: "text", text: "(video omitted: attachment is unavailable)" },
      ]);
      expect((retried as unknown as { content: unknown[] }).content).toEqual(
        (first as unknown as { content: unknown[] }).content,
      );
      expect(
        (retried as unknown as { __openclaw: { media: unknown[] } })["__openclaw"].media,
      ).toEqual([expect.objectContaining({ path: videoPath, contentType: "video/mp4" })]);
    });
  });

  it("explains omitted video when transcript replay switches to an unsupported model", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      const message = {
        role: "user" as const,
        content: "watch this clip",
        __openclaw: { media: [{ path: videoPath, contentType: "video/mp4" }] },
      } as unknown as AgentMessage;
      const [replayed] = await hydratePromptMediaMessages([message], {
        workspaceDir,
        model: { input: ["text", "image"] },
      });

      expect((replayed as unknown as { content: unknown[] }).content).toEqual([
        { type: "text", text: "watch this clip" },
        { type: "text", text: "(video omitted: model does not support videos)" },
      ]);
    });
  });

  it("does not add omission notices for videos already described by fallback", async () => {
    const message = {
      role: "user" as const,
      content: "the fallback caption already describes both videos",
      __openclaw: {
        media: [
          {
            sourceId: "first-video",
            sourceIndex: 1,
            path: "/missing/first-described.mp4",
            contentType: "video/mp4",
          },
          {
            sourceIndex: 3,
            path: "/missing/second-described.mp4",
            contentType: "video/mp4",
          },
        ],
        mediaVideoDescriptions: [{ sourceId: "first-video", sourceIndex: 1 }, { sourceIndex: 3 }],
      },
    } as unknown as AgentMessage;
    const [replayed] = await hydratePromptMediaMessages([message], {
      workspaceDir: os.tmpdir(),
      model: { input: ["text", "image"] },
    });

    expect((replayed as unknown as { content: unknown[] }).content).toEqual([
      { type: "text", text: "the fallback caption already describes both videos" },
    ]);
  });

  it("does not let duplicate producer-local source ids suppress an unrelated collected video", async () => {
    const message = {
      role: "user" as const,
      content: "the fallback caption describes only the first video",
      __openclaw: {
        media: [
          {
            sourceId: "producer-local-video",
            sourceIndex: 0,
            path: "/missing/first-described.mp4",
            contentType: "video/mp4",
          },
          {
            sourceId: "producer-local-video",
            sourceIndex: 1,
            path: "/missing/second-unrelated.mp4",
            contentType: "video/mp4",
          },
        ],
        mediaVideoDescriptions: [{ sourceIndex: 0 }],
      },
    } as unknown as AgentMessage;
    const [replayed] = await hydratePromptMediaMessages([message], {
      workspaceDir: os.tmpdir(),
      model: { input: ["text", "image"] },
    });

    expect((replayed as unknown as { content: unknown[] }).content).toEqual([
      { type: "text", text: "the fallback caption describes only the first video" },
      { type: "text", text: "(video omitted: model does not support videos)" },
    ]);
  });

  it("keeps paired replay identities paired across duplicate IDs and indexes", async () => {
    const message = structuredClone({
      role: "user" as const,
      content: "the fallback caption describes only the exact pair",
      timestamp: 1,
      __openclaw: {
        media: [
          {
            sourceId: "duplicate-id",
            sourceIndex: 5,
            path: "/missing/exact.mp4",
            contentType: "video/mp4",
          },
          {
            sourceId: "duplicate-id",
            sourceIndex: 6,
            path: "/missing/same-id.mp4",
            contentType: "video/mp4",
          },
          {
            sourceId: "other-id",
            sourceIndex: 5,
            path: "/missing/same-index.mp4",
            contentType: "video/mp4",
          },
        ],
        mediaVideoDescriptions: [{ sourceId: "duplicate-id", sourceIndex: 5 }],
      },
    }) as AgentMessage;
    const [replayed] = await hydratePromptMediaMessages([message], {
      workspaceDir: os.tmpdir(),
      model: { input: ["text", "image"] },
    });

    expect((replayed as unknown as { content: unknown[] }).content).toEqual([
      { type: "text", text: "the fallback caption describes only the exact pair" },
      { type: "text", text: "(video omitted: model does not support videos)" },
      { type: "text", text: "(video omitted: model does not support videos)" },
    ]);
  });

  it("replays ID-only descriptions only when the ID is independently unique", async () => {
    const message = buildPersistedUserTurnMessage({
      text: "only the unique ID was described",
      media: [
        { sourceId: "unique-id", path: "/missing/unique.mp4", kind: "video" },
        { sourceId: "duplicate-id", path: "/missing/first.mp4", kind: "video" },
        { sourceId: "duplicate-id", path: "/missing/second.mp4", kind: "video" },
      ],
      mediaVideoDescriptions: [{ sourceId: "unique-id" }, { sourceId: "duplicate-id" }],
    }) as AgentMessage;
    const [replayed] = await hydratePromptMediaMessages([message], {
      workspaceDir: os.tmpdir(),
      model: { input: ["text", "image"] },
    });

    expect(
      (message as unknown as { __openclaw?: Record<string, unknown> })["__openclaw"],
    ).toMatchObject({
      mediaVideoDescriptions: [{ sourceId: "unique-id" }, { sourceId: "duplicate-id" }],
    });
    expect((replayed as unknown as { content: unknown[] }).content).toEqual([
      { type: "text", text: "only the unique ID was described" },
      { type: "text", text: "(video omitted: model does not support videos)" },
      { type: "text", text: "(video omitted: model does not support videos)" },
    ]);
  });

  it("hydrates persisted image and video facts in their original attachment order", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      const imagePath = path.join(workspaceDir, "frame.png");
      await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
      const message = {
        role: "user" as const,
        content: "compare the clip and frame",
        __openclaw: {
          media: [
            { path: videoPath, contentType: "video/mp4" },
            { path: imagePath, contentType: "image/png" },
          ],
        },
      } as unknown as AgentMessage;
      const [replayed] = await hydratePromptMediaMessages([message], {
        workspaceDir,
        model: nativeVideoModel(["text", "image", "video"]),
        workspaceOnly: true,
      });

      expect((replayed as unknown as { content: Array<{ type: string }> }).content).toEqual([
        { type: "text", text: "compare the clip and frame" },
        { type: "video", data: TINY_MP4_BUFFER.toString("base64"), mimeType: "video/mp4" },
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
      const metadata = (
        replayed as unknown as { __openclaw: { mediaImageBlockFactIndexes: number[] } }
      )["__openclaw"];
      expect(metadata.mediaImageBlockFactIndexes).toEqual([1]);
    });
  });

  it("preserves runtime fact carriers while replacing existing video blocks once", async () => {
    await withVideoFixture(async ({ workspaceDir, videoPath }) => {
      const video = {
        type: "video" as const,
        data: TINY_MP4_BUFFER.toString("base64"),
        mimeType: "video/mp4",
      };
      const { images: media } = finalizeRuntimePromptImages([{ image: video, factIndex: 0 }]);
      const message = attachRuntimePromptMediaFacts(
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "replay" }, ...media],
          __openclaw: { mediaBlockFactIndexes: [0] },
        },
        [{ path: videoPath, contentType: "video/mp4" }],
      ) as unknown as AgentMessage;
      const [replayed] = await hydratePromptMediaMessages([message], {
        workspaceDir,
        model: nativeVideoModel(["text", "video"]),
      });

      expect((replayed as unknown as { content: unknown[] }).content).toEqual([
        { type: "text", text: "replay" },
        video,
      ]);
    });
  });
});
