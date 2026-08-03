// Resolves configured open inbound policies for security audit consumers.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** List configured open group/DM policy paths across channel-owned nested scopes. */
export function listConfiguredOpenInboundPolicyPaths(cfg: OpenClawConfig): string[] {
  const channels = asNullableRecord(cfg.channels);
  if (!channels) {
    return [];
  }
  const paths = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (value: unknown, scope: string): void => {
    const record = asNullableRecord(value);
    if (!record || seen.has(record)) {
      return;
    }
    seen.add(record);
    if (record.groupPolicy === "open") {
      paths.add(`${scope}.groupPolicy`);
    }
    const legacyDmPolicy = asNullableRecord(record.dm)?.policy;
    const dmPolicy = record.dmPolicy ?? legacyDmPolicy;
    if (dmPolicy === "open") {
      paths.add(`${scope}.${record.dmPolicy == null ? "dm.policy" : "dmPolicy"}`);
    }
    for (const [key, nested] of Object.entries(record)) {
      // Nested dm.policy is the legacy spelling for this scope, not a child scope.
      if (key !== "dm" && asNullableRecord(nested)) {
        visit(nested, `${scope}.${key}`);
      }
    }
  };
  for (const [channelId, channel] of Object.entries(channels)) {
    visit(channel, `channels.${channelId}`);
  }
  return [...paths].toSorted();
}
