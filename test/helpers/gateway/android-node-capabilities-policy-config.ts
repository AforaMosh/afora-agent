// Android node capability policy config fixture describes gateway policy config.
import { asRecord } from "@afora/normalization-core/record-coerce";
import type { AforaConfig } from "../../../src/config/config.js";

// Test helper for unwrapping gateway config.get response shapes.

/** Unwrap current and legacy remote config snapshot envelopes. */
export function unwrapRemoteConfigSnapshot(raw: unknown): AforaConfig {
  const rawObj = asRecord(raw);
  const resolved = asRecord(rawObj.resolved);
  if (Object.keys(resolved).length > 0) {
    return resolved as AforaConfig;
  }

  const wrapped = asRecord(rawObj.config);
  if (Object.keys(wrapped).length > 0) {
    return wrapped as AforaConfig;
  }

  const legacyPayload = asRecord(rawObj.payload);
  const legacyResolved = asRecord(legacyPayload.resolved);
  if (Object.keys(legacyResolved).length > 0) {
    return legacyResolved as AforaConfig;
  }

  const legacyConfig = asRecord(legacyPayload.config);
  if (Object.keys(legacyConfig).length > 0) {
    return legacyConfig as AforaConfig;
  }

  if (Object.keys(rawObj).length > 0 && !Object.hasOwn(rawObj, "payload")) {
    return rawObj as AforaConfig;
  }

  throw new Error("remote gateway config.get returned empty config payload");
}
