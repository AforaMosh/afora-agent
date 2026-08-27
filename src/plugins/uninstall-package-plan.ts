import type { AforaConfig } from "../config/types.afora.js";

const PLUGIN_PACKAGE_UNINSTALL_PLAN = Symbol.for("afora.pluginPackageUninstallPlan");

type PluginPackageUninstallPlanMetadata = {
  runtimePluginIds: readonly string[];
  runtimeLoadPaths?: readonly string[];
};

export function recordPluginPackageUninstallPlan<T extends object>(
  params: T,
  metadata: PluginPackageUninstallPlanMetadata,
): T {
  Object.defineProperty(params, PLUGIN_PACKAGE_UNINSTALL_PLAN, {
    configurable: false,
    enumerable: true,
    value: metadata,
  });
  return params;
}

export function resolvePluginPackageUninstallPlan(
  params: object,
): PluginPackageUninstallPlanMetadata | undefined {
  return (params as { [PLUGIN_PACKAGE_UNINSTALL_PLAN]?: PluginPackageUninstallPlanMetadata })[
    PLUGIN_PACKAGE_UNINSTALL_PLAN
  ];
}

export function prepareConfigForPendingPluginDirectoryRemovalSet(
  config: AforaConfig,
  pluginIds: readonly string[],
): AforaConfig {
  const entries = { ...config.plugins?.entries };
  for (const entryId of new Set(pluginIds)) {
    entries[entryId] = {
      ...entries[entryId],
      enabled: false,
    };
  }
  return {
    ...config,
    plugins: {
      ...config.plugins,
      entries,
    },
  };
}
