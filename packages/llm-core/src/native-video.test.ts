import { describe, expect, it } from "vitest";
import {
  createNativeVideoAdmissionAccumulator,
  decodedBase64Bytes,
  estimateNativeVideoTokens,
  resolveNativeVideoInputContract,
  validateNativeVideoContent,
} from "./native-video.js";
import type { NativeVideoInputContract } from "./types.js";

const contract = {
  wireFamily: "google-inline-data",
  mimeTypes: {
    "video/mp4": "video/mp4",
    "video/quicktime": "video/mov",
  },
  maxDecodedBytesPerItem: 5,
  maxItems: 1,
  maxAggregateDecodedBytes: 5,
  aggregateScope: "all-inline-media",
  maxSerializedRequestBytesExclusive: 100,
} as const satisfies NativeVideoInputContract;

describe("native video contract", () => {
  it("accepts only strict padded base64 and reports decoded bytes", () => {
    expect(decodedBase64Bytes("dmlkZW8=")).toBe(5);
    expect(decodedBase64Bytes("dmlkZW8")).toBeUndefined();
    expect(decodedBase64Bytes("dmlk ZW8=")).toBeUndefined();
  });

  it("uses one bounded estimate for decoded bytes and canonical base64", () => {
    const data = Buffer.alloc(2_048_000).toString("base64");
    expect(estimateNativeVideoTokens({ base64: data, minimumTokens: 1200 })).toBe(4000);
    expect(estimateNativeVideoTokens({ decodedBytes: 2_048_000, minimumTokens: 1200 })).toBe(4000);
    expect(estimateNativeVideoTokens({ base64: "invalid", minimumTokens: 1200 })).toBe(1200);
    expect(estimateNativeVideoTokens({ decodedBytes: 100_000_000, minimumTokens: 1200 })).toBe(
      32_768,
    );
  });

  it("validates multi-megabyte video payloads without regex stack growth", () => {
    const data = Buffer.alloc(6 * 1024 * 1024, 1).toString("base64");
    expect(decodedBase64Bytes(data)).toBe(6 * 1024 * 1024);
  });

  it("canonicalizes finite MIME aliases and rejects generic or undocumented video MIME", () => {
    expect(
      validateNativeVideoContent(contract, {
        mimeType: "video/quicktime",
        data: "dmlkZW8=",
      }),
    ).toEqual({ ok: true, decodedBytes: 5, wireMimeType: "video/mov" });
    expect(
      validateNativeVideoContent(contract, { mimeType: "video/x-m4v", data: "dmlkZW8=" }),
    ).toEqual({ ok: false, reason: "mime" });
    expect(validateNativeVideoContent(contract, { mimeType: "video/*", data: "dmlkZW8=" })).toEqual(
      { ok: false, reason: "mime" },
    );
  });

  it("requires the prepared embedded OpenClaw harness contract", () => {
    expect(resolveNativeVideoInputContract({ nativeVideoInput: contract })).toBe(contract);
    expect(resolveNativeVideoInputContract({})).toBeUndefined();
    expect(
      resolveNativeVideoInputContract({
        nativeVideoInput: { ...contract, maxItems: 0 },
      }),
    ).toBeUndefined();
  });

  it("owns request-scoped item, count, and aggregate admission", () => {
    const admission = createNativeVideoAdmissionAccumulator({ contract });
    expect(admission.assessDecodedBytes(6)).toBe("item-size");
    expect(admission.admit({ mimeType: "video/quicktime", data: "dmlkZW8=" })).toEqual({
      ok: true,
      decodedBytes: 5,
      wireMimeType: "video/mov",
    });
    expect(admission.admit({ mimeType: "video/mp4", data: "dmlkZW8=" })).toEqual({
      ok: false,
      reason: "count",
    });
  });

  it("seeds all-inline-media aggregate bytes before video admission", () => {
    const admission = createNativeVideoAdmissionAccumulator({
      contract,
      initialAggregateDecodedBytes: 1,
    });
    expect(admission.admit({ mimeType: "video/mp4", data: "dmlkZW8=" })).toEqual({
      ok: false,
      reason: "aggregate",
    });
  });
});
