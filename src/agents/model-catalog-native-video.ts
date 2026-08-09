import { supportsNativeVideoInput } from "@openclaw/llm-core";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { normalizeProviderResolvedModelWithPlugin } from "../plugins/provider-runtime.runtime.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";

function toCatalogCapabilityRuntimeModel(
  entry: ModelCatalogEntry,
): ProviderRuntimeModel | undefined {
  if (!entry.api || !entry.baseUrl) {
    return undefined;
  }
  const input = (entry.input ?? []).filter(
    (value): value is "text" | "image" | "video" =>
      value === "text" || value === "image" || value === "video",
  );
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.provider,
    api: entry.api,
    baseUrl: entry.baseUrl,
    reasoning: entry.reasoning ?? false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow ?? entry.contextTokens ?? 1,
    maxTokens: 1,
    ...(entry.contextTokens !== undefined ? { contextTokens: entry.contextTokens } : {}),
    ...(entry.params ? { params: entry.params } : {}),
    ...(entry.compat ? { compat: entry.compat } : {}),
    ...(entry.mediaInput ? { mediaInput: entry.mediaInput } : {}),
  };
}

/** Records route-qualified native-video support once for a prepared catalog generation. */
export async function qualifyPreparedModelCatalogNativeVideoRoutes(params: {
  snapshot: ModelCatalogSnapshot;
  routeKey: (entry: ModelCatalogEntry) => string;
  agentDir: string;
  config: OpenClawConfig;
  metadataSnapshot: PluginMetadataSnapshot;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ModelCatalogSnapshot> {
  const supportByRoute = new Map<string, Promise<boolean>>();
  const qualifyEntry = async (entry: ModelCatalogEntry): Promise<ModelCatalogEntry> => {
    const { supportsNativeVideo: _staleSupport, ...route } = entry;
    const runtimeModel = toCatalogCapabilityRuntimeModel(route);
    if (!runtimeModel) {
      return route;
    }
    const routeKey = params.routeKey(route);
    let support = supportByRoute.get(routeKey);
    if (!support) {
      // Normalize the exact physical route once; sibling endpoints must never
      // inherit a contract from the logical provider/model identity.
      support = normalizeProviderResolvedModelWithPlugin({
        provider: route.provider,
        modelId: route.id,
        config: params.config,
        ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
        ...(params.env ? { env: params.env } : {}),
        pluginMetadataSnapshot: params.metadataSnapshot,
        context: {
          config: params.config,
          agentDir: params.agentDir,
          ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
          provider: route.provider,
          modelId: route.id,
          model: runtimeModel,
        },
      }).then(
        (normalized) => supportsNativeVideoInput(normalized ?? runtimeModel),
        // Capability discovery is optional; one broken route must not block catalog publication.
        () => false,
      );
      supportByRoute.set(routeKey, support);
    }
    return (await support) ? { ...route, supportsNativeVideo: true } : route;
  };
  const [entries, routeVariants] = await Promise.all([
    Promise.all(params.snapshot.entries.map(qualifyEntry)),
    Promise.all(params.snapshot.routeVariants.map(qualifyEntry)),
  ]);
  return { ...params.snapshot, entries, routeVariants };
}
