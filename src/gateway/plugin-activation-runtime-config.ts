// Plugin/channel activation config merge helpers.
// Carries activation enablement into runtime config without copying stale state.
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { AforaConfig } from "../config/types.afora.js";
import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { isRecord } from "../utils.js";

// Activation config carries only operator-controlled enable/allow surfaces into
// runtime config. Other runtime fields stay canonical to avoid stale activation
// state overriding live config reloads.

function mergeChannelActivationSections(params: {
  runtimeConfig: AforaConfig;
  activationConfig: AforaConfig;
}): AforaConfig {
  const activationChannels = params.activationConfig.channels;
  if (!isRecord(activationChannels)) {
    return params.runtimeConfig;
  }

  const runtimeChannels = isRecord(params.runtimeConfig.channels)
    ? params.runtimeConfig.channels
    : {};
  let nextChannels: Record<string, unknown> | undefined;

  for (const [channelId, activationChannel] of Object.entries(activationChannels)) {
    if (!isRecord(activationChannel) || !Object.hasOwn(activationChannel, "enabled")) {
      continue;
    }
    const runtimeChannel = runtimeChannels[channelId];
    const runtimeChannelRecord = isRecord(runtimeChannel) ? runtimeChannel : {};
    nextChannels ??= { ...runtimeChannels };
    nextChannels[channelId] = {
      ...runtimeChannelRecord,
      enabled: activationChannel.enabled,
    };
  }

  if (nextChannels === undefined) {
    return params.runtimeConfig;
  }
  return {
    ...params.runtimeConfig,
    channels: nextChannels as AforaConfig["channels"],
  };
}

function mergePluginActivationSections(params: {
  runtimeConfig: AforaConfig;
  activationConfig: AforaConfig;
}): AforaConfig {
  const activationPlugins = params.activationConfig.plugins;
  if (!isRecord(activationPlugins)) {
    return params.runtimeConfig;
  }

  const runtimePlugins = isRecord(params.runtimeConfig.plugins) ? params.runtimeConfig.plugins : {};
  let nextPlugins: Record<string, unknown> | undefined;

  if (Array.isArray(activationPlugins.allow)) {
    nextPlugins = {
      ...runtimePlugins,
      allow: [...activationPlugins.allow],
    };
  }

  const activationEntries = activationPlugins.entries;
  if (isRecord(activationEntries)) {
    const runtimeEntries = isRecord(runtimePlugins.entries) ? runtimePlugins.entries : {};
    let nextEntries: Record<string, unknown> | undefined;
    for (const [pluginId, activationEntry] of Object.entries(activationEntries)) {
      if (!isRecord(activationEntry) || !Object.hasOwn(activationEntry, "enabled")) {
        continue;
      }
      const runtimeEntry = runtimeEntries[pluginId];
      const runtimeEntryRecord = isRecord(runtimeEntry) ? runtimeEntry : {};
      nextEntries ??= { ...runtimeEntries };
      nextEntries[pluginId] = {
        ...runtimeEntryRecord,
        enabled: activationEntry.enabled,
      };
    }
    if (nextEntries !== undefined) {
      nextPlugins = {
        ...runtimePlugins,
        ...nextPlugins,
        entries: nextEntries,
      };
    }
  }

  if (nextPlugins === undefined) {
    return params.runtimeConfig;
  }
  return {
    ...params.runtimeConfig,
    plugins: nextPlugins as AforaConfig["plugins"],
  };
}

/** Merges plugin/channel activation enablement into the runtime config shape. */
export function mergeActivationSectionsIntoRuntimeConfig(params: {
  runtimeConfig: AforaConfig;
  activationConfig: AforaConfig;
}): AforaConfig {
  return mergePluginActivationSections({
    ...params,
    runtimeConfig: mergeChannelActivationSections(params),
  });
}

// Resolves the effective plugin config the gateway startup *plan* is built from:
// auto-enable the operator activation source, then merge those activation sections into
// the runtime config (so runtime/defaulted fields survive). This is the exact assembly
// `prepareGatewayPluginBootstrap` uses (non-minimal branch); sharing it keeps any consumer
// that recomputes the startup plan — notably the `/status plugins` should-run drift check —
// from drifting away from real gateway boot. Behavior-preserving extraction only.
export function resolveGatewayStartupPluginActivationConfig(params: {
  runtimeConfig: AforaConfig;
  activationSourceConfig: AforaConfig;
  env: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
  discovery?: PluginDiscoveryResult;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}): AforaConfig {
  return mergeActivationSectionsIntoRuntimeConfig({
    runtimeConfig: params.runtimeConfig,
    activationConfig: applyPluginAutoEnable({
      config: params.activationSourceConfig,
      env: params.env,
      ...(params.manifestRegistry ? { manifestRegistry: params.manifestRegistry } : {}),
      discovery: params.discovery,
      ambientEnvTriggers: params.ambientEnvTriggers,
    }).config,
  });
}

/** Re-derives source-owned plugin activation and carries it into one reload candidate. */
export function resolveGatewayReloadPluginActivationCandidate(params: {
  runtimeConfig: AforaConfig;
  sourceConfig: AforaConfig;
  env: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
  discovery?: PluginDiscoveryResult;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}): { runtimeConfig: AforaConfig; compareConfig: AforaConfig } {
  const activationConfig = applyPluginAutoEnable({
    config: params.sourceConfig,
    env: params.env,
    ...(params.manifestRegistry ? { manifestRegistry: params.manifestRegistry } : {}),
    discovery: params.discovery,
    ambientEnvTriggers: params.ambientEnvTriggers,
  }).config;
  return {
    runtimeConfig: mergeActivationSectionsIntoRuntimeConfig({
      runtimeConfig: params.runtimeConfig,
      activationConfig,
    }),
    compareConfig: activationConfig,
  };
}
