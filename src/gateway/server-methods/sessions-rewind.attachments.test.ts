import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_ATTACHMENT_MAX_ITEMS } from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";

const mocks = vi.hoisted(() => ({ readMediaBuffer: vi.fn() }));

vi.mock("../../media/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../media/store.js")>();
  return { ...actual, readMediaBuffer: mocks.readMediaBuffer };
});

import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  preflightSessionMessageCut,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { restoreSessionEditorAttachments } from "./session-editor-attachments.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const agentId = "main";
const sessionId = "rewind-attachment-boundary-source";
const sessionKey = "agent:main:rewind-attachment-boundary";

beforeEach(async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-rewind-attachment-boundary-"));
  mocks.readMediaBuffer.mockReset();
  await upsertSessionEntry({ agentId, sessionKey }, { sessionId, updatedAt: Date.now() });
  await appendTranscriptEvent(
    { agentId, sessionId, sessionKey },
    { type: "session", id: sessionId, version: 3 },
  );
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

async function appendMappedImageMessage(params: {
  entryId: string;
  images: readonly { data: string; mimeType: string }[];
  media: readonly Record<string, unknown>[];
  mediaBlockFactIndexes: readonly number[];
}) {
  await appendTranscriptMessage(
    { agentId, sessionId, sessionKey },
    {
      eventId: params.entryId,
      parentId: null,
      message: {
        role: "user",
        content: [
          { type: "text", text: "edit these images" },
          ...params.images.map((image) => ({ type: "image", ...image })),
        ],
        __openclaw: {
          media: params.media,
          mediaBlockFactIndexes: params.mediaBlockFactIndexes,
        },
      },
    },
  );
}

describe("rewind and fork attachment preflight", () => {
  it("restores a mapped inline image plus one distinct stored image", async () => {
    const inline = { mimeType: "image/png", data: "aW1hZ2U=" };
    const storedId = "stored-image.png";
    const stored = Buffer.from("stored-image");
    mocks.readMediaBuffer.mockResolvedValue({
      id: storedId,
      path: `/state/media/inbound/${storedId}`,
      buffer: stored,
      size: stored.byteLength,
    });
    await appendMappedImageMessage({
      entryId: "mapped-inline-with-stored-image",
      images: [inline],
      mediaBlockFactIndexes: [0],
      media: [
        {
          sourceId: "inline-image.png",
          sourceIndex: 0,
          url: "media://inbound/inline-image.png",
          contentType: "image/png",
        },
        { path: `/state/media/inbound/${storedId}`, contentType: "image/png" },
        {
          sourceId: storedId,
          url: `media://inbound/${storedId}`,
          contentType: "image/png",
        },
      ],
    });

    const preflight = await preflightSessionMessageCut({
      agentId,
      entryId: "mapped-inline-with-stored-image",
      sessionKey,
    });
    expect(preflight.status).toBe("ready");
    if (preflight.status !== "ready") {
      throw new Error("expected message-cut preflight");
    }
    expect(preflight.editorMediaRefs).toHaveLength(2);

    const restored = await restoreSessionEditorAttachments(preflight);

    expect(restored).toEqual({
      status: "ready",
      attachments: [inline, { mimeType: "image/png", data: stored.toString("base64") }],
    });
    expect(mocks.readMediaBuffer).toHaveBeenCalledOnce();
  });

  it("accepts the inline item limit without reading mapped durable refs", async () => {
    const images = Array.from({ length: CHAT_ATTACHMENT_MAX_ITEMS }, (_, index) => ({
      mimeType: "image/png",
      data: Buffer.from(`inline-image-${index}`).toString("base64"),
    }));
    const media = images.map((_, index) => ({
      sourceId: `inline-image-${index}.png`,
      sourceIndex: index,
      url: `media://inbound/inline-image-${index}.png`,
      contentType: "image/png",
    }));
    await appendMappedImageMessage({
      entryId: "mapped-inline-images-at-limit",
      images,
      media,
      mediaBlockFactIndexes: media.map((_, index) => index),
    });

    const preflight = await preflightSessionMessageCut({
      agentId,
      entryId: "mapped-inline-images-at-limit",
      sessionKey,
    });
    expect(preflight.status).toBe("ready");
    if (preflight.status !== "ready") {
      throw new Error("expected message-cut preflight");
    }

    await expect(restoreSessionEditorAttachments(preflight)).resolves.toEqual({
      status: "ready",
      attachments: images,
    });
    expect(mocks.readMediaBuffer).not.toHaveBeenCalled();
  });
});
