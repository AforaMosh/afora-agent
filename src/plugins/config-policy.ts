// Evaluates plugin config policy without activating plugin runtime code.
import type { AforaConfig } from "../config/types.afora.js";
import {
  resolvePluginActivationDecisionShared,
  toPluginActivationState,
  type PluginActivationStateLike,
} from "./config-activation-shared.js";
import {
  identityNormalizePluginId,
  isBundledChannelEnabledByChannelConfig as isBundledChannelEnabledByChannelConfigShared,
  normalizePluginsConfigWithResolverCore as normalizePluginsConfigWithResolverShared,
  type NormalizePluginId,
  type NormalizedPluginsConfig as SharedNormalizedPluginsConfig,
} from "./config-normalization-shared.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

type PluginActivationState = PluginActivationStateLike;

type NormalizedPluginsConfig = SharedNormalizedPluginsConfig;

export function normalizePluginsConfigWithResolver(
  config?: AforaConfig["plugins"],
  normalizePluginId: NormalizePluginId = identityNormalizePluginId,
): NormalizedPluginsConfig {
  return normalizePluginsConfigWithResolverShared(config, normalizePluginId);
}

function resolvePluginActivationState(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: AforaConfig;
  enabledByDefault?: boolean;
  sourceConfig?: NormalizedPluginsConfig;
  sourceRootConfig?: AforaConfig;
  autoEnabledReason?: string;
}): PluginActivationState {
  return toPluginActivationState(
    resolvePluginActivationDecisionShared({
      ...params,
      activationSource: {
        plugins: params.sourceConfig ?? params.config,
        rootConfig: params.sourceRootConfig ?? params.rootConfig,
      },
      isBundledChannelEnabledByChannelConfig,
    }),
  );
}

const isBundledChannelEnabledByChannelConfig = isBundledChannelEnabledByChannelConfigShared;

type PolicyEffectiveActivationParams = {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: AforaConfig;
  enabledByDefault?: boolean;
  sourceConfig?: NormalizedPluginsConfig;
  sourceRootConfig?: AforaConfig;
  autoEnabledReason?: string;
};

export function resolvePolicyPluginActivationState(
  params: PolicyEffectiveActivationParams,
): PluginActivationState {
  return resolvePluginActivationState(params);
}
