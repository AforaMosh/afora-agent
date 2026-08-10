import { describe, expect, it } from "vitest";
import {
  canonicalizePersistedUserMessageMedia,
  isImageMediaFact,
  isVideoMediaFact,
  normalizeMediaFacts,
  PERSISTED_LEGACY_MEDIA_KEYS,
  readPersistedMediaFacts,
  readPersistedMediaBlockFactIndexes,
} from "./media-facts.js";

const canonicalFact = { path: "/media/canonical.png", contentType: "image/png" };

describe("canonical persisted media", () => {
  it.each([
    {
      name: "legacy-only",
      message: { MediaPath: "/media/legacy.png", MediaType: "image/png" },
      expected: [{ path: "/media/legacy.png", contentType: "image/png", kind: "image" }],
    },
    {
      name: "facts-only",
      message: { __openclaw: { media: [canonicalFact] } },
      expected: [{ ...canonicalFact, kind: "image" }],
    },
    {
      name: "top-level-media-only",
      message: { media: [canonicalFact] },
      expected: [{ ...canonicalFact, kind: "image" }],
    },
    {
      name: "both-equal",
      message: {
        MediaPath: canonicalFact.path,
        MediaType: canonicalFact.contentType,
        __openclaw: { media: [canonicalFact] },
      },
      expected: [{ ...canonicalFact, kind: "image" }],
    },
    {
      name: "both-conflict",
      message: {
        MediaPath: "/media/legacy-conflict.jpg",
        MediaType: "image/jpeg",
        __openclaw: { media: [canonicalFact] },
      },
      expected: [{ ...canonicalFact, kind: "image" }],
    },
    {
      name: "sparse",
      message: {
        MediaPaths: ["", "/media/second.png"],
        MediaTypes: ["", "image/png"],
        __openclaw: { media: [{ url: "https://example.test/first" }] },
      },
      expected: [
        { url: "https://example.test/first" },
        { path: "/media/second.png", contentType: "image/png", kind: "image" },
      ],
    },
    {
      name: "type-only",
      message: { MediaType: "image" },
      expected: [{ kind: "image" }],
    },
    {
      name: "media-only",
      message: { role: "user", content: "", __openclaw: { media: [canonicalFact] } },
      expected: [{ ...canonicalFact, kind: "image" }],
    },
  ])("canonicalizes $name rows", ({ message, expected }) => {
    const result = canonicalizePersistedUserMessageMedia(message);
    for (const key of PERSISTED_LEGACY_MEDIA_KEYS) {
      expect(result.message).not.toHaveProperty(key);
    }
    expect(readPersistedMediaFacts(result.message)).toEqual(
      expected.map((fact) => expect.objectContaining(fact)),
    );
  });

  it("copies transcription and workspace metadata while preserving adjacent metadata", () => {
    const result = canonicalizePersistedUserMessageMedia({
      MediaPaths: ["/media/a.ogg", "/media/b.png"],
      MediaTypes: ["audio", "image/png"],
      MediaTranscribedIndexes: [0],
      MediaStaged: true,
      MediaWorkspaceDir: "/media/workspace",
      __openclaw: { traceId: "trace-1", media: [{ messageId: "m1" }] },
    });

    expect(result.message).toEqual({
      __openclaw: {
        traceId: "trace-1",
        media: [
          expect.objectContaining({
            path: "/media/a.ogg",
            kind: "audio",
            transcribed: true,
            staged: true,
            workspaceDir: "/media/workspace",
            messageId: "m1",
          }),
          expect.objectContaining({
            path: "/media/b.png",
            contentType: "image/png",
            staged: true,
            workspaceDir: "/media/workspace",
          }),
        ],
      },
    });
  });

  it("round-trips duration and dimensions in canonical persisted facts", () => {
    const result = canonicalizePersistedUserMessageMedia({
      __openclaw: {
        media: [
          {
            path: "/media/clip.mp4",
            contentType: "video/mp4",
            durationMs: 12_346,
            width: 1280,
            height: 720,
          },
        ],
      },
    });

    expect(readPersistedMediaFacts(result.message)).toEqual([
      expect.objectContaining({
        path: "/media/clip.mp4",
        contentType: "video/mp4",
        kind: "video",
        durationMs: 12_346,
        width: 1280,
        height: 720,
      }),
    ]);
  });

  it("rejects compact types after a sparse positional gap", () => {
    expect(() =>
      canonicalizePersistedUserMessageMedia({
        MediaPaths: ["", "/media/b.png"],
        MediaTypes: ["image/png"],
      }),
    ).toThrow("ambiguous sparse positional alignment");
  });

  it("rejects under-cardinal compact types after dense attachment paths", () => {
    expect(() =>
      canonicalizePersistedUserMessageMedia({
        MediaPaths: ["/media/a.bin", "/media/b.pdf"],
        MediaTypes: ["application/pdf"],
      }),
    ).toThrow("ambiguous sparse positional alignment");
  });

  it("accepts compact legacy types when complete canonical facts cover every slot", () => {
    const result = canonicalizePersistedUserMessageMedia({
      MediaPaths: ["/media/a.bin", "/media/b.pdf"],
      MediaTypes: ["application/pdf"],
      __openclaw: {
        media: [
          { path: "/media/a.bin", contentType: "application/octet-stream" },
          { path: "/media/b.pdf", contentType: "application/pdf" },
        ],
      },
    });

    expect(readPersistedMediaFacts(result.message)).toEqual([
      expect.objectContaining({
        path: "/media/a.bin",
        contentType: "application/octet-stream",
      }),
      expect.objectContaining({ path: "/media/b.pdf", contentType: "application/pdf" }),
    ]);
  });

  it("does not materialize a compact legacy type into an empty canonical slot", () => {
    const result = canonicalizePersistedUserMessageMedia({
      MediaPaths: ["", "/media/b.png"],
      MediaType: "image",
      MediaTypes: ["image/png"],
      __openclaw: {
        media: [{}, { path: "/media/b.png", contentType: "image/png" }],
      },
    });

    expect((result.message["__openclaw"] as { media: unknown[] }).media).toEqual([
      { sourceIndex: 0 },
      expect.objectContaining({ path: "/media/b.png", contentType: "image/png" }),
    ]);
  });

  it("removes a conflicting top-level media copy", () => {
    const result = canonicalizePersistedUserMessageMedia({
      media: [{ path: "/media/runtime.png", contentType: "image/png" }],
      __openclaw: { media: [canonicalFact] },
    });

    expect(result.message).not.toHaveProperty("media");
    expect(readPersistedMediaFacts(result.message)?.[0]).toMatchObject(canonicalFact);
  });

  it("removes secrets and inline data when canonicalizing runtime facts for persistence", () => {
    const inlinePayload = "cHJpdmF0ZS1tZWRpYQ==";
    const result = canonicalizePersistedUserMessageMedia({
      __openclaw: {
        media: [
          { path: `data:image/png;base64,${inlinePayload}`, contentType: "image/png" },
          {
            url: [
              "https://user",
              ":password@cdn.example.test/clip.mp4?signature=private#preview",
            ].join(""),
            contentType: "video/mp4",
          },
        ],
      },
    });

    const media = readPersistedMediaFacts(result.message);
    expect(media?.[0]?.path).toBeUndefined();
    expect(media?.[1]?.url).toBe("https://cdn.example.test/clip.mp4");
    expect(JSON.stringify(result.message)).not.toContain("data:");
    expect(JSON.stringify(result.message)).not.toContain(inlinePayload);
    expect(JSON.stringify(result.message)).not.toContain("password");
    expect(JSON.stringify(result.message)).not.toContain("signature");
  });
});

describe("runtime media facts", () => {
  it("preserves trimmed authenticated runtime references needed for fetching", () => {
    const authenticatedReference = [
      "https://user",
      ":password@cdn.example.test/clip.mp4?signature=private#preview",
    ].join("");

    expect(
      normalizeMediaFacts([
        {
          path: ` ${authenticatedReference} `,
          url: ` ${authenticatedReference} `,
          contentType: "video/mp4",
        },
      ])[0],
    ).toMatchObject({
      path: authenticatedReference,
      url: authenticatedReference,
    });
  });
});

describe("canonical image media facts", () => {
  it.each([
    { name: "filename-only SVG", fact: { path: "/tmp/diagram.svg" }, expected: false },
    {
      name: "unknown-kind SVG with generic MIME",
      fact: {
        path: "/tmp/diagram.svg",
        kind: "unknown" as const,
        contentType: "application/octet-stream",
      },
      expected: false,
    },
    {
      name: "explicit image-kind SVG",
      fact: { path: "/tmp/diagram.svg", kind: "image" as const },
      expected: true,
    },
    {
      name: "explicit SVG image MIME",
      fact: { path: "/tmp/diagram.svg", contentType: "image/svg+xml" },
      expected: true,
    },
    { name: "filename-only TIFF", fact: { path: "/tmp/scan.tiff" }, expected: true },
    {
      name: "generic MIME TIFF",
      fact: { path: "/tmp/scan.TIF", contentType: "binary/octet-stream" },
      expected: true,
    },
    {
      name: "authoritative document TIFF",
      fact: { path: "/tmp/scan.tiff", contentType: "image/png", kind: "document" as const },
      expected: false,
    },
    {
      name: "unknown-kind PDF with image filename",
      fact: { path: "/tmp/report.png", contentType: "application/pdf", kind: "unknown" as const },
      expected: false,
    },
    {
      name: "unknown-kind ZIP with image filename",
      fact: { path: "/tmp/report.png", contentType: "application/zip", kind: "unknown" as const },
      expected: false,
    },
    {
      name: "unknown-kind text with image filename",
      fact: { path: "/tmp/report.png", contentType: "text/plain", kind: "unknown" as const },
      expected: false,
    },
    {
      name: "legacy bare image kind",
      fact: { path: "/tmp/photo.png", contentType: "image" },
      expected: true,
    },
    {
      name: "legacy bare sticker kind",
      fact: { path: "/tmp/sticker.bin", contentType: "sticker" },
      expected: true,
    },
  ])("classifies $name at the shared image-fact owner", ({ fact, expected }) => {
    expect(isImageMediaFact(fact)).toBe(expected);
  });

  it("preserves generic binary provenance without inventing authoritative documents", () => {
    const [inferredImage, explicitDocument] = normalizeMediaFacts([
      { path: "/tmp/scan.tiff", contentType: "application/octet-stream" },
      { path: "/tmp/report.png", contentType: "application/octet-stream", kind: "document" },
    ]);

    expect(inferredImage?.kind).toBeUndefined();
    expect(inferredImage && isImageMediaFact(inferredImage)).toBe(true);
    expect(explicitDocument?.kind).toBe("document");
    expect(explicitDocument && isImageMediaFact(explicitDocument)).toBe(false);
  });

  it("keeps persisted filename SVG and TIFF aligned with the canonical image owner", () => {
    const media = readPersistedMediaFacts({
      __openclaw: {
        media: [
          { path: "/tmp/diagram.svg" },
          { path: "/tmp/scan.tiff", contentType: "application/octet-stream" },
          { path: "/tmp/explicit.svg", kind: "image" },
        ],
      },
    });

    expect(media?.map(isImageMediaFact)).toEqual([false, true, true]);
    expect(media?.[1]?.kind).toBeUndefined();
  });

  it.each([
    { fact: { kind: "video" as const }, expected: true },
    { fact: { contentType: "video" }, expected: true },
    { fact: { path: "/tmp/clip.mp4", contentType: "application/octet-stream" }, expected: true },
    { fact: { path: "/tmp/clip.mp4", contentType: "text/plain" }, expected: false },
    { fact: { path: "/tmp/clip.mp4", kind: "document" as const }, expected: false },
  ])("classifies video facts at the shared media owner", ({ fact, expected }) => {
    expect(isVideoMediaFact(fact)).toBe(expected);
  });

  it("strictly reads persisted media-block provenance without owning cardinality", () => {
    expect(
      readPersistedMediaBlockFactIndexes({
        __openclaw: { mediaBlockFactIndexes: [0, null, 2] },
      }),
    ).toEqual([0, null, 2]);
    expect(
      readPersistedMediaBlockFactIndexes({
        __openclaw: { mediaBlockFactIndexes: [0, -1] },
      }),
    ).toBeUndefined();
  });
});
