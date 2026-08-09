import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  sanitizeDiagnosticPayload,
  sanitizeModelVisibleMediaPayload,
} from "./payload-redaction.js";

describe("sanitizeDiagnosticPayload", () => {
  const mediaData = "dmlkZW8tYnl0ZXM=";
  const mediaDigest = createHash("sha256").update(mediaData).digest("hex");

  it.each([
    { metadata: { type: "audio" }, field: "data" },
    { metadata: { type: "audio_url" }, field: "blob" },
    { metadata: { type: "base64" }, field: "data" },
    { metadata: { type: "image" }, field: "blob" },
    { metadata: { type: "image_url" }, field: "data" },
    { metadata: { type: "input_audio" }, field: "blob" },
    { metadata: { type: "input_image" }, field: "data" },
    { metadata: { type: "input_video" }, field: "blob" },
    { metadata: { type: "output_audio" }, field: "data" },
    { metadata: { type: "video" }, field: "blob" },
    { metadata: { type: "video_url" }, field: "data" },
    { metadata: { mimeType: "image/png" }, field: "data" },
    { metadata: { mime_type: "video/quicktime" }, field: "blob" },
    { metadata: { mediaType: "audio/mpeg" }, field: "data" },
    { metadata: { media_type: "application/pdf" }, field: "blob" },
    { metadata: { contentType: "video/mp4" }, field: "data" },
    { metadata: { content_type: "image/webp" }, field: "blob" },
  ] as const)(
    "redacts inline media fields while preserving metadata: %j",
    ({ metadata, field }) => {
      const redacted = sanitizeDiagnosticPayload({
        messages: [{ role: "user", content: [{ ...metadata, [field]: mediaData }] }],
      });

      expect(redacted).toEqual({
        messages: [
          {
            role: "user",
            content: [
              {
                ...metadata,
                [field]: "<redacted>",
                bytes: 11,
                sha256: mediaDigest,
              },
            ],
          },
        ],
      });
      expect(JSON.stringify(redacted)).not.toContain(mediaData);
    },
  );

  it("redacts nested media sources without dropping surrounding metadata", () => {
    const nestedAudio = Buffer.from("nested audio").toString("base64");
    const nestedImage = Buffer.from("nested image").toString("base64");
    const redacted = sanitizeDiagnosticPayload({
      type: "video",
      source: {
        type: "base64",
        media_type: "video/mp4",
        data: mediaData,
        alternatives: [
          { contentType: "audio/mpeg", blob: nestedAudio },
          { nested: { content_type: "image/png", data: nestedImage } },
        ],
      },
      durationSeconds: 12,
    });

    expect(redacted).toMatchObject({
      type: "video",
      source: {
        type: "base64",
        media_type: "video/mp4",
        data: "<redacted>",
        bytes: 11,
        sha256: mediaDigest,
        alternatives: [
          { contentType: "audio/mpeg", blob: "<redacted>" },
          { nested: { content_type: "image/png", data: "<redacted>" } },
        ],
      },
      durationSeconds: 12,
    });
    const serialized = JSON.stringify(redacted);
    for (const payload of [mediaData, nestedAudio, nestedImage]) {
      expect(serialized).not.toContain(payload);
      expect(serialized).not.toContain(payload.slice(0, 8));
      expect(serialized).not.toContain(payload.slice(-8));
    }
  });

  it.each([
    {
      block: {
        type: "video_url",
        video_url: { url: `data:video/mp4;base64,${mediaData}`, detail: "high" },
      },
      expected: {
        type: "video_url",
        video_url: {
          url: "<redacted>",
          detail: "high",
          mimeType: "video/mp4",
          bytes: 11,
          sha256: mediaDigest,
        },
      },
    },
    {
      block: { type: "input_video", video_url: `data:video/webm;base64,${mediaData}` },
      expected: {
        type: "input_video",
        video_url: "<redacted>",
        mimeType: "video/webm",
        bytes: 11,
        sha256: mediaDigest,
      },
    },
    {
      block: {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${mediaData}`, detail: "auto" },
      },
      expected: {
        type: "image_url",
        image_url: {
          url: "<redacted>",
          detail: "auto",
          mimeType: "image/png",
          bytes: 11,
          sha256: mediaDigest,
        },
      },
    },
    {
      block: { type: "input_image", image_url: `data:image/jpeg;base64,${mediaData}` },
      expected: {
        type: "input_image",
        image_url: "<redacted>",
        mimeType: "image/jpeg",
        bytes: 11,
        sha256: mediaDigest,
      },
    },
    {
      block: {
        type: "audio_url",
        audio_url: { url: `data:audio/mpeg;base64,${mediaData}`, format: "mp3" },
      },
      expected: {
        type: "audio_url",
        audio_url: {
          url: "<redacted>",
          format: "mp3",
          mimeType: "audio/mpeg",
          bytes: 11,
          sha256: mediaDigest,
        },
      },
    },
  ])("redacts provider wire data URLs without losing MIME metadata: %j", ({ block, expected }) => {
    const redacted = sanitizeDiagnosticPayload({ content: [block] });

    expect(redacted).toEqual({ content: [expected] });
    expect(JSON.stringify(redacted)).not.toContain(mediaData);
  });

  it("redacts media data URLs by URI while preserving remote and document URLs", () => {
    const payload = {
      content: [
        { type: "video_url", video_url: { url: "https://example.test/video.mp4" } },
        { type: "input_image", image_url: "https://example.test/image.png" },
        { type: "text", text: `data:video/mp4;base64,${mediaData}` },
        { type: "document", document_url: `data:application/pdf;base64,${mediaData}` },
        { type: "image_url", image_url: { url: `data:video/mp4;base64,${mediaData}` } },
      ],
    };

    expect(sanitizeDiagnosticPayload(payload)).toEqual({
      content: [
        payload.content[0],
        payload.content[1],
        { type: "text", text: "<redacted>" },
        payload.content[3],
        {
          type: "image_url",
          image_url: {
            url: "<redacted>",
            mimeType: "video/mp4",
            bytes: 11,
            sha256: mediaDigest,
          },
        },
      ],
    });
  });

  it.each(["audio/mpeg", "image/png", "video/mp4"])(
    "fully redacts folded %s data URLs in arbitrary diagnostic strings",
    (mimeType) => {
      const fragments = ["cHJpdmF0ZS", "1tZWRpYS1w", "YXlsb2Fk"];
      const sanitized = sanitizeDiagnosticPayload({
        detail: `captured: data:${mimeType};base64,${fragments.join(" \t\n")}`,
      });

      expect(sanitized).toEqual({ detail: "captured: <redacted>" });
      for (const fragment of fragments) {
        expect(JSON.stringify(sanitized)).not.toContain(fragment);
      }
    },
  );

  it("redacts non-base64 media data URLs in arbitrary diagnostic strings", () => {
    expect(
      sanitizeDiagnosticPayload(
        "thumbnail: data:image/svg+xml,%3Csvg%20viewBox='0%200%201%201'%3E",
      ),
    ).toBe("thumbnail: <redacted>");
  });

  it("redacts PDF data while preserving unrelated data and blob fields", () => {
    const pdfBlob = Buffer.from("alternate PDF bytes").toString("base64");
    const payload = {
      document: {
        type: "document",
        mimeType: "application/pdf",
        data: mediaData,
        blob: pdfBlob,
      },
      metadata: { data: "ordinary application data", blob: "ordinary opaque identifier" },
    };

    const sanitized = sanitizeDiagnosticPayload(payload);
    expect(sanitized).toEqual({
      document: {
        type: "document",
        mimeType: "application/pdf",
        data: "<redacted>",
        blob: "<redacted>",
        bytes: 11,
        sha256: mediaDigest,
      },
      metadata: payload.metadata,
    });
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain(mediaData);
    expect(serialized).not.toContain(pdfBlob);
  });

  it.each([
    {
      name: "diagnostic",
      sanitize: sanitizeDiagnosticPayload,
      expectedPath: "/private/media/video.mp4",
    },
    {
      name: "model-visible",
      sanitize: sanitizeModelVisibleMediaPayload,
      expectedPath: "<redacted-media-reference>",
    },
  ])(
    "redacts alias-only media bytes and references in the $name projection",
    ({ sanitize, expectedPath }) => {
      const nestedAudio = Buffer.from("alias-only nested audio").toString("base64");
      const sanitized = sanitize({
        video: {
          data: mediaData,
          path: "/private/media/video.mp4",
          durationSeconds: 12,
        },
        input_audio: [{ format: "wav", nested: [{ blob: nestedAudio }] }],
        metadata: { data: "ordinary application data" },
      }) as {
        video: Record<string, unknown>;
        input_audio: Array<{ nested: Array<Record<string, unknown>> }>;
        metadata: { data: string };
      };

      expect(sanitized.video).toMatchObject({
        data: "<redacted>",
        path: expectedPath,
        durationSeconds: 12,
        bytes: 11,
        sha256: mediaDigest,
      });
      expect(sanitized.input_audio[0]?.nested[0]).toMatchObject({
        blob: "<redacted>",
        bytes: Buffer.byteLength("alias-only nested audio"),
      });
      expect(sanitized.metadata.data).toBe("ordinary application data");
      const serialized = JSON.stringify(sanitized);
      expect(serialized).not.toContain(mediaData);
      expect(serialized).not.toContain(nestedAudio);
    },
  );

  it("projects model-visible media without bytes, data URLs, or local references", () => {
    const localPath = "/private/var/openclaw/media/secret-clip.mp4";
    const dataUrl = `data:video/mp4;base64,${mediaData}`;
    const projected = sanitizeModelVisibleMediaPayload({
      content: [
        { type: "video", data: mediaData, mimeType: "video/mp4", path: localPath },
        { type: "input_image", image_url: dataUrl },
        { type: "text", text: `captured ${dataUrl}` },
      ],
    });
    const serialized = JSON.stringify(projected);

    expect(serialized).not.toContain(mediaData);
    expect(serialized).not.toContain(dataUrl);
    expect(serialized).not.toContain(localPath);
    expect(serialized).toContain("<redacted-media-reference>");
  });

  it("fully redacts prefixed line-wrapped audio data URLs", () => {
    const fragments = ["cHJpdmF0ZS", "1hdWRpby1w", "YXlsb2Fk"];
    const projected = sanitizeModelVisibleMediaPayload(
      `captured audio: data:audio/mpeg;base64,${fragments.join(" \t\n")}`,
    );

    expect(projected).toBe("captured audio: <redacted>");
    for (const fragment of fragments) {
      expect(projected).not.toContain(fragment);
    }
  });
});
