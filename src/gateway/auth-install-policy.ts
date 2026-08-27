// Gateway install auth policy used by service/install flows.
import { normalizeOptionalString } from "@afora/normalization-core/string-coerce";
import { collectDurableServiceEnvVars } from "../config/state-dir-dotenv.js";
import type { AforaConfig } from "../config/types.afora.js";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";

type GatewayInstallAuthMode = NonNullable<NonNullable<AforaConfig["gateway"]>["auth"]>["mode"];

function hasExplicitGatewayInstallAuthMode(
  mode: GatewayInstallAuthMode | undefined,
): boolean | undefined {
  if (mode === "token") {
    return true;
  }
  if (mode === "password" || mode === "none" || mode === "trusted-proxy") {
    return false;
  }
  return undefined;
}

function hasConfiguredGatewayPasswordForInstall(cfg: AforaConfig): boolean {
  return hasConfiguredSecretInput(cfg.gateway?.auth?.password, cfg.secrets?.defaults);
}

function hasDurableGatewayPasswordEnvForInstall(
  cfg: AforaConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  const durableServiceEnv = collectDurableServiceEnvVars({ env, config: cfg });
  return Boolean(
    normalizeOptionalString(durableServiceEnv.AFORA_GATEWAY_PASSWORD) ||
    normalizeOptionalString(durableServiceEnv.CLAWDBOT_GATEWAY_PASSWORD),
  );
}

/** Decide whether install should require token auth when no durable password source exists. */
export function shouldRequireGatewayTokenForInstall(
  cfg: AforaConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  const explicitModeDecision = hasExplicitGatewayInstallAuthMode(cfg.gateway?.auth?.mode);
  if (explicitModeDecision !== undefined) {
    return explicitModeDecision;
  }

  if (hasConfiguredGatewayPasswordForInstall(cfg)) {
    return false;
  }

  // Service install should only infer password mode from durable sources that
  // survive outside the invoking shell.
  if (hasDurableGatewayPasswordEnvForInstall(cfg, env)) {
    return false;
  }

  return true;
}
