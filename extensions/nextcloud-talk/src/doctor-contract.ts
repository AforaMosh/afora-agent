// Nextcloud Talk plugin module implements doctor contract behavior.
import type { ChannelDoctorConfigMutation } from "afora-agent/plugin-sdk/channel-contract";
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
import {
  createLegacyPrivateNetworkDoctorContract,
  defineChannelAliasMigration,
} from "afora-agent/plugin-sdk/runtime-doctor-migrations";

const networkContract = createLegacyPrivateNetworkDoctorContract({
  channelKey: "nextcloud-talk",
});

// Nextcloud Talk's nested streaming schema is delivery-only ({chunkMode,
// block}); it has no preview mode, so only the delivery flat aliases are
// legal legacy input. Account merge replaces the root streaming object
// wholesale (resolveMergedAccountConfig without a streaming deep-merge), so
// migration seeds materialized account objects with inherited root settings.
const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "nextcloud-talk",
  streaming: { defaultMode: "partial", deliveryOnly: true },
  accountStreamingReplacesRoot: true,
});

export const legacyConfigRules = [
  ...networkContract.legacyConfigRules,
  ...streamingAliasMigration.legacyConfigRules,
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: AforaConfig;
}): ChannelDoctorConfigMutation {
  const network = networkContract.normalizeCompatibilityConfig({ cfg });
  return streamingAliasMigration.normalizeChannelConfig({
    cfg: network.config,
    changes: network.changes,
  });
}
