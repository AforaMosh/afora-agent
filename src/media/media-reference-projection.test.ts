import { describe, expect, it } from "vitest";
import {
  normalizeDurableMediaReference,
  sanitizeDurableMediaContentBlock,
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
        ["https://user", ":password@example.test/clip.mp4?signature=private#preview"].join(""),
      ),
    ).toBe("https://example.test/clip.mp4");
    expect(normalizeDurableMediaReference(" /tmp/clip.mp4 ")).toBe("/tmp/clip.mp4");
    expect(normalizeDurableMediaReference(" media/inbound/clip.mp4 ")).toBe(
      "media/inbound/clip.mp4",
    );
  });

  it("rejects malformed HTTP references instead of retaining their secrets", () => {
    const malformed = [
      "https://user",
      ":private-password@cdn.example.test:not-a-port/clip.mp4?token=private-query",
    ].join("");
    expect(sanitizeMediaReferenceForProjection(malformed)).toBe("");
    expect(normalizeDurableMediaReference(malformed)).toBeUndefined();
  });
});

describe("sanitizeDurableMediaPayload", () => {
  it("owns a distinct privacy snapshot even when values are unchanged", () => {
    const value = { nested: { text: "safe" }, items: [1, 2] };
    const projected = sanitizeDurableMediaPayload(value) as typeof value;
    expect(projected).toEqual(value);
    expect(projected).not.toBe(value);
    expect(projected.nested).not.toBe(value.nested);
    expect(projected.items).not.toBe(value.items);
  });

  it("snapshots every branch while removing durable media secrets", () => {
    const safe = { text: "keep" };
    const value = {
      safe,
      nested: {
        url: ["https://user", ":password@example.test/clip.mp4?token=private"].join(""),
      },
    };
    const projected = sanitizeDurableMediaPayload(value) as typeof value;
    expect(projected).not.toBe(value);
    expect(projected.safe).toEqual(safe);
    expect(projected.safe).not.toBe(safe);
    expect(projected.nested.url).toBe("https://example.test/clip.mp4");
  });

  it("breaks cycles while creating the privacy snapshot", () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(sanitizeDurableMediaPayload(value)).toEqual({ self: "[Circular]" });
  });

  it.each([
    ["exact image", "", "image/png", false, "[media data omitted]"],
    [
      "prefixed audio",
      "captured audio: ",
      "audio/mpeg",
      false,
      "captured audio: [media data omitted]",
    ],
    ["folded video", "captured clip: ", "video/mp4", true, "captured clip: [media data omitted]"],
  ])("fully redacts %s data URLs", (_name, prefix, mimeType, folded, expected) => {
    const fragments = ["cHJpdmF0ZS", "1tZWRpYS1w", "YXlsb2Fk"];
    const value = `${prefix}data:${mimeType};base64,${fragments.join(folded ? " \t\n" : "")}`;
    const projected = sanitizeDurableMediaPayload(value);

    expect(projected).toBe(expected);
    for (const fragment of fragments) {
      expect(projected).not.toContain(fragment);
    }
  });

  it.each(["application/pdf", "text/plain"])(
    "preserves folded %s data URLs outside the durable media classes",
    (mimeType) => {
      const value = `document: data:${mimeType};base64,cHJpdmF0ZQ== \t\nZGF0YQ==`;
      expect(sanitizeDurableMediaPayload(value)).toBe(value);
    },
  );

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

  it("preserves remote video wrappers while sanitizing their references", () => {
    expect(
      sanitizeDurableMediaPayload({
        type: "video",
        source: {
          type: "url",
          url: ["https://user", ":password@example.test/video.mp4?signature=private#preview"].join(
            "",
          ),
        },
        label: "keep",
      }),
    ).toEqual({
      type: "video",
      source: { type: "url", url: "https://example.test/video.mp4" },
      label: "keep",
    });
  });

  it("reads a changing video carrier once before projecting it", () => {
    const payload = "private-changing-video-source";
    const value = { type: "video" } as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(value, "source", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1
          ? { type: "base64", data: payload }
          : { type: "url", url: "https://example.test/video.mp4" };
      },
    });

    const projected = sanitizeDurableMediaPayload(value);

    expect(projected).toBe("[video data omitted]");
    expect(reads).toBe(1);
    expect(JSON.stringify(projected)).not.toContain(payload);
  });

  it("projects stateful provider content through one detached pass", () => {
    const payload = "private-stateful-provider-video";
    const value = { type: "image", text: "keep" } as Record<string, unknown>;
    let mimeReads = 0;
    let sourceReads = 0;
    Object.defineProperty(value, "mimeType", {
      enumerable: true,
      get() {
        mimeReads += 1;
        return mimeReads === 1 ? "video/mp4" : "image/png";
      },
    });
    Object.defineProperty(value, "source", {
      enumerable: true,
      get() {
        sourceReads += 1;
        return sourceReads === 1
          ? { type: "url", url: "https://example.test/video.mp4" }
          : { type: "base64", data: payload };
      },
    });

    const projected = sanitizeDurableMediaContentBlock(value);

    expect(projected).toEqual({
      type: "image",
      text: "keep",
      mimeType: "video/mp4",
      source: { type: "url", url: "https://example.test/video.mp4" },
    });
    expect(mimeReads).toBe(1);
    expect(sourceReads).toBe(1);
    expect(JSON.stringify(projected)).not.toContain(payload);
  });

  it("materializes prototype-custom objects without invoking inherited serializers", () => {
    const payload = "private-durable-prototype-video";
    let calls = 0;
    class SerializerTrap {
      safe = "keep";
      nested = { contentType: "video/mp4", data: payload };
      #payload = payload;
      toJSON() {
        calls += 1;
        return { contentType: "video/mp4", data: this.#payload };
      }
    }

    const projected = sanitizeDurableMediaPayload(new SerializerTrap());

    expect(projected).toEqual({ safe: "keep", nested: "[video data omitted]" });
    expect(calls).toBe(0);
    expect(Object.hasOwn(projected as object, "toJSON")).toBe(false);
    expect(JSON.stringify(projected)).not.toContain(payload);
    expect(calls).toBe(0);
  });

  it.each([false, true])(
    "contains throwing %s toJSON getters and unreadable enumerable fields durably",
    (enumerableToJSON) => {
      const payload = `private-durable-getter-${enumerableToJSON}`;
      const value = {
        nested: { contentType: "video/mp4", data: payload },
      } as Record<string, unknown>;
      let serializerReads = 0;
      Object.defineProperty(value, "toJSON", {
        enumerable: enumerableToJSON,
        get() {
          serializerReads += 1;
          throw new Error("synthetic toJSON getter failure");
        },
      });
      Object.defineProperty(value, "hiddenMedia", {
        enumerable: true,
        get() {
          throw new Error(`synthetic hidden media: ${payload}`);
        },
      });

      expect(() => sanitizeDurableMediaPayload(value)).not.toThrow();
      const projected = sanitizeDurableMediaPayload(value) as Record<string, unknown>;

      expect(projected.nested).toBe("[video data omitted]");
      expect(projected.hiddenMedia).toBe("[media details omitted: unreadable property]");
      expect(projected).not.toHaveProperty("toJSON");
      expect(serializerReads).toBe(0);
      expect(JSON.stringify(projected)).not.toContain(payload);
    },
  );

  it("never rereads or retains a fallback toJSON accessor returning fresh functions", () => {
    const payload = "private-durable-fresh-tojson";
    const value = {
      nested: { contentType: "video/mp4", data: payload },
    } as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(value, "toJSON", {
      enumerable: true,
      get() {
        reads += 1;
        return () => this;
      },
    });

    const projected = sanitizeDurableMediaPayload(value) as Record<string, unknown>;

    expect(reads).toBe(0);
    expect(projected).not.toHaveProperty("toJSON");
    expect(projected.nested).toBe("[video data omitted]");
    expect(() => JSON.stringify(projected)).not.toThrow();
    expect(JSON.stringify(projected)).not.toContain(payload);
  });

  it("creates durable __proto__ output without invoking prototype serializers", () => {
    const payload = "private-durable-proto-video";
    let calls = 0;
    class ProtoMediaCarrier {
      toJSON() {
        calls += 1;
        return { contentType: "video/mp4", data: payload };
      }
    }
    const value = new ProtoMediaCarrier();
    Object.defineProperty(value, "__proto__", {
      enumerable: true,
      value: { contentType: "video/mp4", data: payload },
    });
    Object.defineProperty(value, "constructor", {
      enumerable: true,
      value: "preserved constructor data",
    });
    Object.defineProperty(value, "label", { enumerable: true, value: "safe" });

    const projected = sanitizeDurableMediaPayload(value) as Record<string, unknown>;

    expect(Object.getPrototypeOf(projected)).toBe(Object.prototype);
    expect(Object.hasOwn(projected, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(projected, "__proto__")?.value).toBe(
      "[video data omitted]",
    );
    expect(projected.constructor).toBe("preserved constructor data");
    expect(Object.hasOwn(projected, "toJSON")).toBe(false);
    expect(Object.keys(projected)).toEqual(["__proto__", "constructor", "label"]);
    expect(JSON.stringify(projected)).not.toContain(payload);
    expect(calls).toBe(0);
  });

  it.each(["throwing", "fresh-function"] as const)(
    "omits enumerable %s serializers without invocation",
    (behavior) => {
      const payload = `private-${behavior}-video`;
      let calls = 0;
      const value = { nested: { contentType: "video/mp4", data: payload } };
      Object.defineProperty(value, "toJSON", {
        enumerable: true,
        value: () => {
          calls += 1;
          if (behavior === "throwing") {
            throw new Error("synthetic serializer failure");
          }
          return () => value;
        },
      });
      const projected = sanitizeDurableMediaPayload(value);

      expect(projected).not.toBe(value);
      expect(projected).toEqual({ nested: "[video data omitted]" });
      expect(() => JSON.stringify(projected)).not.toThrow();
      expect(JSON.stringify(projected)).not.toContain(payload);
      expect(calls).toBe(0);
    },
  );

  it("breaks custom-object cycles without invoking inherited serializers", () => {
    let calls = 0;
    class CyclicCarrier {
      safe = "keep";
      self: unknown = this;
      toJSON() {
        calls += 1;
        return { leaked: this };
      }
    }
    const value = new CyclicCarrier();

    const projected = sanitizeDurableMediaPayload(value);

    expect(projected).toEqual({ safe: "keep", self: "[Circular]" });
    expect(projected).not.toBe(value);
    expect(() => JSON.stringify(projected)).not.toThrow();
    expect(calls).toBe(0);
  });
});

describe("sanitizeModelVisibleMediaPayload", () => {
  it("owns a distinct safe plain-object snapshot", () => {
    const value = {
      nested: { type: "metadata", data: "safe non-media data", text: "safe" },
      items: [1, 2],
    };
    const projected = sanitizeModelVisibleMediaPayload(value) as typeof value;
    expect(projected).toEqual(value);
    expect(projected).not.toBe(value);
    expect(projected.nested).not.toBe(value.nested);
    expect(projected.items).not.toBe(value.items);
  });

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

  it.each([
    {
      name: "image source",
      value: {
        type: "image",
        source: { type: "base64", data: "private-image-bytes" },
        caption: "keep image caption",
      },
      expected: {
        type: "image",
        source: "[media data omitted]",
        caption: "keep image caption",
      },
      payload: "private-image-bytes",
    },
    {
      name: "audio source",
      value: {
        type: "audio",
        source: { type: "base64", data: "private-audio-bytes" },
        transcript: "keep audio transcript",
      },
      expected: {
        type: "audio",
        source: "[media data omitted]",
        transcript: "keep audio transcript",
      },
      payload: "private-audio-bytes",
    },
    {
      name: "video source relying on outer context",
      value: {
        type: "video",
        source: { data: "private-video-bytes" },
        duration: 12,
      },
      expected: {
        type: "video",
        source: "[media data omitted]",
        duration: 12,
      },
      payload: "private-video-bytes",
    },
    {
      name: "PDF document source",
      value: {
        type: "document",
        mimeType: "application/pdf",
        source: { type: "base64", data: "private-document-bytes" },
        title: "keep document title",
      },
      expected: {
        type: "document",
        mimeType: "application/pdf",
        source: "[media data omitted]",
        title: "keep document title",
      },
      payload: "private-document-bytes",
    },
    {
      name: "array nested under media context",
      value: {
        type: "input_image",
        parts: [{ data: "private-array-image-bytes" }, { label: "keep safe metadata" }],
      },
      expected: {
        type: "input_image",
        parts: ["[media data omitted]", { label: "keep safe metadata" }],
      },
      payload: "private-array-image-bytes",
    },
  ])("redacts nested $name payloads", ({ value, expected, payload }) => {
    const projected = sanitizeModelVisibleMediaPayload(value);

    expect(projected).toEqual(expected);
    expect(JSON.stringify(projected)).not.toContain(payload);
  });

  it("reads stateful nested media context getters once", () => {
    const payload = "private-stateful-nested-image";
    const value = { caption: "keep" } as Record<string, unknown>;
    let typeReads = 0;
    let sourceReads = 0;
    Object.defineProperty(value, "type", {
      enumerable: true,
      get() {
        typeReads += 1;
        return typeReads === 1 ? "image" : "text";
      },
    });
    Object.defineProperty(value, "source", {
      enumerable: true,
      get() {
        sourceReads += 1;
        return sourceReads === 1 ? { data: payload } : { note: "safe replacement" };
      },
    });

    const projected = sanitizeModelVisibleMediaPayload(value);

    expect(projected).toEqual({
      caption: "keep",
      type: "image",
      source: "[media data omitted]",
    });
    expect(typeReads).toBe(1);
    expect(sourceReads).toBe(1);
    expect(JSON.stringify(projected)).not.toContain(payload);
  });
});

describe.each([
  ["durable", sanitizeDurableMediaPayload],
  ["model-visible", sanitizeModelVisibleMediaPayload],
] as const)("%s serializer-free snapshots", (_mode, sanitize) => {
  const mediaOmission = _mode === "durable" ? "[video data omitted]" : "[media data omitted]";

  it("owns a distinct safe plain-array snapshot", () => {
    const value = ["safe", { text: "keep" }];
    const projected = sanitize(value) as typeof value;
    expect(projected).toEqual(value);
    expect(projected).not.toBe(value);
    expect(projected[1]).not.toBe(value[1]);
  });

  it.each(["method", "getter"] as const)("never invokes own toJSON %s", (kind) => {
    const payload = `private-own-${kind}-serializer`;
    let calls = 0;
    let reads = 0;
    const value = {
      safe: "keep",
      nested: { contentType: "video/mp4", data: payload },
    } as Record<string, unknown>;
    if (kind === "method") {
      Object.defineProperty(value, "toJSON", {
        enumerable: true,
        value: () => {
          calls += 1;
          return { contentType: "video/mp4", data: payload };
        },
      });
    } else {
      Object.defineProperty(value, "toJSON", {
        enumerable: true,
        get() {
          reads += 1;
          return () => {
            calls += 1;
            return { contentType: "video/mp4", data: payload };
          };
        },
      });
    }

    const projected = sanitize(value) as Record<string, unknown>;

    expect(projected).toEqual({ safe: "keep", nested: mediaOmission });
    expect(reads).toBe(0);
    expect(calls).toBe(0);
    expect(projected).not.toHaveProperty("toJSON");
    expect(JSON.stringify(projected)).not.toContain(payload);
    expect(reads).toBe(0);
    expect(calls).toBe(0);
  });

  it("reads ordinary accessors once into a plain snapshot", () => {
    const payload = "private-changing-ordinary-accessor";
    let reads = 0;
    const value = { safe: "keep" } as Record<string, unknown>;
    Object.defineProperty(value, "snapshot", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? "first safe value" : { contentType: "video/mp4", data: payload };
      },
    });

    const projected = sanitize(value);

    expect(reads).toBe(1);
    expect(projected).toEqual({ safe: "keep", snapshot: "first safe value" });
    expect(Object.getPrototypeOf(projected)).toBe(Object.prototype);
    expect(JSON.stringify(projected)).not.toContain(payload);
    expect(reads).toBe(1);
  });

  it("isolates an earlier subtree from mutation by a later getter", () => {
    const payload = "private-late-getter-video";
    const victim = { note: "safe before getter" } as Record<string, unknown>;
    const value = { victim } as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(value, "mutator", {
      enumerable: true,
      get() {
        reads += 1;
        victim.contentType = "video/mp4";
        victim.data = payload;
        return "mutation complete";
      },
    });

    const projected = sanitize(value) as {
      victim: Record<string, unknown>;
      mutator: string;
    };

    expect(reads).toBe(1);
    expect(victim).toMatchObject({ contentType: "video/mp4", data: payload });
    expect(projected.victim).toEqual({ note: "safe before getter" });
    expect(projected.victim).not.toBe(victim);
    expect(projected.mutator).toBe("mutation complete");
    expect(JSON.stringify(projected)).not.toContain(payload);
  });

  it("sanitizes array indexes without reading custom serializers or copying custom props", () => {
    const payload = "private-array-serializer";
    let serializerReads = 0;
    let indexReads = 0;
    const value: unknown[] & { custom?: unknown; toJSON?: unknown } = [];
    value.length = 1;
    Object.defineProperty(value, "0", {
      enumerable: true,
      get() {
        indexReads += 1;
        return { contentType: "video/mp4", data: payload };
      },
    });
    Object.defineProperty(value, "toJSON", {
      enumerable: true,
      get() {
        serializerReads += 1;
        return () => ({ contentType: "video/mp4", data: payload });
      },
    });
    Object.defineProperty(value, "custom", { enumerable: true, value: "drop me" });

    const projected = sanitize(value) as unknown[] & { custom?: unknown; toJSON?: unknown };

    expect(projected).toEqual([mediaOmission]);
    expect(Object.getPrototypeOf(projected)).toBe(Array.prototype);
    expect(indexReads).toBe(1);
    expect(serializerReads).toBe(0);
    expect(projected).not.toHaveProperty("toJSON");
    expect(projected).not.toHaveProperty("custom");
    expect(JSON.stringify(projected)).not.toContain(payload);
  });

  it("materializes functions without invoking inherited serializers", () => {
    const payload = "private-function-serializer";
    let calls = 0;
    const prototype = {
      toJSON() {
        calls += 1;
        return { contentType: "video/mp4", data: payload };
      },
    };
    const value = function serializerCarrier() {} as (() => void) & { safe?: string };
    Object.setPrototypeOf(value, prototype);
    value.safe = "keep";

    const projected = sanitize(value);

    expect(projected).toEqual({ safe: "keep" });
    expect(Object.getPrototypeOf(projected)).toBe(Object.prototype);
    expect(calls).toBe(0);
    expect(JSON.stringify(projected)).not.toContain(payload);
    expect(calls).toBe(0);
  });

  it("keeps __proto__ as sanitized own data without invoking inherited serializers", () => {
    const payload = "private-shared-proto-video";
    let calls = 0;
    const value = Object.fromEntries([
      ["__proto__", { contentType: "video/mp4", data: payload }],
      ["constructor", "preserved constructor data"],
      ["label", "safe"],
    ]);
    Object.setPrototypeOf(value, {
      toJSON() {
        calls += 1;
        return { contentType: "video/mp4", data: payload };
      },
    });

    const projected = sanitize(value) as Record<string, unknown>;

    expect(Object.getPrototypeOf(projected)).toBe(Object.prototype);
    expect(Object.hasOwn(projected, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(projected, "__proto__")?.value).toBe(mediaOmission);
    expect(projected.constructor).toBe("preserved constructor data");
    expect(Object.keys(projected)).toEqual(["__proto__", "constructor", "label"]);
    expect(calls).toBe(0);
    expect(JSON.stringify(projected)).not.toContain(payload);
    expect(calls).toBe(0);
  });

  it("omits typed arrays and buffers without invoking prototype serializers", () => {
    let calls = 0;
    class SerializerBytes extends Uint8Array {
      toJSON() {
        calls += 1;
        return { leaked: [...this] };
      }
    }
    const bytes = new SerializerBytes([1, 2, 3]);
    const buffer = Buffer.from("private-buffer-bytes");

    expect(sanitize(bytes)).toBe("[binary data omitted]");
    expect(sanitize(buffer)).toBe("[binary data omitted]");
    expect(calls).toBe(0);
    expect(JSON.stringify([sanitize(bytes), sanitize(buffer)])).not.toContain("private-buffer");
    expect(calls).toBe(0);
  });
});
