import { describe, expect, it } from "vitest";
import {
  normalizeDurableMediaReference,
  sanitizeDurableMediaPayload,
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
});
