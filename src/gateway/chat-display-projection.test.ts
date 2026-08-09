import { describe, expect, it, vi } from "vitest";
import { createNoisyPngBuffer } from "../../test/helpers/image-fixtures.js";
import {
  projectChatDisplayMessages,
  sanitizeChatHistoryMessages,
} from "./chat-display-projection.js";
import { mirrorMessageToolVisibleReplies } from "./chat-display-projection.message-tool.js";
import {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  replaceOversizedChatHistoryMessages,
} from "./server-methods/chat-history-budget.js";
import { buildSessionHistorySnapshot, SessionHistorySseState } from "./session-history-state.js";

function projectHistoryTransports(message: Record<string, unknown>) {
  const websocket = replaceOversizedChatHistoryMessages({
    messages: projectChatDisplayMessages([message]),
    maxSingleMessageBytes: CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  }).messages;
  const sse = buildSessionHistorySnapshot({ rawMessages: [message], limit: 5 }).history.messages;
  return [websocket, sse];
}

describe("oversized multimodal chat history", () => {
  it.each([
    {
      name: "native image data",
      image: (data: string) => ({ type: "image", mimeType: "image/png", data }),
    },
    {
      name: "Anthropic image source",
      image: (data: string) => ({
        type: "image",
        source: { type: "base64", media_type: "image/png", data },
      }),
    },
    {
      name: "native video data",
      image: (data: string) => ({ type: "video", mimeType: "video/mp4", data }),
    },
    {
      name: "nested base64 video source",
      image: (data: string) => ({
        type: "video",
        source: { type: "base64", media_type: "video/mp4", data },
      }),
    },
  ])("keeps text while omitting $name from WebSocket and SSE history", ({ image }) => {
    const payload = createNoisyPngBuffer(320, 320);
    const encoded = payload.toString("base64");
    const media = image(encoded);
    const message = {
      role: "user",
      content: [
        { type: "text", text: "keep prefix text" },
        media,
        { type: "text", text: "keep suffix text" },
      ],
    };
    for (const messages of projectHistoryTransports(message)) {
      expect(messages).toMatchObject([
        {
          role: "user",
          content: [
            { type: "text", text: "keep prefix text" },
            { type: media.type, omitted: true, bytes: payload.length },
            { type: "text", text: "keep suffix text" },
          ],
        },
      ]);
      expect(JSON.stringify(messages)).not.toContain(encoded);
      expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThan(
        CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
      );
    }
  });

  it.each(["image", "video"])("preserves URL-backed %ss without changing their sources", (type) => {
    const source = { type: "url", url: `https://example.invalid/media.${type}` };
    expect(projectChatDisplayMessages([{ role: "user", content: [{ type, source }] }])).toEqual([
      { role: "user", content: [{ type, source }] },
    ]);
  });

  it("omits persisted top-level audio data from WebSocket and SSE history", () => {
    const audio = Buffer.from("persisted audio bytes");
    const encoded = audio.toString("base64");
    const message = {
      role: "user",
      content: [
        { type: "text", text: "keep prefix text" },
        { type: "audio", mimeType: "audio/wav", data: encoded },
        { type: "text", text: "keep suffix text" },
      ],
    };

    for (const messages of projectHistoryTransports(message)) {
      expect(messages).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: "keep prefix text" },
            { type: "audio", mimeType: "audio/wav", omitted: true, bytes: audio.length },
            { type: "text", text: "keep suffix text" },
          ],
        },
      ]);
      expect(JSON.stringify(messages)).not.toContain(encoded);
    }
  });

  it("removes private audio payloads and local references while preserving safe refs", () => {
    const privateMarker = "private-audio-reference";
    const safeAudio = [
      {
        type: "audio",
        url: "https://example.invalid/audio.wav",
        openUrl: "http://example.invalid/audio.wav",
        audio_url: "media://inbound/audio.wav",
        source: { type: "url", url: "/api/chat/media/outgoing/audio.wav" },
      },
      { type: "audio", url: "/media/audio.wav", openUrl: "/__openclaw__/audio/clip.wav" },
    ];
    const message = {
      role: "user",
      content: [
        {
          type: "audio",
          data: { rawSecret: privateMarker },
          url: `data:audio/wav;base64,${privateMarker}`,
          openUrl: `file:///tmp/${privateMarker}.wav`,
          audio_url: `~/${privateMarker}.wav`,
          path: `/tmp/${privateMarker}.wav`,
          file: privateMarker,
          filePath: String.raw`C:\private-audio-reference.wav`,
          localPath: String.raw`\\server\share\private-audio-reference.wav`,
          source: {
            type: "opaque",
            codec: "pcm",
            data: new Uint8Array([111, 112, 113]),
            url: `/tmp/${privateMarker}-source.wav`,
            path: `/tmp/${privateMarker}-source.wav`,
            file: privateMarker,
            filePath: String.raw`D:\private-audio-reference.wav`,
            localPath: String.raw`\\server\share\private-audio-reference-source.wav`,
          },
        },
        { type: "audio", url: String.raw`C:\a.wav`, source: { url: String.raw`\\s\a.wav` } },
        ...safeAudio,
      ],
    };
    const original = structuredClone(message);

    for (const messages of projectHistoryTransports(message)) {
      expect(messages).toEqual([
        {
          role: "user",
          content: [
            {
              type: "audio",
              omitted: true,
              source: { type: "opaque", codec: "pcm", omitted: true },
            },
            { type: "audio", omitted: true, source: { omitted: true } },
            ...safeAudio,
          ],
        },
      ]);
      expect(JSON.stringify(messages)).not.toContain(privateMarker);
      expect(JSON.stringify(messages)).not.toContain('"0":111');
    }
    expect(message).toEqual(original);
  });

  it("sanitizes newly appended audio before returning an incremental SSE message", () => {
    const encoded = Buffer.from("incremental SSE audio").toString("base64");
    const state = SessionHistorySseState.fromRawSnapshot({
      target: { sessionId: "audio-session", sessionKey: "agent:main:audio-session" },
      rawMessages: [],
    });

    const appended = state.appendInlineMessage({
      message: {
        role: "user",
        content: [
          { type: "text", text: "keep incremental text" },
          { type: "audio", mimeType: "audio/ogg", data: encoded },
        ],
      },
      messageId: "audio-message",
    });

    expect(appended?.message).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "keep incremental text" },
        {
          type: "audio",
          mimeType: "audio/ogg",
          omitted: true,
          bytes: Buffer.from("incremental SSE audio").length,
        },
      ],
    });
    expect(JSON.stringify(appended?.message)).not.toContain(encoded);
  });

  it.each([
    {
      mediaType: "image",
      source: { type: "url", url: "https://example.invalid/image.png" },
    },
    { mediaType: "video", source: { type: "unknown" } },
    {
      mediaType: "image",
      source: {
        type: "custom",
        url: "media://inbound/image---00000000-0000-4000-8000-000000000000.png",
        path: "/Users/operator/private.png",
      },
    },
  ])("omits inline data from $source.type $mediaType sources", ({ mediaType, source }) => {
    const payload = Buffer.from(`private-${source.type}-${mediaType}`);
    const encoded = payload.toString("base64");
    const projected = projectChatDisplayMessages([
      { role: "user", content: [{ type: mediaType, source: { ...source, data: encoded } }] },
    ]);
    const expectedSource: Record<string, unknown> = { ...source };
    delete expectedSource.path;

    expect(projected).toEqual([
      {
        role: "user",
        content: [
          {
            type: mediaType,
            source: expectedSource,
            omitted: true,
            bytes: payload.length,
          },
        ],
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain(encoded);
    expect(JSON.stringify(projected)).not.toContain("/Users/operator");
  });

  it.each([
    {
      name: "number array",
      mediaType: "image",
      createData: () => Array.from({ length: 16_384 }, (_, index) => index % 256),
    },
    {
      name: "structured object",
      mediaType: "video",
      createData: () => ({ payload: "private-structured-payload".repeat(1024) }),
    },
    {
      name: "Uint8Array",
      mediaType: "image",
      createData: () => new Uint8Array(16_384).fill(137),
    },
    {
      name: "Buffer-like JSON",
      mediaType: "video",
      createData: () => Buffer.alloc(16_384, 137).toJSON(),
    },
  ])("removes non-string $name source data", ({ mediaType, createData }) => {
    const url = "https://cdn.example.test/media.bin";
    const projected = projectChatDisplayMessages([
      {
        role: "user",
        content: [
          {
            type: mediaType,
            source: { type: "custom", url, data: createData() },
          },
        ],
      },
    ]);

    expect(projected).toEqual([
      {
        role: "user",
        content: [
          {
            type: mediaType,
            source: { type: "custom", url },
            omitted: true,
          },
        ],
      },
    ]);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('"data"');
    expect(serialized).not.toContain('"payload"');
    expect(serialized).not.toContain("private-structured-payload");
    expect(Buffer.byteLength(serialized)).toBeLessThan(512);
  });

  it("uses top-level media data for bytes while removing every inline carrier", () => {
    const topLevelData = Buffer.from("authoritative-top-level-payload").toString("base64");
    const sourceData = Buffer.from("different-nested-source-payload-with-more-bytes").toString(
      "base64",
    );
    const projected = projectChatDisplayMessages([
      {
        role: "user",
        content: [
          {
            type: "video",
            data: topLevelData,
            source: {
              type: "url",
              url: "media://inbound/clip---00000000-0000-4000-8000-000000000000.mp4",
              data: sourceData,
            },
          },
        ],
      },
    ]);

    expect(projected).toEqual([
      {
        role: "user",
        content: [
          {
            type: "video",
            source: {
              type: "url",
              url: "media://inbound/clip---00000000-0000-4000-8000-000000000000.mp4",
            },
            omitted: true,
            bytes: Buffer.from(topLevelData, "base64").length,
          },
        ],
      },
    ]);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain(topLevelData);
    expect(serialized).not.toContain(sourceData);
  });
});

describe("private transcript metadata projection", () => {
  it("hides inline media data URLs and absolute storage paths", () => {
    const message = {
      role: "user",
      content: [
        {
          type: "video",
          path: "/Users/operator/.openclaw/media/inbound/clip.mp4",
          url: "file:///Users/operator/.openclaw/media/inbound/clip.mp4",
          source: "/Users/operator/.openclaw/media/inbound/clip.mp4",
        },
        {
          type: "image",
          source: {
            type: "url",
            url: "https://user" + ":password@cdn.example.test/image.png?signature=private",
          },
        },
      ],
    };

    const projected = projectChatDisplayMessages([message]);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("/Users/operator");
    expect(serialized).not.toContain("file:");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("signature");
    expect(serialized).toContain("https://cdn.example.test/image.png");
  });

  it("hides absolute media storage paths while preserving opaque managed references", () => {
    const message = {
      role: "user",
      content: "Inspect this clip.",
      __openclaw: {
        media: [
          {
            path: "/Users/operator/.openclaw/media/inbound/clip.mp4",
            url: "media://inbound/clip---00000000-0000-4000-8000-000000000000.mp4",
            contentType: "video/mp4",
            workspaceDir: "/Users/operator/.openclaw/workspace",
          },
          { path: "C:\\Users\\operator\\clip.mp4", contentType: "video/mp4" },
          {
            url: "https://user" + ":password@cdn.example.test/clip.mp4?signature=private#preview",
            contentType: "video/mp4",
          },
        ],
      },
    };

    const projected = projectChatDisplayMessages([message]);
    const serialized = JSON.stringify(projected);

    expect(projected).toEqual([
      {
        role: "user",
        content: "Inspect this clip.",
        __openclaw: {
          media: [
            {
              url: "media://inbound/clip---00000000-0000-4000-8000-000000000000.mp4",
              contentType: "video/mp4",
            },
            { contentType: "video/mp4" },
            { url: "https://cdn.example.test/clip.mp4", contentType: "video/mp4" },
          ],
        },
      },
    ]);
    expect(serialized).not.toContain("/Users/operator");
    expect(serialized).not.toContain("C:\\\\Users");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("signature");
  });

  it("removes inline data references from hostile persisted media facts", () => {
    const inlinePayload = "cHJpdmF0ZS1oaXN0b3J5LW1lZGlh";
    const projected = projectChatDisplayMessages([
      {
        role: "user",
        content: "Inspect legacy media.",
        media: [
          {
            sourceIndex: 3,
            url: `data:video/mp4;base64,${inlinePayload}`,
            contentType: "video/mp4",
          },
          {
            sourceIndex: 4,
            path: `data:image/png;base64,${inlinePayload}`,
            url: "media://inbound/top-level-managed.png",
            contentType: "image/png",
          },
        ],
        MediaPath: `data:image/png;base64,${inlinePayload}`,
        MediaUrl: `DATA:video/mp4;base64,${inlinePayload}`,
        MediaPaths: [
          "/tmp/local.png",
          `data:image/png;base64,${inlinePayload}`,
          "",
          "relative.png",
        ],
        MediaUrls: [
          `data:video/mp4;base64,${inlinePayload}`,
          "https://user" + ":password@cdn.example.test/legacy.mp4?signature=private",
        ],
        MediaTypes: ["image/png"],
        __openclaw: {
          media: [
            {
              sourceIndex: 0,
              url: `data:video/mp4;base64,${inlinePayload}`,
              contentType: "video/mp4",
            },
            {
              sourceIndex: 1,
              path: `DATA:image/png;base64,${inlinePayload}`,
              contentType: "image/png",
            },
            {
              sourceIndex: 2,
              path: `data:video/mp4;base64,${inlinePayload}`,
              url: "media://inbound/managed.mp4",
              contentType: "video/mp4",
            },
          ],
        },
      },
    ]);

    expect(projected).toEqual([
      {
        role: "user",
        content: "Inspect legacy media.",
        media: [
          { sourceIndex: 3, contentType: "video/mp4" },
          {
            sourceIndex: 4,
            url: "media://inbound/top-level-managed.png",
            contentType: "image/png",
          },
        ],
        MediaPaths: ["", "", "", "relative.png"],
        MediaUrls: ["", "https://cdn.example.test/legacy.mp4"],
        MediaTypes: ["image/png"],
        __openclaw: {
          media: [
            { sourceIndex: 0, contentType: "video/mp4" },
            { sourceIndex: 1, contentType: "image/png" },
            {
              sourceIndex: 2,
              url: "media://inbound/managed.mp4",
              contentType: "video/mp4",
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain("data:");
    expect(JSON.stringify(projected)).not.toContain(inlinePayload);
    expect(JSON.stringify(projected)).not.toContain("password");
    expect(JSON.stringify(projected)).not.toContain("signature");
  });

  it.each(
    ["MediaPath", "MediaUrl"].flatMap((key) => [
      { key, kind: "POSIX", value: "/Users/operator/.openclaw/media/inbound/clip.mp4" },
      { key, kind: "Windows", value: "C:\\Users\\operator\\clip.mp4" },
      { key, kind: "file URI", value: "file:///Users/operator/clip.mp4" },
    ]),
  )("drops $kind storage paths from legacy scalar $key", ({ key, value }) => {
    const [projected] = projectChatDisplayMessages([
      { role: "user", content: "Inspect legacy media.", [key]: value },
    ]);

    expect(projected).not.toHaveProperty(key);
    expect(JSON.stringify(projected)).not.toContain(value);
  });

  it("sanitizes legacy parallel media arrays without changing their positions", () => {
    const projected = projectChatDisplayMessages([
      {
        role: "user",
        content: "Inspect legacy media.",
        MediaPaths: [
          "/Users/operator/.openclaw/media/inbound/clip.mp4",
          "C:\\Users\\operator\\clip.mp4",
          "file:///Users/operator/clip.mp4",
          "relative/preview.png",
          "media://inbound/clip---00000000-0000-4000-8000-000000000000.mp4",
        ],
        MediaUrls: [
          "https://user" + ":password@cdn.example.test/clip.mp4?signature=private#preview",
          "/var/lib/openclaw/media/clip.mp4",
          "file:///var/lib/openclaw/media/clip.mp4",
          "relative/preview.png",
          "media://inbound/clip---00000000-0000-4000-8000-000000000000.mp4",
        ],
        MediaTypes: ["video/mp4", "video/mp4", "video/mp4", "image/png", "video/mp4"],
      },
    ]);

    expect(projected).toEqual([
      {
        role: "user",
        content: "Inspect legacy media.",
        MediaPaths: [
          "",
          "",
          "",
          "relative/preview.png",
          "media://inbound/clip---00000000-0000-4000-8000-000000000000.mp4",
        ],
        MediaUrls: [
          "https://cdn.example.test/clip.mp4",
          "",
          "",
          "relative/preview.png",
          "media://inbound/clip---00000000-0000-4000-8000-000000000000.mp4",
        ],
        MediaTypes: ["video/mp4", "video/mp4", "video/mp4", "image/png", "video/mp4"],
      },
    ]);
    expect(JSON.stringify(projected)).not.toMatch(
      /(?:Users[\\/]operator|var[\\/]lib[\\/]openclaw|file:|password|signature)/u,
    );
  });

  it("compacts rejected legacy array paths when no parallel carrier needs their positions", () => {
    expect(
      projectChatDisplayMessages([
        {
          role: "user",
          content: "Inspect legacy media.",
          MediaPaths: [
            "/Users/operator/clip.mp4",
            "relative/preview.png",
            "C:\\Users\\operator\\clip.mp4",
            "file:///Users/operator/clip.mp4",
            "media://inbound/clip---00000000-0000-4000-8000-000000000000.mp4",
          ],
        },
      ]),
    ).toEqual([
      {
        role: "user",
        content: "Inspect legacy media.",
        MediaPaths: [
          "relative/preview.png",
          "media://inbound/clip---00000000-0000-4000-8000-000000000000.mp4",
        ],
      },
    ]);
  });

  it("keeps visible text while omitting oversized upstream prompt metadata", () => {
    const message = {
      role: "user",
      content: "Keep this visible user message.",
      __openclaw: {
        id: "message-1",
        mirrorIdentity: "turn-1:prompt",
        upstreamUserText: "private decorated prompt ".repeat(12_000),
      },
    };
    for (const messages of projectHistoryTransports(message)) {
      expect(messages).toEqual([
        {
          role: "user",
          content: "Keep this visible user message.",
          __openclaw: {
            id: "message-1",
            mirrorIdentity: "turn-1:prompt",
          },
        },
      ]);
      expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThan(
        CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
      );
    }
  });
});

describe("current user profile display projection", () => {
  it("dedupes sender lookups per batch and enriches only resolved sender ids", () => {
    const messages = [
      {
        role: "user",
        content: "first",
        __openclaw: {
          senderId: "profile-ada",
          senderName: "Historical Ada",
          senderUsername: "ada",
        },
      },
      {
        role: "user",
        content: "second",
        __openclaw: { senderId: "profile-ada", senderName: "Earlier Ada" },
      },
      {
        role: "user",
        content: "third",
        __openclaw: { senderId: "profile-bob" },
      },
      {
        role: "user",
        content: "unknown",
        __openclaw: {
          senderId: "channel-sender",
          senderProfileAvatarUrl: "/channel/avatar",
        },
      },
      { role: "user", content: "missing sender" },
      {
        role: "assistant",
        content: [{ type: "text", text: "hostile assistant metadata" }],
        __openclaw: { senderId: "hostile-assistant" },
      },
      {
        role: "toolResult",
        toolCallId: "hostile-tool-call",
        toolName: "read",
        content: [{ type: "text", text: "hostile tool metadata" }],
        __openclaw: { senderId: "hostile-tool" },
      },
    ];
    const originalMessages = structuredClone(messages);
    const resolveCurrentUserProfileDisplay = vi.fn((senderId: string) => {
      if (senderId === "profile-ada") {
        return {
          kind: "resolved" as const,
          profileId: "profile-ada",
          label: "Current Ada",
          avatarUrl: "/api/users/profile-ada/avatar?v=20",
          hasUploadedAvatar: true,
        };
      }
      if (senderId === "profile-bob") {
        return {
          kind: "resolved" as const,
          profileId: "profile-bob",
          avatarUrl: "/api/users/profile-bob/avatar?v=30",
          hasUploadedAvatar: false,
        };
      }
      return { kind: "unresolved" as const };
    });

    const projected = projectChatDisplayMessages(messages, {
      resolveCurrentUserProfileDisplay,
    });

    expect(resolveCurrentUserProfileDisplay.mock.calls.map(([senderId]) => senderId)).toEqual([
      "profile-ada",
      "profile-bob",
      "channel-sender",
    ]);
    expect(projected.map((message) => message["__openclaw"])).toEqual([
      {
        senderId: "profile-ada",
        senderName: "Historical Ada",
        senderUsername: "ada",
        senderProfileAvatarUrl: "/api/users/profile-ada/avatar?v=20",
      },
      {
        senderId: "profile-ada",
        senderName: "Earlier Ada",
        senderProfileAvatarUrl: "/api/users/profile-ada/avatar?v=20",
      },
      {
        senderId: "profile-bob",
        senderProfileAvatarUrl: "/api/users/profile-bob/avatar?v=30",
      },
      {
        senderId: "channel-sender",
        senderProfileAvatarUrl: "/channel/avatar",
      },
      undefined,
      { senderId: "hostile-assistant" },
      { senderId: "hostile-tool" },
    ]);
    expect(messages).toEqual(originalMessages);
    expect(projected[0]).not.toBe(messages[0]);
    expect(projected[3]).toBe(messages[3]);
    expect(projected[4]).toBe(messages[4]);
    expect(projected[5]).toBe(messages[5]);
  });

  it("overwrites stale and no-upload profile routes while preserving lookup failures", () => {
    const staleAvatar = {
      role: "user",
      content: "stale avatar",
      __openclaw: {
        senderId: "with-avatar",
        senderName: "Historical Name",
        senderProfileAvatarUrl: "/api/users/with-avatar/avatar?v=10",
      },
    };
    const noUploadAvatar = {
      role: "user",
      content: "removed avatar",
      __openclaw: {
        senderId: "without-avatar",
        senderProfileAvatarUrl: "/api/users/without-avatar/avatar?v=10",
      },
    };
    const failedLookup = {
      role: "user",
      content: "lookup failed",
      __openclaw: {
        senderId: "lookup-failed",
        senderProfileAvatarUrl: "/existing/projected/avatar",
      },
    };
    const projected = projectChatDisplayMessages([staleAvatar, noUploadAvatar, failedLookup], {
      resolveCurrentUserProfileDisplay: (senderId) => {
        if (senderId === "with-avatar") {
          return {
            kind: "resolved",
            profileId: "with-avatar",
            label: "Current Name",
            avatarUrl: "/api/users/with-avatar/avatar?v=20",
            hasUploadedAvatar: true,
          };
        }
        if (senderId === "without-avatar") {
          return {
            kind: "resolved",
            profileId: "without-avatar",
            avatarUrl: "/api/users/without-avatar/avatar?v=20",
            hasUploadedAvatar: false,
          };
        }
        return { kind: "unresolved" };
      },
    });

    expect(projected[0]?.["__openclaw"]).toEqual({
      senderId: "with-avatar",
      senderName: "Historical Name",
      senderProfileAvatarUrl: "/api/users/with-avatar/avatar?v=20",
    });
    expect(projected[1]?.["__openclaw"]).toEqual({
      senderId: "without-avatar",
      senderProfileAvatarUrl: "/api/users/without-avatar/avatar?v=20",
    });
    expect(projected[2]).toBe(failedLookup);
  });

  it("keeps exact current behavior when no resolver is supplied", () => {
    const message = {
      role: "user",
      content: "unchanged",
      __openclaw: {
        senderId: "profile-ada",
        senderProfileAvatarUrl: "/api/users/profile-ada/avatar?v=old",
      },
    };
    const projected = projectChatDisplayMessages([message]);
    expect(projected[0]).toBe(message);
  });
});

describe("chat display message-tool projection", () => {
  it("mirrors an automatic-mode send confirmed for the current source", () => {
    const sourceReply = "Visible reply delivered to Slack.";
    const projected = mirrorMessageToolVisibleReplies([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-message-current-source",
            name: "message",
            arguments: {
              action: "send",
              channel: "slack",
              target: "channel:C123",
              message: sourceReply,
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "message",
        toolCallId: "call-message-current-source",
        content: { ok: true, messageId: "slack-242" },
        details: {
          ok: true,
          messageId: "slack-242",
          sourceReplyRoute: "current-source",
        },
      },
      { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
    ]);

    expect(projected).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: sourceReply }],
        openclawMessageToolMirror: expect.objectContaining({
          toolCallId: "call-message-current-source",
        }),
      }),
    );
  });
});

describe("chat display tool-result detail projection", () => {
  it("omits opaque provider replay state from display history", () => {
    const [message] = sanitizeChatHistoryMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "visible" }],
        providerReplay: {
          type: "openai-responses-compaction",
          data: "opaque-display-compaction",
        },
      },
    ]) as Array<Record<string, unknown>>;

    expect(message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "visible" }],
    });
    expect(message).not.toHaveProperty("providerReplay");
    expect(JSON.stringify(message)).not.toContain("opaque-display-compaction");
  });

  it("keeps authoritative write booleans and strips unrelated details", () => {
    const [overwrite, created, invalid] = sanitizeChatHistoryMessages([
      {
        role: "toolResult",
        toolCallId: "write-1",
        toolName: "write",
        content: [{ type: "text", text: "ok" }],
        details: { changed: true, created: false, diff: "-1 old\n+1 new", private: "drop" },
      },
      {
        role: "toolResult",
        toolCallId: "write-2",
        toolName: "write",
        content: [{ type: "text", text: "ok" }],
        details: { changed: true, created: true },
      },
      {
        role: "toolResult",
        toolCallId: "write-3",
        toolName: "write",
        content: [{ type: "text", text: "ok" }],
        details: { changed: "true", created: 1 },
      },
    ]) as Array<Record<string, unknown>>;

    expect(overwrite?.details).toEqual({
      changed: true,
      created: false,
      diff: "-1 old\n+1 new",
    });
    expect(created?.details).toEqual({ changed: true, created: true });
    expect(invalid).not.toHaveProperty("details");
  });
});
