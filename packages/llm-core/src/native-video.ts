import type { Model, NativeVideoInputContract, VideoContent } from "./types.js";

export const NATIVE_VIDEO_OMISSION = "(video omitted: unsupported or exceeds provider limits)";
export const NATIVE_TOOL_VIDEO_OMISSION =
  "(tool video omitted: native tool-result video is unsupported)";

export type NativeVideoOmissionReason =
  | "unsupported"
  | "unavailable"
  | "invalid"
  | "mime"
  | "item-size"
  | "count"
  | "aggregate";

const NATIVE_VIDEO_OMISSION_TEXT: Readonly<Record<NativeVideoOmissionReason, string>> = {
  unsupported: "(video omitted: model does not support videos)",
  unavailable: "(video omitted: attachment is unavailable)",
  invalid: "(video omitted: attachment is invalid)",
  mime: "(video omitted: video format is not supported)",
  "item-size": "(video omitted: attachment exceeds the size limit)",
  count: "(video omitted: too many video attachments)",
  aggregate: "(video omitted: total video size exceeds the limit)",
};

export function formatNativeVideoOmission(reason: NativeVideoOmissionReason): string {
  return NATIVE_VIDEO_OMISSION_TEXT[reason];
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isUsableContract(contract: NativeVideoInputContract): boolean {
  return (
    Object.keys(contract.mimeTypes).length > 0 &&
    Object.entries(contract.mimeTypes).every(
      ([input, output]) =>
        input === input.trim().toLowerCase() && input.length > 0 && output.length > 0,
    ) &&
    isPositiveSafeInteger(contract.maxDecodedBytesPerItem) &&
    isPositiveSafeInteger(contract.maxItems) &&
    isPositiveSafeInteger(contract.maxAggregateDecodedBytes) &&
    isPositiveSafeInteger(contract.maxSerializedRequestBytesExclusive)
  );
}

export function resolveNativeVideoInputContract(
  model: Pick<Model, "nativeVideoInput">,
): NativeVideoInputContract | undefined {
  const contract = model.nativeVideoInput;
  return contract && isUsableContract(contract) ? contract : undefined;
}

export function supportsNativeVideoInput(model: Pick<Model, "nativeVideoInput">): boolean {
  return resolveNativeVideoInputContract(model) !== undefined;
}

/** Strict decoded length for canonical padded base64; invalid input returns undefined. */
export function decodedBase64Bytes(data: string): number | undefined {
  if (data.length === 0 || data.length % 4 !== 0) {
    return undefined;
  }
  let padding = 0;
  let sawPadding = false;
  for (let index = 0; index < data.length; index += 1) {
    const code = data.charCodeAt(index);
    if (code === 0x3d) {
      padding += 1;
      if (padding > 2) {
        return undefined;
      }
      sawPadding = true;
      continue;
    }
    const isBase64 =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (sawPadding || !isBase64) {
      return undefined;
    }
  }
  return (data.length / 4) * 3 - padding;
}

const NATIVE_VIDEO_ESTIMATED_BYTES_PER_TOKEN = 512;
const NATIVE_VIDEO_MAX_ESTIMATED_TOKENS = 32_768;

/**
 * Estimates bounded visual-context tokens from canonical decoded bytes or base64.
 * Callers supply their existing image-equivalent floor; transport bytes are never text tokens.
 */
export function estimateNativeVideoTokens(params: {
  base64?: string;
  decodedBytes?: number;
  minimumTokens: number;
}): number {
  const decodedBytes =
    typeof params.decodedBytes === "number" &&
    Number.isSafeInteger(params.decodedBytes) &&
    params.decodedBytes >= 0
      ? params.decodedBytes
      : typeof params.base64 === "string"
        ? (decodedBase64Bytes(params.base64) ?? 0)
        : 0;
  const minimumTokens =
    Number.isFinite(params.minimumTokens) && params.minimumTokens > 0
      ? Math.ceil(params.minimumTokens)
      : 0;
  return Math.min(
    NATIVE_VIDEO_MAX_ESTIMATED_TOKENS,
    Math.max(minimumTokens, Math.ceil(decodedBytes / NATIVE_VIDEO_ESTIMATED_BYTES_PER_TOKEN)),
  );
}

export type NativeVideoValidation =
  | { ok: true; decodedBytes: number; wireMimeType: string }
  | { ok: false; reason: "base64" | "mime" | "item-size" };

export function validateNativeVideoContent(
  contract: NativeVideoInputContract,
  video: Pick<VideoContent, "data" | "mimeType">,
): NativeVideoValidation {
  const wireMimeType = contract.mimeTypes[video.mimeType.trim().toLowerCase()];
  if (!wireMimeType) {
    return { ok: false, reason: "mime" };
  }
  const decodedBytes = decodedBase64Bytes(video.data);
  if (decodedBytes === undefined) {
    return { ok: false, reason: "base64" };
  }
  if (decodedBytes > contract.maxDecodedBytesPerItem) {
    return { ok: false, reason: "item-size" };
  }
  return { ok: true, decodedBytes, wireMimeType };
}

export type NativeVideoAdmission =
  | { ok: true; decodedBytes: number; wireMimeType: string }
  | { ok: false; reason: NativeVideoOmissionReason };

/** Request-scoped MIME, item, count, and aggregate admission for native video. */
export function createNativeVideoAdmissionAccumulator(params: {
  contract?: NativeVideoInputContract;
  wireFamily?: NativeVideoInputContract["wireFamily"];
  initialAggregateDecodedBytes?: number;
}) {
  const contract =
    params.contract && (!params.wireFamily || params.contract.wireFamily === params.wireFamily)
      ? params.contract
      : undefined;
  let admittedCount = 0;
  let aggregateDecodedBytes =
    typeof params.initialAggregateDecodedBytes === "number" &&
    Number.isSafeInteger(params.initialAggregateDecodedBytes) &&
    params.initialAggregateDecodedBytes >= 0
      ? params.initialAggregateDecodedBytes
      : 0;

  const assessDecodedBytes = (decodedBytes: number): NativeVideoOmissionReason | undefined => {
    if (!contract) {
      return "unsupported";
    }
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes < 0) {
      return "invalid";
    }
    if (decodedBytes > contract.maxDecodedBytesPerItem) {
      return "item-size";
    }
    if (admittedCount >= contract.maxItems) {
      return "count";
    }
    if (aggregateDecodedBytes + decodedBytes > contract.maxAggregateDecodedBytes) {
      return "aggregate";
    }
    return undefined;
  };

  return {
    assessDecodedBytes,
    admit(video: Pick<VideoContent, "data" | "mimeType">): NativeVideoAdmission {
      if (!contract) {
        return { ok: false, reason: "unsupported" };
      }
      const validation = validateNativeVideoContent(contract, video);
      if (!validation.ok) {
        return {
          ok: false,
          reason: validation.reason === "base64" ? "invalid" : validation.reason,
        };
      }
      const reason = assessDecodedBytes(validation.decodedBytes);
      if (reason) {
        return { ok: false, reason };
      }
      admittedCount += 1;
      aggregateDecodedBytes += validation.decodedBytes;
      return validation;
    },
  };
}
