import { describe, expect, it } from "vitest";
import {
  normalizeDurableMediaReference,
  sanitizeDurableMediaPayload,
  sanitizeMediaReferenceForProjection,
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
});
