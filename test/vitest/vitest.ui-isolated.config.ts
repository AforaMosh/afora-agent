// Vitest ui-isolated config runs jsdom ui tests that need a fresh module graph.
// The shared ui shard runs non-isolated for speed, but tests that spy on module
// internals and assert the component uses that spy must not share a module cache
// with stateful predecessor files (see uiIsolatedTestFiles).
import type { ViteUserConfig } from "vitest/config";
import { controlUiLocaleModulesPlugin } from "../../ui/config/control-ui-locales.ts";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";
import {
  jsdomOptimizedDeps,
  vendoredPrebuiltPackageExternalPatterns,
} from "./vitest.shared.config.ts";
import { uiIsolatedTestFiles } from "./vitest.ui-isolated-paths.mjs";

// Explicit nameable return type: inference reaches vite-internal names (TS4058/TS4082).
export function createUiIsolatedVitestConfig(
  env?: Record<string, string | undefined>,
): ViteUserConfig {
  const config = createScopedVitestConfig(uiIsolatedTestFiles, {
    deps: jsdomOptimizedDeps,
    environment: "jsdom",
    env,
    excludeUnitFastTests: false,
    includeAforaRuntimeSetup: false,
    isolate: true,
    name: "ui-isolated",
    setupFiles: ["ui/src/test-helpers/lit-warnings.setup.ts"],
    useNonIsolatedRunner: false,
  });
  // The vendored prebuilt packages must stay externalized here: this is the one
  // jsdom lane that imports them, and inlining them breaks `import.meta.url`.
  const baseExternal = config.test?.server?.deps?.external;
  return {
    ...config,
    plugins: [...(config.plugins ?? []), controlUiLocaleModulesPlugin()],
    test: {
      ...config.test,
      server: {
        ...config.test?.server,
        deps: {
          ...config.test?.server?.deps,
          external:
            baseExternal === true
              ? true
              : [...(baseExternal ?? []), ...vendoredPrebuiltPackageExternalPatterns],
        },
      },
    },
  };
}

export default createUiIsolatedVitestConfig();
