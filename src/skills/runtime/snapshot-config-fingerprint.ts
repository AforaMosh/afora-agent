import crypto from "node:crypto";
import { stableStringify } from "@afora/normalization-core";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import type { AforaConfig } from "../../config/types.afora.js";

let configFingerprints = new WeakMap<AforaConfig, string>();

export function fingerprintSkillSnapshotConfig(config: AforaConfig): string {
  const cached = configFingerprints.get(config);
  if (cached) {
    return cached;
  }
  const fingerprint = crypto
    .createHash("sha256")
    .update(stableStringify(redactConfigObject(config)))
    .digest("hex");
  configFingerprints.set(config, fingerprint);
  return fingerprint;
}

export function resetSkillSnapshotConfigFingerprintCache(): void {
  configFingerprints = new WeakMap();
}
