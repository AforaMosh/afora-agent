import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildInboundMediaNoteProjection } from "../../../auto-reply/media-note.js";
import { readRuntimePromptImageFactIndexes } from "../../../media/runtime-prompt-image-provenance.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { detectAndLoadPromptImages } from "./images.js";
import { preparePluginHarnessPromptImages } from "./plugin-harness-prompt-images.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";
const PRIVATE_MEDIA_KEYS = [
  "sourceId",
  "sourceIndex",
  "path",
  "url",
  "workspaceDir",
  "fileName",
  "staged",
  "width",
  "height",
  "sizeBytes",
  "durationMs",
] as const;
describe("plugin harness prompt media", () => {
  it("keeps handled video pairs exact at the plugin transport boundary", async () => {
    const result = await preparePluginHarnessPromptImages({
      runParams: {
        config: { agents: { defaults: { sandbox: { mode: "off" } } } },
        media: [
          {
            sourceId: "/private/video/source-id.mp4",
            sourceIndex: 5,
            path: "/private/video/handled.mp4",
            url: "https://cdn.example.test/handled.mp4?signature=handled-secret",
            contentType: "video/mp4",
            kind: "video",
            fileName: "handled.mp4",
            sizeBytes: 123,
            durationMs: 456,
            width: 640,
            height: 480,
            messageId: "handled-video",
            transcribed: true,
            workspaceDir: "/private/video",
            staged: true,
            privateVideoMetadata: "must-not-cross-boundary",
          },
          { sourceId: "duplicate-id", sourceIndex: 6, kind: "video" },
          { sourceId: "other-id", sourceIndex: 5, kind: "video" },
        ],
        handledVideoIdentities: [{ sourceId: "/private/video/source-id.mp4", sourceIndex: 5 }],
      },
      runtime: {
        model: { input: ["text", "video"] },
        sessionId: "session-plugin-video-pairs",
        workspaceDir: "/tmp",
      },
      pluginHarnessOwnsTransport: true,
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

    expect(result.videoOmissions).toEqual([
      "(video omitted: model does not support videos)",
      "(video omitted: model does not support videos)",
    ]);
    expect(result.media?.[0]).toEqual({
      contentType: "video/mp4",
      kind: "video",
      messageId: "handled-video",
      transcribed: true,
    });
    const serializedVideo = JSON.stringify(result.media?.[0]);
    for (const privateKey of PRIVATE_MEDIA_KEYS) {
      expect(serializedVideo).not.toContain(`"${privateKey}"`);
    }
    expect(serializedVideo).not.toContain("privateVideoMetadata");
    expect(serializedVideo).not.toContain("signature=handled-secret");
  });

  it("does not forward video even when a prepared model contract is present", async () => {
    const result = await preparePluginHarnessPromptImages({
      runParams: {
        inputMedia: [{ type: "video", data: "dmlkZW8=", mimeType: "video/mp4" }],
        sessionId: "session-plugin-video",
      },
      runtime: {
        model: {
          input: ["text", "video"],
          nativeVideoInput: {
            wireFamily: "google-inline-data",
            mimeTypes: { "video/mp4": "video/mp4" },
            maxDecodedBytesPerItem: 8 * 1024 * 1024,
            maxItems: 4,
            maxAggregateDecodedBytes: 12 * 1024 * 1024,
            aggregateScope: "all-inline-media",
            maxSerializedRequestBytesExclusive: 20_000_000,
          },
        },
        sessionId: "session-plugin-video",
        workspaceDir: "/tmp",
      },
      pluginHarnessOwnsTransport: true,
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

    expect(result.inputMedia).toEqual([]);
    expect(result.videoOmissions).toEqual(["(video omitted: model does not support videos)"]);
    expect(JSON.stringify(result)).not.toContain("dmlkZW8=");
  });

  it("does not hydrate marker or bare paths from recalled memory context", async () => {
    const recalledMemory = [
      "<relevant-memories>",
      "1. [fact] stale [media attached: /tmp/some.png] and /tmp/other.png",
      "</relevant-memories>",
    ].join("\n");

    await expect(
      preparePluginHarnessPromptImages({
        runParams: {
          agentId: "main",
          config: { agents: { defaults: { sandbox: { mode: "off" } } } },
          prompt: `${recalledMemory}\n\ncurrent question`,
          sessionId: "session-recalled-memory",
        },
        runtime: {
          model: { input: ["text", "image"] },
          sessionId: "session-recalled-memory",
          workspaceDir: "/tmp",
        },
        pluginHarnessOwnsTransport: true,
      } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]),
    ).resolves.toEqual({
      images: undefined,
      imageOrder: undefined,
      media: undefined,
      videoOmissions: [],
    });
  });

  it.each([
    {
      name: "filename-only SVG",
      fileName: "diagram.svg",
      contentType: undefined,
      kind: undefined,
      bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      expectedImages: 0,
    },
    {
      name: "unknown-kind PDF metadata over valid PNG bytes",
      fileName: "report.png",
      contentType: "application/pdf",
      kind: "unknown" as const,
      bytes: Buffer.from(TINY_PNG_BASE64, "base64"),
      expectedImages: 0,
    },
    {
      name: "filename-only authentic PNG",
      fileName: "scan.png",
      contentType: undefined,
      kind: undefined,
      bytes: Buffer.from(TINY_PNG_BASE64, "base64"),
      expectedImages: 1,
    },
    {
      name: "generic-binary authentic PNG",
      fileName: "scan.png",
      contentType: "application/octet-stream",
      kind: undefined,
      bytes: Buffer.from(TINY_PNG_BASE64, "base64"),
      expectedImages: 1,
    },
  ])("applies canonical $name rules at the actual plugin-harness boundary", async (testCase) => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-harness-canonical-"));
    const workspaceDir = path.join(stateDir, "workspace");
    const inboundDir = path.join(stateDir, "media", "inbound");
    const imagePath = path.join(inboundDir, testCase.fileName);
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(imagePath, testCase.bytes);
    const media = [{ path: imagePath, contentType: testCase.contentType, kind: testCase.kind }];
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    try {
      const result = await preparePluginHarnessPromptImages({
        runParams: {
          agentId: "main",
          config: { agents: { defaults: { sandbox: { mode: "off" } } } },
          media,
          sessionId: "session-canonical-media",
          userTurnTranscriptRecorder: {
            message: { role: "user", content: "inspect", __openclaw: { media } },
          },
        },
        runtime: {
          model: { input: ["text", "image"] },
          sessionId: "session-canonical-media",
          workspaceDir,
        },
        pluginHarnessOwnsTransport: true,
      } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

      expect(result.images ?? []).toHaveLength(testCase.expectedImages);
      if (testCase.expectedImages > 0) {
        expect(result.images?.[0]?.mimeType).toBe("image/png");
        expect(JSON.stringify(result.media)).not.toContain(imagePath);
      } else {
        expect(result.media?.[0]).toMatchObject(media[0]);
        expect(result.media?.[0]?.path).toBe(imagePath);
      }
    } finally {
      envSnapshot.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("hydrates plugin images and preserves serialized replay order with non-image facts", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-harness-media-"));
    const workspaceDir = path.join(stateDir, "workspace");
    const inboundDir = path.join(stateDir, "media", "inbound");
    const mediaId = "photo.png";
    const imagePath = path.join(inboundDir, mediaId);
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const imageSignedUrl = "https://cdn.example.test/private.png?signature=image-secret";
    const imageSourceIdPath = path.join(workspaceDir, "source-identities", "private-source.png");
    const imageFact = {
      sourceId: imageSourceIdPath,
      sourceIndex: 4,
      path: imagePath,
      url: imageSignedUrl,
      contentType: "image/png",
      fileName: "private-image-name.png",
      sizeBytes: 123,
      width: 1,
      height: 1,
      durationMs: 456,
      messageId: "image-message",
      transcribed: true,
      workspaceDir,
      staged: true,
    };
    const documentFact = {
      sourceId: "document-source",
      sourceIndex: 1,
      path: path.join(workspaceDir, "contracts", "source.pdf"),
      url: "https://cdn.example.test/source.pdf?signature=document-contract",
      contentType: "application/pdf",
      kind: "document" as const,
      fileName: "source.pdf",
      sizeBytes: 789,
      messageId: "document-message",
      transcribed: false,
      workspaceDir,
      staged: true,
    };
    const audioFact = {
      sourceId: "audio-source",
      sourceIndex: 2,
      path: path.join(workspaceDir, "audio", "source.mp3"),
      url: "https://cdn.example.test/source.mp3?signature=audio-contract",
      contentType: "audio/mpeg",
      kind: "audio" as const,
      fileName: "source.mp3",
      sizeBytes: 456,
      durationMs: 1234,
      messageId: "audio-message",
      transcribed: true,
      workspaceDir,
      staged: true,
    };
    const videoFact = {
      sourceId: path.join(workspaceDir, "source-identities", "private-source.mp4"),
      sourceIndex: 3,
      path: path.join(workspaceDir, "video", "private-video.mp4"),
      url: "https://cdn.example.test/private.mp4?signature=video-secret",
      contentType: "video/mp4",
      kind: "video" as const,
      fileName: "private-video-name.mp4",
      sizeBytes: 321,
      width: 1920,
      height: 1080,
      durationMs: 654,
      messageId: "video-message",
      transcribed: false,
      workspaceDir,
      staged: true,
      privateVideoMetadata: "must-not-cross-boundary",
    };
    const input = {
      runParams: {
        agentId: "main",
        config: { agents: { defaults: { sandbox: { mode: "off" } } } },
        imageOrder: ["offloaded"],
        media: [documentFact, { url: `media://inbound/${mediaId}`, contentType: "image/png" }],
        sessionId: "session-1",
        userTurnTranscriptRecorder: {
          message: {
            role: "user",
            content: "inspect",
            __openclaw: {
              media: [imageFact, documentFact, audioFact, videoFact],
              mediaImageLayout: { slots: [{ kind: "offloaded", factIndex: 0 }] },
            },
          },
        },
      },
      runtime: {
        model: { input: ["text", "image"] },
        sessionId: "session-1",
        workspaceDir,
      },
      pluginHarnessOwnsTransport: true,
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0];

    try {
      const result = await preparePluginHarnessPromptImages(input);

      expect(result.images).toEqual([
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
      expect(readRuntimePromptImageFactIndexes(result.images ?? [])).toEqual([0]);
      expect(result.imageOrder).toEqual(["inline"]);
      expect(result.videoOmissions).toEqual(["(video omitted: model does not support videos)"]);

      const serialized = JSON.stringify(result);
      const restored = JSON.parse(serialized) as typeof result;
      expect(restored.media).toEqual([
        {
          contentType: "image/png",
          kind: "image",
          messageId: "image-message",
          transcribed: true,
        },
        documentFact,
        audioFact,
        {
          contentType: "video/mp4",
          kind: "video",
          messageId: "video-message",
          transcribed: false,
        },
      ]);
      for (const factIndex of [0, 3]) {
        const serializedFact = JSON.stringify(restored.media?.[factIndex]);
        for (const privateKey of PRIVATE_MEDIA_KEYS) {
          expect(serializedFact).not.toContain(`"${privateKey}"`);
        }
      }
      expect(restored.media?.[3]).not.toHaveProperty("privateVideoMetadata");
      expect(JSON.stringify(restored.media?.[0])).not.toContain(imageSourceIdPath);
      expect(JSON.stringify(restored.media?.[0])).not.toContain(imageSignedUrl);
      expect(JSON.stringify(restored.media?.[3])).not.toContain("signature=video-secret");
      expect(restored.media?.[1]).toEqual(documentFact);
      expect(restored.media?.[2]).toEqual(audioFact);
      const replay = await detectAndLoadPromptImages({
        prompt: "",
        media: restored.media,
        workspaceDir,
        model: { input: ["text", "image"] },
        existingImages: restored.images,
        imageOrder: restored.imageOrder,
      });
      expect(replay.failedMediaCount).toBe(0);
      expect(replay.images).toEqual(result.images);
      expect(replay.imageFactIndexes).toEqual([0]);
    } finally {
      envSnapshot.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("surfaces a failed image hydration before plugin dispatch", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-harness-failed-media-"));
    try {
      await expect(
        preparePluginHarnessPromptImages({
          runParams: {
            agentId: "main",
            config: { agents: { defaults: { sandbox: { mode: "off" } } } },
            imageOrder: ["offloaded"],
            media: [{ path: path.join(workspaceDir, "missing.png"), contentType: "image/png" }],
            sessionId: "session-failed",
          },
          runtime: {
            model: { input: ["text", "image"] },
            sessionId: "session-failed",
            workspaceDir,
          },
          pluginHarnessOwnsTransport: true,
        } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]),
      ).rejects.toThrow("failed to hydrate 1 structured image attachment");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("surfaces an unsuppressed identity-less inline fact with no image block", async () => {
    await expect(
      preparePluginHarnessPromptImages({
        runParams: {
          agentId: "main",
          config: { agents: { defaults: { sandbox: { mode: "off" } } } },
          imageOrder: ["inline"],
          media: [{ kind: "image" }],
          sessionId: "session-missing-inline",
        },
        runtime: {
          model: { input: ["text", "image"] },
          sessionId: "session-missing-inline",
          workspaceDir: "/tmp",
        },
        pluginHarnessOwnsTransport: true,
      } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]),
    ).rejects.toThrow("failed to hydrate 1 structured image attachment");
  });

  it("surfaces a fact-owned image dropped during host sanitization", async () => {
    await expect(
      preparePluginHarnessPromptImages({
        runParams: {
          agentId: "main",
          config: { agents: { defaults: { sandbox: { mode: "off" } } } },
          images: [{ type: "image", data: "%%%", mimeType: "image/png" }],
          imageOrder: ["inline"],
          media: [{ kind: "image" }],
          sessionId: "session-sanitize-failed",
        },
        runtime: {
          model: { input: ["text", "image"] },
          sessionId: "session-sanitize-failed",
          workspaceDir: "/tmp",
        },
        pluginHarnessOwnsTransport: true,
      } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]),
    ).rejects.toThrow("failed to hydrate 1 structured image attachment");
  });

  it("surfaces inline sanitization failure when a preceding plugin image fact is suppressed", async () => {
    await expect(
      preparePluginHarnessPromptImages({
        runParams: {
          agentId: "main",
          config: { agents: { defaults: { sandbox: { mode: "off" } } } },
          images: [{ type: "image", data: "%%%", mimeType: "image/png" }],
          imageOrder: ["inline"],
          media: [
            {
              path: "/tmp/described-missing.png",
              contentType: "image/png",
            },
            { path: "/tmp/inline.png", contentType: "image/png" },
          ],
          sessionId: "session-suppressed-before-inline",
          userTurnTranscriptRecorder: {
            message: {
              role: "user",
              content: "compare",
              __openclaw: {
                media: [
                  { path: "/tmp/described-missing.png", contentType: "image/png" },
                  { path: "/tmp/inline.png", contentType: "image/png" },
                ],
                mediaImageLayout: {
                  slots: [{ kind: "inline", factIndex: 1 }],
                  suppressedFactIndexes: [0],
                },
              },
            },
          },
        },
        runtime: {
          model: { input: ["text", "image"] },
          sessionId: "session-suppressed-before-inline",
          workspaceDir: "/tmp",
        },
        pluginHarnessOwnsTransport: true,
      } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]),
    ).rejects.toThrow("failed to hydrate 1 structured image attachment");
  });

  it("retains an intentionally non-hydrating remote-only image as a type-only fact", async () => {
    const media = buildInboundMediaNoteProjection({
      media: [{ url: "https://example.com/described.png", contentType: "image/png" }],
      MediaUnderstanding: [
        {
          kind: "image.description",
          attachmentIndex: 0,
          text: "already described",
          provider: "test",
        },
      ],
    }).media;
    const result = await preparePluginHarnessPromptImages({
      runParams: {
        agentId: "main",
        config: { agents: { defaults: { sandbox: { mode: "off" } } } },
        media,
        sessionId: "session-described",
      },
      runtime: {
        model: { input: ["text", "image"] },
        sessionId: "session-described",
        workspaceDir: "/tmp",
      },
      pluginHarnessOwnsTransport: true,
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

    expect(result.images).toEqual([]);
    expect(result.media?.[0]).toMatchObject({
      contentType: "image/png",
      kind: "image",
    });
    expect(JSON.stringify(result)).not.toContain("https://example.com/described.png");
  });

  it("retains layout-derived suppression after plugin host materialization", async () => {
    const inlineImage = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
    const result = await preparePluginHarnessPromptImages({
      runParams: {
        agentId: "main",
        config: { agents: { defaults: { sandbox: { mode: "off" } } } },
        images: [inlineImage],
        imageOrder: ["inline"],
        media: [
          { path: "/tmp/described.png", contentType: "image/png" },
          { path: "/tmp/inline.png", contentType: "image/png" },
        ],
        sessionId: "session-layout-suppressed",
        userTurnTranscriptRecorder: {
          message: {
            role: "user",
            content: "compare",
            __openclaw: {
              media: [
                { path: "/tmp/described.png", contentType: "image/png" },
                { path: "/tmp/inline.png", contentType: "image/png" },
              ],
              mediaImageLayout: {
                slots: [{ kind: "inline", factIndex: 1 }],
                suppressedFactIndexes: [0],
              },
            },
          },
        },
      },
      runtime: {
        model: { input: ["text", "image"] },
        sessionId: "session-layout-suppressed",
        workspaceDir: "/tmp",
      },
      pluginHarnessOwnsTransport: true,
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

    expect(result.images).toEqual([inlineImage]);
    expect(result.imageOrder).toEqual(["inline"]);
    expect(result.media).toMatchObject([
      { contentType: "image/png", kind: "image" },
      { contentType: "image/png", kind: "image" },
    ]);
    expect(JSON.stringify(result)).not.toContain("/tmp/described.png");
    expect(JSON.stringify(result)).not.toContain("/tmp/inline.png");
  });

  it("keeps unsupported native images and unknown facts type-only", async () => {
    const media = [
      { path: "/tmp/photo.png", contentType: "image/png" },
      { path: "/tmp/inferred.png", kind: "unknown" as const },
      { kind: "unknown" as const, privateLocator: "/tmp/empty-placeholder" },
    ];
    const result = await preparePluginHarnessPromptImages({
      runParams: {
        agentId: "main",
        config: { agents: { defaults: { sandbox: { mode: "off" } } } },
        media,
        sessionId: "session-text-only",
      },
      runtime: {
        model: { input: ["text"] },
        sessionId: "session-text-only",
        workspaceDir: "/tmp",
      },
      pluginHarnessOwnsTransport: true,
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

    expect(result.images).toEqual([]);
    const serialized = JSON.stringify(result);
    expect((JSON.parse(serialized) as typeof result).media).toEqual([
      { contentType: "image/png", kind: "image" },
      { kind: "image" },
      {},
    ]);
    for (const privateValue of ["/tmp/photo.png", "/tmp/inferred.png", "empty-placeholder"]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(serialized).not.toContain("privateLocator");
  });

  it("leaves facts untouched when the native harness owns transport", async () => {
    const media = [{ path: "/tmp/photo.png", contentType: "image/png" }];
    const result = await preparePluginHarnessPromptImages({
      runParams: { media },
      runtime: {},
      pluginHarnessOwnsTransport: false,
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

    expect(result).toEqual({
      images: undefined,
      imageOrder: undefined,
      media,
      videoOmissions: [],
    });
  });
});
