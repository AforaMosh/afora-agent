import path from "node:path";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import type { ImageContent, MediaContent, Model, VideoContent } from "../../llm/types.js";
import { readRuntimeMediaFactIdentities } from "../../media/media-facts.js";
import { finalizeRuntimePromptImages } from "../../media/runtime-prompt-image-provenance.js";
import { disposeOpenClawAgentDatabaseByPath } from "../../state/openclaw-agent-db.js";
import { AuthStorage } from "./auth-storage.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { LoadExtensionsResult } from "./extensions/types.js";
import { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { createSyntheticSourceInfo } from "./source-info.js";

vi.mock("../../auto-reply/thinking.js", () => ({
  resolveThinkingDefaultForModel: () => "medium",
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const testModel: Model = {
  id: "test-video-model",
  name: "Test Video Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text", "image", "video"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
  nativeVideoInput: {
    wireFamily: "google-inline-data",
    mimeTypes: { "video/mp4": "video/mp4" },
    maxDecodedBytesPerItem: 8,
    maxItems: 2,
    maxAggregateDecodedBytes: 16,
    aggregateScope: "all-inline-media",
    maxSerializedRequestBytesExclusive: 1_000,
  },
};
const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
const video: VideoContent = { type: "video", data: "dmlkZW8=", mimeType: "video/mp4" };
const noContractModel: Model = {
  ...testModel,
  id: "test-video-model-no-contract",
  nativeVideoInput: undefined,
};
const routeLimitedModel: Model = {
  ...testModel,
  id: "test-video-model-route-limited",
  nativeVideoInput: {
    ...testModel.nativeVideoInput!,
    maxAggregateDecodedBytes: 8,
  },
};

function createNativeMediaResourceLoader(
  handlers: Map<string, Array<(...args: unknown[]) => Promise<unknown>>>,
): ResourceLoader {
  const extensionsResult: LoadExtensionsResult = {
    extensions:
      handlers.size > 0
        ? [
            {
              path: "<test-extension>",
              resolvedPath: "<test-extension>",
              sourceInfo: createSyntheticSourceInfo("<test-extension>", { source: "temporary" }),
              handlers,
              tools: new Map(),
              messageRenderers: new Map(),
              commands: new Map(),
              flags: new Map(),
              shortcuts: new Map(),
            },
          ]
        : [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

async function createNativeMediaSession(options?: {
  agentDir?: string;
  contexts?: Context[];
  handlers?: Map<string, Array<(...args: unknown[]) => Promise<unknown>>>;
  settingsManager?: SettingsManager;
  sessionManager?: SessionManager;
  model?: Model;
}) {
  const model = options?.model ?? testModel;
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(model.provider, "test-api-key");
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(model.provider, {
    api: model.api,
    streamSimple: vi.fn((activeModel: Model, context: Context) => {
      options?.contexts?.push(context);
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: activeModel.api,
        provider: activeModel.provider,
        model: activeModel.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          contextUsage: {
            state: "available",
            promptTokens: 1,
            totalTokens: 2,
          },
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    }),
  });
  return await createAgentSession({
    ...(options?.agentDir ? { agentDir: options.agentDir, cwd: options.agentDir } : {}),
    authStorage,
    model,
    resourceLoader: createNativeMediaResourceLoader(options?.handlers ?? new Map()),
    ...(options?.sessionManager
      ? { sessionManager: options.sessionManager }
      : options?.agentDir
        ? {}
        : { sessionManager: SessionManager.inMemory() }),
    settingsManager: options?.settingsManager ?? SettingsManager.inMemory(),
    modelRegistry,
  });
}

describe("AgentSession native media", () => {
  it("sends ordered video and image blocks through canonical prompt media", async () => {
    const { session } = await createNativeMediaSession();
    const prompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

    await session.prompt("describe the recording", { media: [video, image] });

    expect(prompt).toHaveBeenCalledWith([
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "describe the recording" }, video, image],
      }),
    ]);
    session.dispose();
  });

  it("keeps admitted factless video byte-identical on the provider path", async () => {
    const { session } = await createNativeMediaSession();
    const prompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

    await session.prompt("describe the recording", { media: [video] });

    const submitted = prompt.mock.calls[0]?.[0]?.[0];
    expect(submitted).toBeDefined();
    expect(submitted).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "describe the recording" }, video],
    });
    session.dispose();
  });

  it.each([
    {
      label: "prompt",
      send: (session: Awaited<ReturnType<typeof createNativeMediaSession>>["session"]) =>
        session.prompt("describe the recording", { media: [video] }),
    },
    {
      label: "extension sendUserMessage",
      send: (session: Awaited<ReturnType<typeof createNativeMediaSession>>["session"]) =>
        session.sendUserMessage([{ type: "text", text: "describe the recording" }, video]),
    },
  ])("replays persisted factless video from $label as text", async ({ send }) => {
    const agentDir = tempDirs.make("openclaw-sdk-video-transcript-");
    const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
    const contexts: Context[] = [];
    let firstSession: Awaited<ReturnType<typeof createNativeMediaSession>>["session"] | undefined;
    let replaySession: Awaited<ReturnType<typeof createNativeMediaSession>>["session"] | undefined;
    try {
      ({ session: firstSession } = await createNativeMediaSession({ agentDir, contexts }));
      await send(firstSession);

      const currentRequest = JSON.stringify(contexts[0]?.messages);
      expect(currentRequest).toContain(video.data);
      expect(currentRequest).toContain('"type":"video"');

      const target = firstSession.sessionManager.getSessionTarget();
      if (!target) {
        throw new Error("expected persisted SDK session target");
      }
      const transcriptJson = JSON.stringify(await loadTranscriptEvents(target));
      expect(transcriptJson).not.toContain(video.data);
      expect(transcriptJson).not.toContain('"type":"video"');
      expect(transcriptJson).toContain("inline video is not retained in session history");

      firstSession.dispose();
      firstSession = undefined;
      const sessionManager = SessionManager.open(target, agentDir);
      ({ session: replaySession } = await createNativeMediaSession({
        contexts,
        sessionManager,
      }));
      await replaySession.prompt("continue");

      const replayRequest = JSON.stringify(contexts[1]?.messages);
      expect(replayRequest).toContain("inline video is not retained in session history");
      expect(replayRequest).not.toContain(video.data);
      expect(replayRequest).not.toContain('"type":"video"');
    } finally {
      firstSession?.dispose();
      replaySession?.dispose();
      disposeOpenClawAgentDatabaseByPath(databasePath);
    }
  });

  it("replays an enclosing provider video source as text", async () => {
    const agentDir = tempDirs.make("openclaw-sdk-provider-video-transcript-");
    const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
    const contexts: Context[] = [];
    const rawVideo = "cHJpdmF0ZS1wcm92aWRlci12aWRlbw==";
    let firstSession: Awaited<ReturnType<typeof createNativeMediaSession>>["session"] | undefined;
    let replaySession: Awaited<ReturnType<typeof createNativeMediaSession>>["session"] | undefined;
    try {
      ({ session: firstSession } = await createNativeMediaSession({ agentDir }));
      firstSession.sessionManager.appendMessage({
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "video/mp4", data: rawVideo },
          },
        ],
        timestamp: Date.now(),
      } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
      const target = firstSession.sessionManager.getSessionTarget();
      if (!target) {
        throw new Error("expected persisted SDK session target");
      }
      const transcriptJson = JSON.stringify(await loadTranscriptEvents(target));
      expect(transcriptJson).toContain("[video data omitted]");
      expect(transcriptJson).not.toContain(rawVideo);
      expect(transcriptJson).not.toMatch(/"type":"(?:image|base64|video)"/u);

      firstSession.dispose();
      firstSession = undefined;
      const sessionManager = SessionManager.open(target, agentDir);
      ({ session: replaySession } = await createNativeMediaSession({
        contexts,
        sessionManager,
      }));
      await replaySession.prompt("continue");

      const replayRequest = JSON.stringify(contexts[0]?.messages);
      expect(replayRequest).toContain("[video data omitted]");
      expect(replayRequest).not.toContain(rawVideo);
      expect(replayRequest).not.toMatch(/"type":"(?:image|base64|video)"/u);
      expect(replayRequest).not.toContain('"source"');
    } finally {
      firstSession?.dispose();
      replaySession?.dispose();
      disposeOpenClawAgentDatabaseByPath(databasePath);
    }
  });

  it("preserves the released images option while preferring canonical media", async () => {
    const { session } = await createNativeMediaSession();
    const prompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

    await session.prompt("legacy image", { images: [image] });
    await session.prompt("canonical video", { media: [video], images: [image] });

    expect(prompt.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        content: [{ type: "text", text: "legacy image" }, image],
      }),
    ]);
    expect(prompt.mock.calls[1]?.[0]).toEqual([
      expect.objectContaining({
        content: [{ type: "text", text: "canonical video" }, video],
      }),
    ]);
    session.dispose();
  });

  it("preserves native video when an image-only extension transforms its images", async () => {
    const replacement: ImageContent = {
      type: "image",
      data: "cmVwbGFjZWQ=",
      mimeType: "image/jpeg",
    };
    const observed: Array<{ type: string; media?: MediaContent[]; images?: ImageContent[] }> = [];
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      [
        "input",
        [
          async (event: unknown) => {
            observed.push(event as (typeof observed)[number]);
            return { action: "transform", text: "transformed", images: [replacement] };
          },
        ],
      ],
      [
        "before_agent_start",
        [
          async (event: unknown) => {
            observed.push(event as (typeof observed)[number]);
          },
        ],
      ],
    ]);
    const { session } = await createNativeMediaSession({ handlers });
    const prompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

    await session.prompt("original", { media: [image, video] });

    expect(observed).toEqual([
      expect.objectContaining({ type: "input", media: [image, video], images: [image] }),
      expect.objectContaining({
        type: "before_agent_start",
        media: [replacement, video],
        images: [replacement],
      }),
    ]);
    expect(prompt).toHaveBeenCalledWith([
      expect.objectContaining({
        content: [{ type: "text", text: "transformed" }, replacement, video],
      }),
    ]);
    session.dispose();
  });

  it("treats canonical extension media transforms as authoritative", async () => {
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      [
        "input",
        [
          async () => ({
            action: "transform",
            text: "video only",
            media: [video],
            images: [image],
          }),
        ],
      ],
    ]);
    const { session } = await createNativeMediaSession({ handlers });
    const prompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

    await session.prompt("original", { media: [image] });

    expect(prompt).toHaveBeenCalledWith([
      expect.objectContaining({
        content: [{ type: "text", text: "video only" }, video],
      }),
    ]);
    session.dispose();
  });

  it.each([
    {
      label: "wrong MIME",
      media: [{ ...video, mimeType: "image/png" }],
      omission: "(video omitted: video format is not supported)",
    },
    {
      label: "oversized data",
      media: [{ ...video, data: Buffer.alloc(9).toString("base64") }],
      omission: "(video omitted: attachment exceeds the size limit)",
    },
    {
      label: "over-count data",
      media: [video, video, video],
      omission: "(video omitted: too many video attachments)",
    },
  ])("projects hook-added $label to exactly one omission", async ({ media, omission }) => {
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      ["input", [async () => ({ action: "transform", text: "hook media", media })]],
    ]);
    const { session } = await createNativeMediaSession({ handlers });
    const prompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

    await session.prompt("original");

    const submitted = prompt.mock.calls[0]?.[0]?.[0];
    expect(submitted).toMatchObject({ role: "user" });
    const content = (submitted as { content?: unknown } | undefined)?.content;
    expect(
      Array.isArray(content)
        ? content.filter((part) => part.type === "text" && part.text === omission)
        : [],
    ).toHaveLength(1);
    session.dispose();
  });

  it("keeps hook-video omissions in streaming follow-up content", async () => {
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      [
        "input",
        [
          async () => ({
            action: "transform",
            text: "queued hook media",
            media: [{ ...video, mimeType: "image/png" }],
          }),
        ],
      ],
    ]);
    const { session } = await createNativeMediaSession({ handlers });
    const followUp = vi.spyOn(session.agent, "followUp").mockImplementation(() => undefined);
    (session.agent.state as { isStreaming: boolean }).isStreaming = true;

    await session.prompt("original", { streamingBehavior: "followUp" });

    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [
          { type: "text", text: "queued hook media" },
          { type: "text", text: "(video omitted: video format is not supported)" },
        ],
      }),
    );
    session.dispose();
  });

  it("keeps ordered mixed content in extension-created user messages", async () => {
    const { session } = await createNativeMediaSession();
    const prompt = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

    await session.sendUserMessage([
      { type: "text", text: "first" },
      video,
      { type: "text", text: "second" },
      image,
    ]);

    expect(prompt).toHaveBeenCalledWith([
      expect.objectContaining({
        content: [{ type: "text", text: "first\nsecond" }, video, image],
      }),
    ]);
    session.dispose();
  });

  it("keeps video blocks while projecting mixed-media provenance onto images", async () => {
    const { session } = await createNativeMediaSession();
    const steer = vi.spyOn(session.agent, "steer").mockImplementation(() => undefined);
    const { images: media } = finalizeRuntimePromptImages<MediaContent>([
      { image: video, factIndex: null },
      { image, factIndex: 7 },
    ]);

    await session.steer("mixed attachments", media);

    expect(steer.mock.calls[0]?.[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "mixed attachments" }, video, image],
      __openclaw: { mediaBlockFactIndexes: [null, 7], mediaImageBlockFactIndexes: [7] },
    });
    session.dispose();
  });

  it("removes only the exact described video from a full-argument steer", async () => {
    const { session } = await createNativeMediaSession();
    const steer = vi.spyOn(session.agent, "steer").mockImplementation(() => undefined);
    const facts = [
      { sourceId: "duplicate-id", sourceIndex: 5, kind: "video" as const },
      { sourceId: "duplicate-id", sourceIndex: 6, kind: "video" as const },
      { sourceId: "other-id", sourceIndex: 5, kind: "video" as const },
    ];
    const { images: media } = finalizeRuntimePromptImages<MediaContent>(
      facts.map((_fact, factIndex) => ({ image: video, factIndex })),
    );
    const identities = [{ sourceId: "duplicate-id", sourceIndex: 5 }] as const;

    await session.steer(
      "only one clip was described",
      media,
      undefined,
      facts,
      undefined,
      undefined,
      undefined,
      [...identities],
    );

    const queued = steer.mock.calls[0]?.[0];
    expect(queued).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "only one clip was described" }, video, video],
      __openclaw: { mediaBlockFactIndexes: [1, 2] },
    });
    expect(queued && readRuntimeMediaFactIdentities(queued)).toEqual(identities);
    session.dispose();
  });

  it("projects direct steer video to an omission when the route has no native contract", async () => {
    const { session } = await createNativeMediaSession({ model: noContractModel });
    const steer = vi.spyOn(session.agent, "steer").mockImplementation(() => undefined);

    await session.steer("unsupported attachment", [video]);

    const queued = steer.mock.calls[0]?.[0];
    expect(queued).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "unsupported attachment" },
        { type: "text", text: "(video omitted: model does not support videos)" },
      ],
    });
    expect(JSON.stringify(queued)).not.toContain(video.data);
    session.dispose();
  });

  it("keeps native video attachments in queued follow-up turns", async () => {
    const { session } = await createNativeMediaSession();
    const followUp = vi.spyOn(session.agent, "followUp").mockImplementation(() => undefined);

    await session.followUp("watch this", [video]);

    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "watch this" }, video],
      }),
    );
    session.dispose();
  });

  it("projects direct follow-up video to an omission when route aggregate limits reject it", async () => {
    const { session } = await createNativeMediaSession({ model: routeLimitedModel });
    const followUp = vi.spyOn(session.agent, "followUp").mockImplementation(() => undefined);

    await session.followUp("bounded attachment", [image, video]);

    const queued = followUp.mock.calls[0]?.[0];
    expect(queued).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "bounded attachment" },
        image,
        { type: "text", text: "(video omitted: total video size exceeds the limit)" },
      ],
    });
    expect(JSON.stringify(queued)).not.toContain(video.data);
    session.dispose();
  });

  it("replays native video from persisted custom session messages", () => {
    const manager = SessionManager.inMemory();
    const content = [{ type: "text" as const, text: "recording" }, video, image];
    manager.appendCustomMessageEntry("recording", content, true);
    const header = manager.getHeader();
    if (!header) {
      throw new Error("expected session header");
    }

    const restored = SessionManager.fromEntries([header, ...manager.getEntries()]);

    expect(restored.buildSessionContext().messages).toEqual([
      expect.objectContaining({ role: "custom", customType: "recording", content }),
    ]);
  });

  it("blocks image attachments without discarding native video", async () => {
    const settingsManager = SettingsManager.inMemory({ images: { blockImages: true } });
    const { session } = await createNativeMediaSession({ settingsManager });

    const converted = await session.agent.convertToLlm([
      {
        role: "user",
        content: [{ type: "text", text: "mixed" }, image, video],
        timestamp: 1,
      },
    ]);

    expect(converted).toEqual([
      expect.objectContaining({
        role: "user",
        content: [
          { type: "text", text: "mixed" },
          { type: "text", text: "Image reading is disabled." },
          video,
        ],
      }),
    ]);
    session.dispose();
  });
});
