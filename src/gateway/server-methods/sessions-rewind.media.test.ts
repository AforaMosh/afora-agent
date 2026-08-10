import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM,
  CHAT_ATTACHMENT_MAX_ITEMS,
  encodedBase64Length,
  ErrorCodes,
} from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveEmbeddedSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
import {
  clearSessionQueues,
  enqueueFollowupRun,
  getFollowupQueueDepth,
  type FollowupRun,
} from "../../auto-reply/reply/queue.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../../process/command-queue.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({
  preflightSessionMessageCut: vi.fn(),
  readMediaBuffer: vi.fn(),
}));

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/session-accessor.js")>();
  mocks.preflightSessionMessageCut.mockImplementation(actual.preflightSessionMessageCut);
  return { ...actual, preflightSessionMessageCut: mocks.preflightSessionMessageCut };
});

vi.mock("../../media/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../media/store.js")>();
  return { ...actual, readMediaBuffer: mocks.readMediaBuffer };
});

import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  listSessionEntries,
  loadSessionEntry,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { sessionRewindHandlers } from "./sessions-rewind.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:rewind-media-handler";
const sourceSessionId = "rewind-media-handler-source";
const sessionLane = resolveEmbeddedSessionLane(sessionKey);
const queuedCommandSettlements = new Set<Promise<void>>();

beforeEach(async () => {
  mocks.preflightSessionMessageCut.mockClear();
  mocks.readMediaBuffer.mockReset();
  setActivePluginRegistry(createEmptyPluginRegistry());
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-rewind-media-handler-"));
  await upsertSessionEntry(
    { agentId: "main", sessionKey },
    { sessionId: sourceSessionId, updatedAt: Date.now() },
  );
  const scope = { agentId: "main", sessionId: sourceSessionId, sessionKey };
  await appendTranscriptEvent(scope, { type: "session", id: sourceSessionId, version: 3 });
  await appendTranscriptMessage(scope, {
    eventId: "user-entry",
    parentId: null,
    message: { role: "user", content: "edit me" },
  });
  await appendTranscriptMessage(scope, {
    eventId: "assistant-entry",
    parentId: "user-entry",
    message: { role: "assistant", content: "answer" },
  });
  await appendTranscriptEvent(scope, {
    type: "leaf",
    id: "active-leaf",
    parentId: "user-entry",
    targetId: "assistant-entry",
  });
});

afterEach(async () => {
  clearSessionQueues([sessionKey, sourceSessionId]);
  setCommandLaneConcurrency(sessionLane, 1);
  await Promise.all(queuedCommandSettlements);
  queuedCommandSettlements.clear();
  resetPluginRuntimeStateForTest();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

async function invoke(method: "sessions.fork" | "sessions.rewind", entryId: string) {
  const respond = vi.fn();
  await expectDefined(
    sessionRewindHandlers[method],
    `${method} handler`,
  )({
    req: { id: `${method}-request` } as never,
    params: { sessionKey, entryId },
    respond: respond as unknown as RespondFn,
    context: {
      broadcastToConnIds: vi.fn(),
      chatAbortControllers: new Map(),
      getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
      getSessionEventSubscriberConnIds: () => new Set(),
    } as unknown as GatewayRequestContext,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

async function appendMediaMessage(params: {
  entryId: string;
  media: Record<string, unknown> | readonly Record<string, unknown>[];
  text?: string;
}): Promise<void> {
  const scope = { agentId: "main", sessionId: sourceSessionId, sessionKey };
  await appendTranscriptMessage(scope, {
    eventId: params.entryId,
    parentId: "assistant-entry",
    message: {
      role: "user",
      content: params.text ?? "edit this clip",
      __openclaw: { media: Array.isArray(params.media) ? params.media : [params.media] },
    },
  });
  await appendTranscriptEvent(scope, {
    type: "leaf",
    id: `${params.entryId}-leaf`,
    parentId: "assistant-entry",
    targetId: params.entryId,
  });
}

async function appendInlineImageMessage(params: {
  entryId: string;
  images: readonly { data: string; mimeType: string }[];
}): Promise<void> {
  const scope = { agentId: "main", sessionId: sourceSessionId, sessionKey };
  await appendTranscriptMessage(scope, {
    eventId: params.entryId,
    parentId: "assistant-entry",
    message: {
      role: "user",
      content: [
        { type: "text", text: "edit these images" },
        ...params.images.map((image) => ({ type: "image", ...image })),
      ],
    },
  });
  await appendTranscriptEvent(scope, {
    type: "leaf",
    id: `${params.entryId}-leaf`,
    parentId: "assistant-entry",
    targetId: params.entryId,
  });
}

type QueuedSessionWork = {
  command: Promise<string>;
  followup: FollowupRun;
  hasCommandRun: () => boolean;
};

function enqueueSessionWork(): QueuedSessionWork {
  const followupFixture = createQueueTestRun({ prompt: "expired rewind follow-up" });
  const followup: FollowupRun = {
    ...followupFixture,
    run: {
      ...followupFixture.run,
      agentId: "main",
      sessionId: sourceSessionId,
      sessionKey,
    },
  };
  expect(
    enqueueFollowupRun(sessionKey, followup, { mode: "followup" }, "none", undefined, false),
  ).toBe(true);

  setCommandLaneConcurrency(sessionLane, 0);
  let commandRan = false;
  const command = enqueueCommandInLane(sessionLane, async () => {
    commandRan = true;
    return "expired rewind command";
  });
  queuedCommandSettlements.add(
    command.then(
      () => undefined,
      () => undefined,
    ),
  );
  return { command, followup, hasCommandRun: () => commandRan };
}

function expectSessionWorkQueued(work: QueuedSessionWork): void {
  expect(getFollowupQueueDepth(sessionKey)).toBe(1);
  expect(work.followup.queueAbortSignal?.aborted).toBe(false);
  expect(getCommandLaneSnapshot(sessionLane)).toMatchObject({ activeCount: 0, queuedCount: 1 });
  expect(work.hasCommandRun()).toBe(false);
}

describe("session rewind and fork media", () => {
  it("restores a 6 MiB claim-check video before rewinding", async () => {
    const storedVideoId = "stored-video.mp4";
    const storedVideoData = Buffer.alloc(6 * 1024 * 1024, 1);
    mocks.readMediaBuffer.mockImplementation(async (id: string) => {
      if (id !== storedVideoId) {
        throw new Error(`missing media: ${id}`);
      }
      return {
        id,
        path: `/state/media/inbound/${id}`,
        buffer: storedVideoData,
        size: storedVideoData.byteLength,
      };
    });
    await appendMediaMessage({
      entryId: "video-entry",
      media: {
        sourceId: storedVideoId,
        sourceIndex: 0,
        path: `/state/media/inbound/${storedVideoId}`,
        url: `media://inbound/${storedVideoId}`,
        kind: "video",
        contentType: "video/mp4",
        sizeBytes: storedVideoData.byteLength,
      },
    });

    const rewind = await invoke("sessions.rewind", "video-entry");

    expect(rewind).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ editorText: "edit this clip" }),
      undefined,
    );
    const payload = rewind.mock.calls[0]?.[1] as
      | { editorAttachments?: Array<{ data: string; mimeType: string }> }
      | undefined;
    expect(payload?.editorAttachments).toHaveLength(1);
    expect(payload?.editorAttachments?.[0]).toMatchObject({ mimeType: "video/mp4" });
    expect(payload?.editorAttachments?.[0]?.data.length).toBe((6 * 1024 * 1024 * 4) / 3);
    expect(mocks.readMediaBuffer).toHaveBeenCalledWith(storedVideoId, "inbound", 8 * 1024 * 1024);
  });

  it("accepts an inline attachment at the exact decoded-size limit", async () => {
    const data = Buffer.alloc(CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM, 1).toString("base64");
    mocks.preflightSessionMessageCut.mockResolvedValueOnce({
      status: "ready",
      editorText: "edit max image",
      editorAttachments: [{ mimeType: "image/png", data }],
    });

    const respond = await invoke("sessions.rewind", "user-entry");

    expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    const payload = respond.mock.calls[0]?.[1] as
      | { editorAttachments?: Array<{ data: string; mimeType: string }> }
      | undefined;
    expect(payload?.editorAttachments).toHaveLength(1);
    expect(payload?.editorAttachments?.[0]?.mimeType).toBe("image/png");
    expect(payload?.editorAttachments?.[0]?.data.length).toBe(data.length);
    expect(loadSessionEntry({ agentId: "main", sessionKey })?.sessionId).not.toBe(sourceSessionId);
  });

  it("rejects inline attachment count overflow before rewind mutation", async () => {
    await appendInlineImageMessage({
      entryId: "too-many-inline-images",
      images: [
        ...Array.from({ length: CHAT_ATTACHMENT_MAX_ITEMS }, (_, index) => ({
          mimeType: "image/png",
          data: Buffer.from(`image-${index}`).toString("base64"),
        })),
        { mimeType: "image/png;invalid", data: "not-base64" },
        ...Array.from({ length: 20 }, () => ({ mimeType: "image/png", data: "ignored" })),
      ],
    });
    const sourceBefore = loadSessionEntry({ agentId: "main", sessionKey })?.sessionId;

    const respond = await invoke("sessions.rewind", "too-many-inline-images");

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("attachments exceed the editor limits"),
      }),
    );
    expect(loadSessionEntry({ agentId: "main", sessionKey })?.sessionId).toBe(sourceBefore);
  });

  it("rejects an oversized inline payload before creating a fork", async () => {
    await appendInlineImageMessage({
      entryId: "oversized-inline-image",
      images: [
        {
          mimeType: "image/png",
          data: "A".repeat(encodedBase64Length(CHAT_ATTACHMENT_MAX_DECODED_BYTES_PER_ITEM) + 1),
        },
      ],
    });
    const sourceBefore = loadSessionEntry({ agentId: "main", sessionKey })?.sessionId;
    const entryCountBefore = listSessionEntries({ agentId: "main" }).length;

    const respond = await invoke("sessions.fork", "oversized-inline-image");

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("unsafe or invalid attachment reference"),
      }),
    );
    expect(loadSessionEntry({ agentId: "main", sessionKey })?.sessionId).toBe(sourceBefore);
    expect(listSessionEntries({ agentId: "main" })).toHaveLength(entryCountBefore);
  });

  it("routes a bounded malformed inline attachment through validation without rewind mutation", async () => {
    await appendInlineImageMessage({
      entryId: "malformed-inline-image",
      images: [{ mimeType: "image/png;invalid", data: "not-base64" }],
    });
    const sourceBefore = loadSessionEntry({ agentId: "main", sessionKey })?.sessionId;

    const respond = await invoke("sessions.rewind", "malformed-inline-image");

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("unsafe or invalid attachment reference"),
      }),
    );
    expect(loadSessionEntry({ agentId: "main", sessionKey })?.sessionId).toBe(sourceBefore);
  });

  it.each(["sessions.rewind", "sessions.fork"] as const)(
    "omits a path-only legacy video and lets %s restore the text edit",
    async (method) => {
      await appendMediaMessage({
        entryId: "legacy-video-entry",
        media: {
          sourceId: "legacy-video.mp4",
          sourceIndex: 0,
          path: "/state/media/inbound/legacy-video.mp4",
          kind: "video",
          contentType: "video/mp4",
          sizeBytes: 1024,
        },
      });

      const respond = await invoke(method, "legacy-video-entry");

      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ editorText: "edit this clip" }),
        undefined,
      );
      const payload = respond.mock.calls[0]?.[1] as { editorAttachments?: unknown } | undefined;
      expect(payload).not.toHaveProperty("editorAttachments");
      expect(mocks.readMediaBuffer).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "mismatched source ID",
      fact: {
        sourceId: "different-video.mp4",
        sourceIndex: 0,
        url: "media://inbound/stored-video.mp4",
      },
    },
    {
      name: "malformed inbound URI",
      fact: {
        sourceId: "stored-video.mp4",
        sourceIndex: 0,
        url: "media://inbound/nested%2Fstored-video.mp4",
      },
    },
  ])("keeps the bounded omission when rewinding a $name video claim", async ({ fact }) => {
    const scope = { agentId: "main", sessionId: sourceSessionId, sessionKey };
    const entryId = `invalid-managed-video-${fact.sourceId}`;
    await appendTranscriptMessage(scope, {
      eventId: entryId,
      parentId: "assistant-entry",
      message: {
        role: "user",
        content: [
          { type: "text", text: "edit this clip: " },
          { type: "video", data: "cHJpdmF0ZQ==", mimeType: "video/mp4" },
        ],
        __openclaw: {
          media: [{ ...fact, kind: "video", contentType: "video/mp4" }],
          mediaBlockFactIndexes: [0],
        },
      },
    });
    await appendTranscriptEvent(scope, {
      type: "leaf",
      id: `${entryId}-leaf`,
      parentId: "assistant-entry",
      targetId: entryId,
    });

    const respond = await invoke("sessions.rewind", entryId);

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        editorText:
          "edit this clip: (video omitted: inline video is not retained in session history)",
      },
      undefined,
    );
    expect(mocks.readMediaBuffer).not.toHaveBeenCalled();
  });

  it.each(["sessions.rewind", "sessions.fork"] as const)(
    "filters non-restorable image facts before a text-only %s",
    async (method) => {
      await appendMediaMessage({
        entryId: "invalid-image-entry",
        text: "edit this text",
        media: [
          {
            sourceId: "remote-image.png",
            url: "https://cdn.example.test/remote-image.png",
            contentType: "image/png",
          },
          {
            sourceId: "outside-image.png",
            path: "/tmp/outside-image.png",
            contentType: "image/png",
          },
          { sourceId: "metadata-only.png", contentType: "image/png" },
          {
            sourceId: "other-image.png",
            url: "media://inbound/mismatched-image.png",
            contentType: "image/png",
          },
          {
            sourceId: "other-path-image.png",
            path: "/state/media/inbound/mismatched-path-image.png",
            contentType: "image/png",
          },
          {
            sourceId: "malformed-image.png",
            url: "media://inbound/nested%2Fmalformed-image.png",
            contentType: "image/png",
          },
        ],
      });

      const respond = await invoke(method, "invalid-image-entry");

      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ editorText: "edit this text" }),
        undefined,
      );
      const payload = respond.mock.calls[0]?.[1] as { editorAttachments?: unknown } | undefined;
      expect(payload).not.toHaveProperty("editorAttachments");
      expect(mocks.readMediaBuffer).not.toHaveBeenCalled();
    },
  );

  it("rejects a 20 MiB video before fork mutation or media read", async () => {
    const storedVideoId = "oversized-video.mp4";
    await appendMediaMessage({
      entryId: "oversized-video-entry",
      media: {
        sourceId: storedVideoId,
        sourceIndex: 0,
        path: `/state/media/inbound/${storedVideoId}`,
        url: `media://inbound/${storedVideoId}`,
        kind: "video",
        contentType: "video/mp4",
        sizeBytes: 20 * 1024 * 1024,
      },
    });
    const sourceBefore = loadSessionEntry({ agentId: "main", sessionKey })?.sessionId;
    const entryCountBefore = listSessionEntries({ agentId: "main" }).length;

    const respond = await invoke("sessions.fork", "oversized-video-entry");

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("attachments exceed the editor limits"),
      }),
    );
    expect(mocks.readMediaBuffer).not.toHaveBeenCalled();
    expect(loadSessionEntry({ agentId: "main", sessionKey })?.sessionId).toBe(sourceBefore);
    expect(listSessionEntries({ agentId: "main" })).toHaveLength(entryCountBefore);
  });

  it("rejects an expired video before rewind and preserves queued work", async () => {
    const storedVideoId = "expired-video.mp4";
    mocks.readMediaBuffer.mockRejectedValue(new Error("missing media"));
    await appendMediaMessage({
      entryId: "expired-video-entry",
      media: {
        sourceId: storedVideoId,
        sourceIndex: 0,
        path: `/state/media/inbound/${storedVideoId}`,
        url: `media://inbound/${storedVideoId}`,
        kind: "video",
        contentType: "video/mp4",
        sizeBytes: 6 * 1024 * 1024,
      },
    });
    const sourceBefore = loadSessionEntry({ agentId: "main", sessionKey })?.sessionId;
    const work = enqueueSessionWork();

    const respond = await invoke("sessions.rewind", "expired-video-entry");

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
        message: expect.stringContaining("attachment is missing or expired"),
      }),
    );
    expect(loadSessionEntry({ agentId: "main", sessionKey })?.sessionId).toBe(sourceBefore);
    expectSessionWorkQueued(work);
    setCommandLaneConcurrency(sessionLane, 1);
    await expect(work.command).resolves.toBe("expired rewind command");
  });

  it("rejects a missing video before creating a fork target", async () => {
    const storedVideoId = "missing-video.mp4";
    mocks.readMediaBuffer.mockRejectedValue(new Error("missing media"));
    await appendMediaMessage({
      entryId: "missing-video-entry",
      media: {
        sourceId: storedVideoId,
        sourceIndex: 0,
        path: `/state/media/inbound/${storedVideoId}`,
        url: `media://inbound/${storedVideoId}`,
        kind: "video",
        contentType: "video/mp4",
        sizeBytes: 1024,
      },
    });
    const sourceBefore = loadSessionEntry({ agentId: "main", sessionKey })?.sessionId;
    const entryCountBefore = listSessionEntries({ agentId: "main" }).length;

    const respond = await invoke("sessions.fork", "missing-video-entry");

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: ErrorCodes.UNAVAILABLE }),
    );
    expect(loadSessionEntry({ agentId: "main", sessionKey })?.sessionId).toBe(sourceBefore);
    expect(listSessionEntries({ agentId: "main" })).toHaveLength(entryCountBefore);
  });

  it("rejects an emitted managed video ref with invalid size metadata", async () => {
    const storedVideoId = "invalid-size-video.mp4";
    await appendMediaMessage({
      entryId: "invalid-size-video-entry",
      media: {
        sourceId: storedVideoId,
        sourceIndex: 0,
        path: `/state/media/inbound/${storedVideoId}`,
        url: `media://inbound/${storedVideoId}`,
        kind: "video",
        contentType: "video/mp4",
        sizeBytes: 0,
      },
    });
    const sourceBefore = loadSessionEntry({ agentId: "main", sessionKey })?.sessionId;

    const respond = await invoke("sessions.rewind", "invalid-size-video-entry");

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("unsafe or invalid attachment reference"),
      }),
    );
    expect(mocks.readMediaBuffer).not.toHaveBeenCalled();
    expect(loadSessionEntry({ agentId: "main", sessionKey })?.sessionId).toBe(sourceBefore);
  });

  it("rejects a manually emitted unsafe image ref before fork mutation", async () => {
    mocks.preflightSessionMessageCut.mockResolvedValueOnce({
      status: "ready",
      editorText: "edit me",
      editorMediaRefs: [
        {
          kind: "image",
          contentType: "image/png",
          url: "https://cdn.example.test/unsafe-image.png",
        },
      ],
    });
    const sourceBefore = loadSessionEntry({ agentId: "main", sessionKey })?.sessionId;
    const entryCountBefore = listSessionEntries({ agentId: "main" }).length;

    const respond = await invoke("sessions.fork", "user-entry");

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("unsafe or invalid attachment reference"),
      }),
    );
    expect(mocks.readMediaBuffer).not.toHaveBeenCalled();
    expect(loadSessionEntry({ agentId: "main", sessionKey })?.sessionId).toBe(sourceBefore);
    expect(listSessionEntries({ agentId: "main" })).toHaveLength(entryCountBefore);
  });
});
