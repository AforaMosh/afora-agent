import { describe, expect, it } from "vitest";
import { createNoisyPngBuffer } from "../../test/helpers/image-fixtures.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";
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

  it("projects provider-wrapped inline video to valid bounded history blocks", () => {
    const payload = "private-provider-wrapped-video";
    const dataUrl = `data:video/mp4;base64,${payload}`;
    const wrapped = [
      { type: "input_video", video_url: dataUrl },
      { type: "image_url", image_url: { url: dataUrl } },
      { type: "video_url", video_url: { url: { url: dataUrl } } },
      {
        type: "image",
        contentType: "video/mp4",
        source: { type: "base64", data: payload },
      },
      ...["mimeType", "mime_type", "mediaType", "media_type", "contentType", "content_type"].map(
        (mimeField, index) => ({
          type: "image",
          [mimeField]: " VIDEO/MP4 ",
          [index % 2 === 0 ? "data" : "blob"]: payload,
        }),
      ),
    ];

    const projected = projectChatDisplayMessages([{ role: "assistant", content: wrapped }]);

    expect(projected).toEqual([
      {
        role: "assistant",
        content: wrapped.map(() => ({ type: "text", text: "[video data omitted]" })),
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain(payload);
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(1_024);
  });

  it("preserves remote provider video wrappers and safe metadata", () => {
    const content = [
      {
        type: "input_video",
        video_url: "https://example.test/video.mp4",
        label: "keep",
      },
      {
        type: "video_url",
        video_url: { url: { url: "https://example.test/nested.mp4" } },
        label: "keep nested",
      },
    ];

    expect(projectChatDisplayMessages([{ role: "assistant", content }])).toEqual([
      { role: "assistant", content },
    ]);
  });

  it("sanitizes provider media wrapper references in WebSocket and SSE history", () => {
    const privateReference = (name: string) =>
      ["https://user", `:password@cdn.example.test/media/${name}?token=private#preview`].join("");
    const nonMediaReference = [
      "https://metadata",
      ":password@events.example.test/source?id=keep-private#keep-private",
    ].join("");
    const rawBase64Payload = "private-provider-base64-payload";
    const safeWrapper = {
      type: "input_image",
      image_url: {
        url: "media://inbound/safe-image.png",
        metadata: { caption: "keep safe wrapper metadata" },
      },
      source: "/api/chat/media/outgoing/safe-image.png",
      label: "keep safe wrapper",
    };
    const message = {
      role: "assistant",
      content: [
        {
          type: "input_video",
          video_url: privateReference("input.mp4"),
          label: "keep input video metadata",
        },
        {
          type: "image_url",
          image_url: {
            url: privateReference("image.png"),
            metadata: { caption: "keep image metadata" },
          },
        },
        {
          type: "audio_url",
          audio_url: {
            source: privateReference("audio.wav"),
            codec: "opus",
          },
        },
        {
          type: "video_url",
          video_url: {
            url: {
              url: privateReference("nested.mp4"),
              label: "keep nested metadata",
            },
          },
        },
        {
          type: "base64",
          media_type: "image/png",
          data: rawBase64Payload,
          label: "private inline wrapper",
        },
        {
          type: "document",
          source: {
            url: "file:///Users/operator/private.pdf",
            path: "~/private.pdf",
            filePath: String.raw`C:\Users\operator\private.pdf`,
            localPath: "/Users/operator/private.pdf",
            video_url: [
              "file:///Users/operator/private-array.pdf",
              "/Users/operator/private-array.pdf",
              "managed/relative-document.pdf",
            ],
          },
          title: "keep document metadata",
        },
        safeWrapper,
        {
          type: "custom_metadata",
          source: nonMediaReference,
          label: "keep non-media source",
        },
      ],
    };
    const expectedContent = [
      {
        type: "input_video",
        video_url: "https://cdn.example.test/media/input.mp4",
        label: "keep input video metadata",
      },
      {
        type: "image_url",
        image_url: {
          url: "https://cdn.example.test/media/image.png",
          metadata: { caption: "keep image metadata" },
        },
      },
      {
        type: "audio_url",
        audio_url: {
          source: "https://cdn.example.test/media/audio.wav",
          codec: "opus",
        },
      },
      {
        type: "video_url",
        video_url: {
          url: {
            url: "https://cdn.example.test/media/nested.mp4",
            label: "keep nested metadata",
          },
        },
      },
      { type: "base64", omitted: true },
      {
        type: "document",
        source: { video_url: ["managed/relative-document.pdf"] },
        title: "keep document metadata",
      },
      safeWrapper,
      {
        type: "custom_metadata",
        source: nonMediaReference,
        label: "keep non-media source",
      },
    ];

    for (const messages of projectHistoryTransports(message)) {
      expect(messages).toEqual([{ role: "assistant", content: expectedContent }]);
      const serialized = JSON.stringify(messages);
      expect(serialized).not.toContain("user:password");
      expect(serialized).not.toContain("token=private");
      expect(serialized).not.toContain("#preview");
      expect(serialized).not.toContain(rawBase64Payload);
      expect(serialized).not.toContain("/Users/operator");
      expect(serialized).toContain(nonMediaReference);
    }
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

  it.each([
    { name: "array", createData: () => Array.from({ length: 16_384 }, (_, index) => index % 256) },
    { name: "object", createData: () => ({ payload: "private-top-level-payload".repeat(1024) }) },
    { name: "typed-array-like", createData: () => ({ 0: 137, 1: 137, length: 16_384 }) },
  ])("removes non-string top-level $name data without inventing bytes", ({ createData }) => {
    const source = { type: "url", url: "https://cdn.example.test/media.bin" };
    const projected = projectChatDisplayMessages([
      { role: "user", content: [{ type: "video", data: createData(), source }] },
    ]);

    expect(projected).toEqual([
      { role: "user", content: [{ type: "video", source, omitted: true }] },
    ]);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('"data"');
    expect(serialized).not.toContain('"bytes"');
    expect(serialized).not.toContain("private-top-level-payload");
    expect(Buffer.byteLength(serialized)).toBeLessThan(512);
  });

  it("derives bytes from a string source when top-level data is non-string", () => {
    const sourceData = Buffer.from("nested-source-payload").toString("base64");
    const projected = projectChatDisplayMessages([
      {
        role: "user",
        content: [
          {
            type: "image",
            data: { payload: "private-top-level-payload" },
            source: { type: "base64", data: sourceData },
          },
        ],
      },
    ]);

    expect(projected).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64" },
            omitted: true,
            bytes: Buffer.from(sourceData, "base64").length,
          },
        ],
      },
    ]);
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
