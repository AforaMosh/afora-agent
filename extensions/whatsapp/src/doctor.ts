// Whatsapp plugin module implements doctor behavior.
import type {
  ChannelDoctorAdapter,
  ChannelDoctorConfigMutation,
} from "afora-agent/plugin-sdk/channel-contract";
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: AforaConfig;
}): ChannelDoctorConfigMutation {
  return { config: cfg, changes: [] };
}

export const whatsappDoctor: ChannelDoctorAdapter = {
  normalizeCompatibilityConfig,
};
