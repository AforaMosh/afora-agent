// Tlon plugin module implements doctor contract behavior.
import { createLegacyPrivateNetworkDoctorContract } from "afora-agent/plugin-sdk/runtime-doctor-migrations";

const contract = createLegacyPrivateNetworkDoctorContract({
  channelKey: "tlon",
});

export const legacyConfigRules = contract.legacyConfigRules;

export const normalizeCompatibilityConfig = contract.normalizeCompatibilityConfig;
