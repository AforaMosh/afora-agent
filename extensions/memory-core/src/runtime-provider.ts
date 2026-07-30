// Memory Core provider module implements model/runtime integration.
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryBackendConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  builtinScopedMemoryConformanceAdapter,
  MEMORY_CORE_AUTHORIZATION_CAPABILITIES,
} from "./authorization.js";
import {
  closeAllMemorySearchManagers,
  closeMemorySearchManager,
  getMemorySearchManager,
} from "./memory/index.js";
import type { MemoryCoreRuntimeHost } from "./memory/runtime-host.js";
import { createBuiltinScopedMemoryRuntime } from "./memory/scoped-memory-runtime.js";

export function createMemoryRuntime(host: MemoryCoreRuntimeHost = {}): MemoryPluginRuntime {
  const authorizedRuntime = createBuiltinScopedMemoryRuntime();
  return {
    authorization: MEMORY_CORE_AUTHORIZATION_CAPABILITIES,
    authorizationConformance: builtinScopedMemoryConformanceAdapter,
    authorize: authorizedRuntime.authorize,
    searchAuthorized: authorizedRuntime.searchAuthorized,
    readAuthorized: authorizedRuntime.readAuthorized,
    async getMemorySearchManager(params) {
      const { manager, debug, error } = await getMemorySearchManager({
        ...params,
        ...(host.acquireLocalService ? { acquireLocalService: host.acquireLocalService } : {}),
        ...(host.withLease ? { withLease: host.withLease } : {}),
      });
      return {
        manager,
        debug,
        error,
      };
    },
    resolveMemoryBackendConfig(params) {
      return resolveMemoryBackendConfig(params);
    },
    async closeAllMemorySearchManagers() {
      await closeAllMemorySearchManagers();
    },
    async closeMemorySearchManager(params) {
      await closeMemorySearchManager(params);
    },
  };
}

export const memoryRuntime = createMemoryRuntime();
