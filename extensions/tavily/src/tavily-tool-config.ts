// Tavily helper module supports tavily tool config behavior.
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
import type { AforaPluginToolContext } from "afora-agent/plugin-sdk/plugin-entry";
import type { AforaPluginApi } from "afora-agent/plugin-sdk/plugin-runtime";

export type TavilyToolConfigContext = Pick<
  AforaPluginToolContext,
  "config" | "runtimeConfig" | "getRuntimeConfig"
>;

export function resolveTavilyToolConfig(
  api: AforaPluginApi,
  ctx?: TavilyToolConfigContext,
): AforaConfig {
  return ctx?.getRuntimeConfig?.() ?? ctx?.runtimeConfig ?? ctx?.config ?? api.config;
}
