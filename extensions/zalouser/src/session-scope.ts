import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";

export function resolveZalouserDmSessionScope(config: AforaConfig) {
  const configured = config.session?.dmScope;
  return configured === "main" || !configured ? "per-channel-peer" : configured;
}
