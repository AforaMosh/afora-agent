// Bundled-discovery compatibility is machine-owned upgrade state.
import { readConfigMachineState } from "../state/config-machine-state.js";
import type { AforaStateDatabaseOptions } from "../state/afora-state-db.js";
import {
  hasActivePluginInstallRoots,
  resolveActivePluginInstallRoots,
} from "./install-root-context.js";

export function readBundledDiscoveryMode(
  options: AforaStateDatabaseOptions = {},
): "compat" | "allowlist" | undefined {
  const resolvedOptions =
    options.path || options.database || !hasActivePluginInstallRoots()
      ? options
      : {
          ...options,
          env: {
            ...(options.env ?? process.env),
            AFORA_STATE_DIR: resolveActivePluginInstallRoots(options.env).stateDir,
          },
        };
  const value = readConfigMachineState<unknown>("plugins.bundledDiscovery", resolvedOptions);
  return value === "compat" || value === "allowlist" ? value : undefined;
}
