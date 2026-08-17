// Gateway Protocol tests cover openclaw.schema behavior.
import { Buffer } from "node:buffer";
import { crc32, deflateSync } from "node:zlib";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { SystemAgentChatResultSchema } from "./schema/openclaw.js";
import type { WizardStep } from "./schema/wizard.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 8 + data.length);
  return chunk;
}

function pngDataUrl(params: {
  width?: number;
  height?: number;
  interlace?: 0 | 1;
  filteredData: Uint8Array;
  splitIdatAt?: number;
  truncateCompressedBytes?: number;
}): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(params.width ?? 1, 0);
  header.writeUInt32BE(params.height ?? 1, 4);
  header[8] = 8;
  header[9] = 6;
  header[12] = params.interlace ?? 0;
  const compressed = deflateSync(params.filteredData).subarray(
    0,
    params.truncateCompressedBytes === undefined ? undefined : -params.truncateCompressedBytes,
  );
  const split = params.splitIdatAt ?? compressed.length;
  const idatChunks = [compressed.subarray(0, split), compressed.subarray(split)]
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => pngChunk("IDAT", chunk));
  return `data:image/png;base64,${Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    ...idatChunks,
    pngChunk("IEND", new Uint8Array()),
  ]).toString("base64")}`;
}

/**
 * The chat result carries the awaited wizard step verbatim so control-capable
 * clients can render it. Every step type has to survive the wire, including the
 * fields the card-shaped `question` projection drops.
 */
describe("SystemAgentChatResultSchema", () => {
  const validate = Compile(SystemAgentChatResultSchema);
  const base = { sessionId: "chat-1", reply: "Bot token", action: "none" };
  const qrDataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const indexedQrDataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAABlBMVEUAAAD///+l2Z/dAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

  const steps: Array<{ name: string; step: WizardStep }> = [
    {
      // No initialValue: the schema still permits one (wizard.start/next carry
      // prefill for editable prompts), but the chat engine strips it from a
      // sensitive step before serializing, so this is the shape that ships here.
      name: "sensitive text carrying placeholder but no prefilled secret",
      step: {
        id: "step-text",
        type: "text",
        message: "Bot token",
        placeholder: "123:abc",
        sensitive: true,
        executor: "client",
      },
    },
    {
      name: "non-sensitive text carrying a prefilled value",
      step: {
        id: "step-text-prefill",
        type: "text",
        message: "Display name",
        initialValue: "openclaw-bot",
        executor: "client",
      },
    },
    {
      name: "select with options",
      step: {
        id: "step-select",
        type: "select",
        message: "DM mode",
        options: [
          { value: "alpha", label: "Alpha", hint: "First" },
          { value: "beta", label: "Beta" },
        ],
        initialValue: "beta",
        executor: "client",
      },
    },
    {
      name: "multiselect with options",
      step: {
        id: "step-multiselect",
        type: "multiselect",
        message: "Features",
        options: [
          { value: "alerts", label: "Alerts" },
          { value: "logs", label: "Logs" },
        ],
        initialValue: ["alerts"],
        executor: "client",
      },
    },
    {
      name: "confirm",
      step: {
        id: "step-confirm",
        type: "confirm",
        message: "Enable delegated auth?",
        initialValue: false,
        executor: "client",
      },
    },
    {
      // The engine auto-answers notes, so this shape only reaches clients on the
      // wizard methods; the chat result still has to accept it losslessly.
      name: "note carrying a device code and an external URL",
      step: {
        id: "step-note",
        type: "note",
        title: "Sign in",
        message: "Enter this one-time code on the provider's sign-in page.",
        format: "plain",
        externalUrl: "https://example.com/auth",
        deviceCode: {
          code: "ABCD-EFGH",
          expiresInMinutes: 15,
          message: "Never share this code.",
        },
        executor: "client",
      },
    },
    {
      name: "progress",
      step: {
        id: "step-progress",
        type: "progress",
        message: "Linking your account",
        executor: "gateway",
      },
    },
    {
      name: "action executed by the client",
      step: {
        id: "step-action",
        type: "action",
        title: "Authorize",
        message: "Approve the app in your browser.",
        externalUrl: "https://example.com/authorize",
        executor: "client",
      },
    },
    {
      name: "bounded QR image with a client acknowledgement",
      step: {
        id: "step-qr",
        type: "qr",
        title: "Scan QR code",
        message: "Scan the code, then continue.",
        qrDataUrl,
        expiresInMs: 120_000,
        executor: "client",
      },
    },
  ];

  it.each(steps)("accepts a chat result carrying a $name step", ({ step }) => {
    expect(validate.Check({ ...base, step })).toBe(true);
  });

  it("stays optional for replies with no awaited step", () => {
    expect(validate.Check(base)).toBe(true);
  });

  it("accepts indexed-color QR PNGs with a palette before image data", () => {
    expect(
      validate.Check({
        ...base,
        step: { ...steps.at(-1)?.step, qrDataUrl: indexedQrDataUrl },
      }),
    ).toBe(true);
  });

  it("accepts complete image data split across IDAT chunks and Adam7 passes", () => {
    const splitIdat = pngDataUrl({
      filteredData: Uint8Array.of(0, 0, 0, 0, 0),
      splitIdatAt: 3,
    });
    // A 9x9 RGBA image exercises all seven Adam7 passes (343 filtered bytes).
    const adam7 = pngDataUrl({
      width: 9,
      height: 9,
      interlace: 1,
      filteredData: new Uint8Array(343),
    });

    for (const candidate of [splitIdat, adam7]) {
      expect(
        validate.Check({
          ...base,
          step: { ...steps.at(-1)?.step, qrDataUrl: candidate },
        }),
      ).toBe(true);
    }
  });

  it("rejects a step outside the wizard step contract", () => {
    expect(validate.Check({ ...base, step: { id: "step-bogus", type: "freeform" } })).toBe(false);
  });

  it("rejects an incomplete or gateway-executed QR step", () => {
    expect(validate.Check({ ...base, step: { id: "step-qr", type: "qr" } })).toBe(false);
    expect(
      validate.Check({
        ...base,
        step: {
          ...steps.at(-1)?.step,
          executor: "gateway",
        },
      }),
    ).toBe(false);
  });

  it("rejects fields from unrelated wizard variants on QR steps", () => {
    const unrelatedFields = [
      { initialValue: "secret" },
      { options: [{ value: "secret", label: "Secret" }] },
      { placeholder: "secret" },
      { sensitive: true },
      { format: "plain" },
      { externalUrl: "https://example.com/secret" },
      { deviceCode: { code: "SECRET" } },
    ];
    for (const unrelatedField of unrelatedFields) {
      expect(
        validate.Check({
          ...base,
          step: { ...steps.at(-1)?.step, ...unrelatedField },
        }),
      ).toBe(false);
    }
  });

  it("rejects malformed QR payloads and QR fields on other step types", () => {
    const oversizedQrDataUrl = `data:image/png;base64,${"A".repeat(16_384)}`;
    const invalidQrPngDataUrls = [
      // Zero-width and zero-height IHDR chunks with matching CRCs.
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAAAAAABCAQAAABa3mc8AAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAACAQAAAB+QN+nAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      // Valid-CRC IHDRs exceeding the dimension and decoded-pixel budgets.
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAACAEAAAABAQAAAACNrRhhAAAADElEQVR42mNgGOkAAAECAAEW4NUqAAAAAElFTkSuQmCC",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAACAAAAAQBAQAAAACWIFdMAAABFklEQVR42u3BAQ0AAADCoPdP7WYOoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALgBBT0AAZn9dJoAAAAASUVORK5CYII=",
      // The valid sample with its IDAT removed, and with a corrupted IHDR CRC.
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAAElFTkSuQmCC",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwDAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      // A checksum-correct IDAT chunk whose payload is not a zlib stream.
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAABElEQVTerb7vt/ubQQAAAABJRU5ErkJggg==",
      // An empty IDAT, truncated zlib stream, oversized decoded stream, and invalid filter byte.
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAElEQVQ1rwYeAAAAAElFTkSuQmCC",
      pngDataUrl({
        filteredData: Uint8Array.of(0, 0, 0, 0, 0),
        truncateCompressedBytes: 1,
      }),
      pngDataUrl({ filteredData: Uint8Array.of(0, 0, 0, 0, 0, 0) }),
      pngDataUrl({ filteredData: Uint8Array.of(5, 0, 0, 0, 0) }),
      // Valid-CRC IHDRs with illegal bit depth, color type, or depth/type pairing.
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAwQAAADCzD0TAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAEAAACCwvwwAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABBAIAAABVh77fAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      // Valid-CRC IHDRs with unknown compression, filter, or interlace methods.
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQBAAC03mY1AAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAQCsBz1DAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAJbEm0uAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      // Indexed color without PLTE, PLTE after IDAT, and non-consecutive IDAT chunks.
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAABlBMVEUAAAD///+l2Z/dAAAAAElFTkSuQmCC",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAABElEQVR4nGNgs8N33AAAAAN0RVh0awB2ywTzkAAAAAZJREFUAAAAAgABRHX9OAAAAABJRU5ErkJggg==",
    ];
    expect(
      validate.Check({
        ...base,
        step: { ...steps.at(-1)?.step, qrDataUrl: "data:image/png;base64,not-base64" },
      }),
    ).toBe(false);
    expect(
      validate.Check({
        ...base,
        step: { ...steps.at(-1)?.step, qrDataUrl: "data:image/png;base64,SGVsbG8=" },
      }),
    ).toBe(false);
    expect(
      validate.Check({
        ...base,
        step: { ...steps.at(-1)?.step, qrDataUrl: "data:image/png;base64,iVBORw0KGgp=" },
      }),
    ).toBe(false);
    expect(
      validate.Check({
        ...base,
        step: { ...steps.at(-1)?.step, qrDataUrl: qrDataUrl.slice(0, -1) },
      }),
    ).toBe(false);
    expect(
      validate.Check({
        ...base,
        step: { ...steps.at(-1)?.step, qrDataUrl: oversizedQrDataUrl },
      }),
    ).toBe(false);
    for (const invalidQrPngDataUrl of invalidQrPngDataUrls) {
      expect(
        validate.Check({
          ...base,
          step: { ...steps.at(-1)?.step, qrDataUrl: invalidQrPngDataUrl },
        }),
      ).toBe(false);
    }
    expect(
      validate.Check({
        ...base,
        step: {
          id: "step-text",
          type: "text",
          executor: "client",
          qrDataUrl,
          expiresInMs: 120_000,
        },
      }),
    ).toBe(false);
  });
});
