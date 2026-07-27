import { isChannelConfigMetadataKey } from "../channels/config-metadata.js";
import { hasMeaningfulChannelConfig } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** True when config contains meaningful enabled channel settings. */
export function hasExplicitChannelConfig(params: {
  config: OpenClawConfig;
  channelId: string;
}): boolean {
  const channels = params.config.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return false;
  }
  const entry = (channels as Record<string, unknown>)[params.channelId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  const enabled = (entry as { enabled?: unknown }).enabled;
  if (enabled === false) {
    return false;
  }
  return enabled === true || hasMeaningfulChannelConfig(entry);
}

/** Lists explicitly configured channel ids, excluding global channel config keys. */
export function listExplicitConfiguredChannelIdsForConfig(config: OpenClawConfig): string[] {
  const channels = config.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return [];
  }
  return Object.keys(channels)
    .flatMap((rawChannelId) => {
      const channelId = rawChannelId.trim();
      return channelId &&
        !isChannelConfigMetadataKey(channelId) &&
        hasExplicitChannelConfig({ config, channelId: rawChannelId })
        ? [channelId]
        : [];
    })
    .toSorted((left, right) => left.localeCompare(right));
}
