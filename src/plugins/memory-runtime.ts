// Runtime bridge for plugin-owned memory hooks and state.
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MemoryAccessContext } from "../memory-host-sdk/host/authorization.js";
import { resolveUserPath } from "../utils.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import { normalizePluginsConfig } from "./config-state.js";
import {
  brandAuthorizedMemoryPlan,
  isTrustedMemoryAccessContext,
  MemoryAccessContextError,
} from "./memory-access-context.js";
import { admitMemoryAuthorizationReadRuntime } from "./memory-authorization-runtime.js";
import { emitMemoryAuthorizationShadowSurfaceInspection } from "./memory-authorization-shadow.js";
import { getMemoryRuntime } from "./memory-state.js";
import { ensureStandaloneRuntimePluginRegistryLoaded } from "./runtime/standalone-runtime-registry-loader.js";

/** Resolves the configured memory slot to the single runtime plugin that may load memory. */
function resolveMemoryRuntimePluginIds(config: OpenClawConfig): string[] {
  const plugins = normalizePluginsConfig(config.plugins);
  const memorySlot = plugins.slots.memory;
  if (!plugins.enabled || typeof memorySlot !== "string" || memorySlot.trim().length === 0) {
    return [];
  }
  const pluginId = memorySlot.trim();
  if (plugins.deny.includes(pluginId) || plugins.entries[pluginId]?.enabled === false) {
    return [];
  }
  return [pluginId];
}

function resolveMemoryRuntimeWorkspaceDir(cfg: OpenClawConfig): string | undefined {
  const agentId = resolveDefaultAgentId(cfg);
  const dir = resolveAgentWorkspaceDir(cfg, agentId);
  if (typeof dir !== "string" || !dir.trim()) {
    return undefined;
  }
  return resolveUserPath(dir);
}

function ensureMemoryRuntime(cfg?: OpenClawConfig) {
  const current = getMemoryRuntime();
  if (current || !cfg) {
    if (current) {
      emitMemoryAuthorizationShadowSurfaceInspection(current);
    }
    return current;
  }
  const onlyPluginIds = resolveMemoryRuntimePluginIds(cfg);
  if (onlyPluginIds.length === 0) {
    return getMemoryRuntime();
  }
  getLoadedRuntimePluginRegistry({ requiredPluginIds: onlyPluginIds });
  const loadedRuntime = getMemoryRuntime();
  if (loadedRuntime) {
    emitMemoryAuthorizationShadowSurfaceInspection(loadedRuntime);
    return loadedRuntime;
  }
  const workspaceDir = resolveMemoryRuntimeWorkspaceDir(cfg);
  ensureStandaloneRuntimePluginRegistryLoaded({
    requiredPluginIds: onlyPluginIds,
    loadOptions: {
      config: cfg,
      onlyPluginIds,
      workspaceDir,
    },
  });
  const standaloneRuntime = getMemoryRuntime();
  if (standaloneRuntime) {
    emitMemoryAuthorizationShadowSurfaceInspection(standaloneRuntime);
  }
  return standaloneRuntime;
}

/** Returns the active plugin-backed memory search manager for an agent. */
export async function getActiveMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status" | "cli";
}) {
  const runtime = ensureMemoryRuntime(params.cfg);
  if (!runtime) {
    return { manager: null, error: "memory plugin unavailable" };
  }
  return await runtime.getMemorySearchManager(params);
}

/** Resolves current memory backend config without constructing a manager. */
export function resolveActiveMemoryBackendConfig(params: { cfg: OpenClawConfig; agentId: string }) {
  return ensureMemoryRuntime(params.cfg)?.resolveMemoryBackendConfig(params) ?? null;
}

/**
 * Acquires and authorizes the selected Phase 1B read runtime without touching the legacy manager.
 * QMD remains unavailable until it supplies its own isolated conformance proof.
 */
export async function authorizeActiveMemoryAccess(params: {
  cfg: OpenClawConfig;
  context: MemoryAccessContext;
}) {
  if (
    !isTrustedMemoryAccessContext(params.context) ||
    params.context.agentId !== params.context.agentId.trim()
  ) {
    throw new MemoryAccessContextError("invalid-context");
  }
  const runtime = ensureMemoryRuntime(params.cfg);
  if (!runtime) {
    return {
      runtime: null,
      plan: null,
      error: "authorized memory plugin unavailable",
    } as const;
  }
  const backend = runtime.resolveMemoryBackendConfig({
    cfg: params.cfg,
    agentId: params.context.agentId,
  });
  if (backend.backend !== "builtin") {
    return {
      runtime: null,
      plan: null,
      error: "authorized memory backend unavailable",
    } as const;
  }
  const admission = await admitMemoryAuthorizationReadRuntime(runtime);
  if (!admission.ok) {
    return {
      runtime: null,
      plan: null,
      error: "authorized memory backend nonconforming",
    } as const;
  }
  const issuedPlan = await admission.runtime.authorize(params.context);
  const plan = brandAuthorizedMemoryPlan({ context: params.context, plan: issuedPlan });
  return { runtime: admission.runtime, plan } as const;
}

/** Closes all active plugin-backed memory search managers. */
export async function closeActiveMemorySearchManagers(cfg?: OpenClawConfig): Promise<void> {
  void cfg;
  const runtime = getMemoryRuntime();
  await runtime?.closeAllMemorySearchManagers?.();
}

/** Closes the plugin-backed memory search manager for one agent. */
export async function closeActiveMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  const runtime = getMemoryRuntime();
  await runtime?.closeMemorySearchManager?.(params);
}
