import { describe, expect, it } from "vitest";
import { serializeConversation } from "../runtime/index.js";
import { projectSessionCompactionMedia } from "./compaction-media-projection.js";
import type { SessionEntry } from "./session-manager.js";

function readUserContent(entry: SessionEntry | undefined) {
  if (entry?.type !== "message" || entry.message.role !== "user") {
    throw new Error("expected user message entry");
  }
  return entry.message.content;
}

describe("projectSessionCompactionMedia", () => {
  it("makes a facts-only video turn visible without projecting its reference", () => {
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "video-turn",
        parentId: null,
        timestamp: "2026-08-08T00:00:00.000Z",
        message: {
          role: "user",
          content: "",
          timestamp: 1,
          __openclaw: {
            media: [
              {
                kind: "video",
                contentType: "video/mp4",
                path: "/private/media/clip.mp4",
                sizeBytes: 6 * 1024 * 1024,
              },
            ],
          },
        },
      },
    ] as unknown as SessionEntry[];

    const projected = projectSessionCompactionMedia(entries);

    expect(projected).not.toBe(entries);
    expect(readUserContent(projected[0])).toBe("[video attachment retained by reference: 1]");
    expect(
      serializeConversation([
        (projected[0] as Extract<SessionEntry, { type: "message" }>).message,
      ] as Parameters<typeof serializeConversation>[0]),
    ).toBe("[User]: [video attachment retained by reference: 1]");
    expect(JSON.stringify(readUserContent(projected[0]))).not.toContain("/private/media/clip.mp4");
    expect(readUserContent(entries[0])).toBe("");
  });

  it("does not duplicate a marker when the user turn already has visible text", () => {
    const entries = [
      {
        type: "message",
        id: "captioned-video-turn",
        parentId: null,
        timestamp: "2026-08-08T00:00:00.000Z",
        message: {
          role: "user",
          content: "watch this clip",
          timestamp: 1,
          __openclaw: { media: [{ kind: "video", path: "/private/media/clip.mp4" }] },
        },
      },
    ] as unknown as SessionEntry[];

    expect(projectSessionCompactionMedia(entries)).toBe(entries);
  });
});
