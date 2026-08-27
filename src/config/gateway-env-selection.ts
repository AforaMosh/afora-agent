import { collectConfigRuntimeEnvVars } from "./env-vars.js";
import type { AforaConfig } from "./types.js";

export const GATEWAY_CONFIG_SELECTION_ENV_KEYS: ReadonlySet<string> = new Set([
  "ANDROID_DATA",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "AFORA_AGENT_DIR",
  "AFORA_CONFIG_PATH",
  "AFORA_HOME",
  "AFORA_INCLUDE_ROOTS",
  "AFORA_NIX_MODE",
  "AFORA_OAUTH_DIR",
  "AFORA_PACKAGE_DIR",
  "AFORA_PROFILE",
  "AFORA_STATE_DIR",
  "AFORA_WORKSPACE_DIR",
  "PI_CODING_AGENT_DIR",
  "PREFIX",
  "USERPROFILE",
]);

/** Rejects config.env changes that would retarget a running Gateway process. */
export function assertGatewayConfigEnvSelectionUnchanged(
  previousConfig: AforaConfig,
  nextConfig: AforaConfig,
): void {
  const normalize = (config: AforaConfig) =>
    new Map(
      Object.entries(collectConfigRuntimeEnvVars(config)).map(([key, value]) => [
        key.toUpperCase(),
        value,
      ]),
    );
  const previous = normalize(previousConfig);
  const next = normalize(nextConfig);
  for (const key of GATEWAY_CONFIG_SELECTION_ENV_KEYS) {
    if (previous.get(key) !== next.get(key)) {
      throw new Error(
        `Config env cannot change process-stable Gateway selector ${key} during reload. Restart with the target environment instead.`,
      );
    }
  }
}
