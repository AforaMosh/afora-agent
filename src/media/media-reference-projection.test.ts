import { describe, expect, it } from "vitest";
import {
  normalizeDurableMediaReference,
  sanitizeDurableMediaPayload,
  sanitizeMediaReferenceForProjection,
  sanitizeModelVisibleMediaPayload,
} from "./media-reference-projection.js";

describe("normalizeDurableMediaReference", () => {
  it("rejects inline data while preserving managed, remote, and local references", () => {
    expect(normalizeDurableMediaReference("data:video/mp4;base64,cHJpdmF0ZQ==")).toBeUndefined();
    expect(normalizeDurableMediaReference(" DATA:image/png;base64,cHJpdmF0ZQ== ")).toBeUndefined();
    expect(normalizeDurableMediaReference(" media://inbound/clip.mp4 ")).toBe(
      "media://inbound/clip.mp4",
    );
    expect(
      normalizeDurableMediaReference(
        "https://user" + ":password@example.test/clip.mp4?signature=private#preview",
      ),
    ).toBe("https://example.test/clip.mp4");
    expect(normalizeDurableMediaReference(" /tmp/clip.mp4 ")).toBe("/tmp/clip.mp4");
    expect(normalizeDurableMediaReference(" media/inbound/clip.mp4 ")).toBe(
      "media/inbound/clip.mp4",
    );
  });

  it("rejects malformed HTTP references instead of retaining their secrets", () => {
    const malformed =
      "https://user" + ":private-password@cdn.example.test:not-a-port/clip.mp4?token=private-query";
    expect(sanitizeMediaReferenceForProjection(malformed)).toBe("");
    expect(normalizeDurableMediaReference(malformed)).toBeUndefined();
  });
});

describe("sanitizeDurableMediaPayload", () => {
  it("preserves original identity when no projection changes", () => {
    const value = { nested: { text: "safe" }, items: [1, 2] };
    expect(sanitizeDurableMediaPayload(value)).toBe(value);
  });

  it("copies only changed branches while removing durable media secrets", () => {
    const safe = { text: "keep" };
    const value = {
      safe,
      nested: {
        url: "https://user" + ":password@example.test/clip.mp4?token=private",
      },
    };
    const projected = sanitizeDurableMediaPayload(value) as typeof value;
    expect(projected).not.toBe(value);
    expect(projected.safe).toBe(safe);
    expect(projected.nested.url).toBe("https://example.test/clip.mp4");
  });

  it("breaks cycles during the same copy-on-write traversal", () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(sanitizeDurableMediaPayload(value)).toEqual({ self: "[Circular]" });
  });

  it.each([
    ["exact", "", "[video data omitted]"],
    ["prefixed", "captured clip: ", "captured clip: [video data omitted]"],
  ])("fully redacts %s line-wrapped video data URLs", (_name, prefix, expected) => {
    const fragments = ["cHJpdmF0ZS", "12aWRlby1w", "YXlsb2Fk"];
    const value = `${prefix}data:video/mp4;base64,${fragments.join(" \t\n")}`;
    const projected = sanitizeDurableMediaPayload(value);

    expect(projected).toBe(expected);
    for (const fragment of fragments) {
      expect(projected).not.toContain(fragment);
    }
  });

  it.each(["contentType", "content_type"] as const)(
    "redacts raw video envelopes identified by %s",
    (mimeKey) => {
      const payload = "cHJpdmF0ZS12aWRlby1ieXRlcw==";
      const projected = sanitizeDurableMediaPayload({
        mimeType: "application/octet-stream",
        [mimeKey]: "video/mp4",
        data: payload,
      });

      expect(projected).toBe("[video data omitted]");
      expect(JSON.stringify(projected)).not.toContain(payload);
    },
  );
});

describe("sanitizeModelVisibleMediaPayload", () => {
  it.each([
    "metadata:key,value",
    "some_data:text/plain,keep",
    "metadata:video/mp4;base64,keep",
    "some_data:video/mp4;base64,keep",
  ])("preserves non-URI data-like text %s", (value) => {
    expect(sanitizeModelVisibleMediaPayload(value)).toBe(value);
    expect(sanitizeDurableMediaPayload(value)).toBe(value);
  });

  it("redacts a real prefixed line-wrapped data URL", () => {
    const fragments = ["cHJpdmF0ZS", "1nZW5lcmlj", "LXBheWxvYWQ="];
    const projected = sanitizeModelVisibleMediaPayload(
      `captured: data:text/plain;base64,${fragments.join(" \t\n")}`,
    );

    expect(projected).toBe("captured: [media data omitted]");
    for (const fragment of fragments) {
      expect(projected).not.toContain(fragment);
    }
  });

  it("breaks cycles without retaining unsanitized media branches", () => {
    const payload = "c3ludGhldGljLXByaXZhdGUtdmlkZW8=";
    const value: { self?: unknown; nested?: unknown } = {};
    value.self = value;
    value.nested = { contentType: "video/mp4", data: payload };

    const projected = sanitizeModelVisibleMediaPayload(value) as typeof value;

    expect(projected).not.toBe(value);
    expect(projected.self).toBe("[Circular]");
    expect(projected.nested).toBe("[media data omitted]");
    expect(JSON.stringify(projected)).not.toContain(payload);
  });
});
