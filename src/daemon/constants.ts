/** Cross-platform daemon service names, labels, and profile-aware descriptions. */
import { normalizeLowercaseStringOrEmpty } from "@afora/normalization-core/string-coerce";

// Default service labels (canonical + legacy compatibility)
export const GATEWAY_LAUNCH_AGENT_LABEL = "ai.afora.gateway";
const GATEWAY_SYSTEMD_SERVICE_NAME = "afora-gateway";
const GATEWAY_WINDOWS_TASK_NAME = "Afora Gateway";
export const GATEWAY_SERVICE_MARKER = "afora";
export const GATEWAY_SERVICE_KIND = "gateway";
export const GATEWAY_SERVICE_RUNTIME_PID_ENV = "AFORA_GATEWAY_SERVICE_PID";
export const GATEWAY_SERVICE_SELECTOR_ENV_KEYS = [
  "AFORA_STATE_DIR",
  "AFORA_CONFIG_PATH",
  "AFORA_PROFILE",
  "AFORA_GATEWAY_PORT",
  "AFORA_LAUNCHD_LABEL",
  "AFORA_SYSTEMD_UNIT",
  "AFORA_WINDOWS_TASK_NAME",
] as const;

export function isGatewayServiceEnv(env: Record<string, string | undefined>): boolean {
  if (env.AFORA_SERVICE_MARKER?.trim() !== GATEWAY_SERVICE_MARKER) {
    return false;
  }
  const serviceKind = env.AFORA_SERVICE_KIND?.trim();
  return !serviceKind || serviceKind === GATEWAY_SERVICE_KIND;
}

const NODE_LAUNCH_AGENT_LABEL = "ai.afora.node";
const NODE_SYSTEMD_SERVICE_NAME = "afora-node";
const NODE_WINDOWS_TASK_NAME = "Afora Node";
const NODE_SERVICE_MARKER = "afora";
export const NODE_SERVICE_KIND = "node";
const NODE_WINDOWS_TASK_SCRIPT_NAME = "node.cmd";
export const LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES: string[] = ["clawdbot-gateway"];

function normalizeGatewayProfile(profile?: string): string | null {
  const trimmed = profile?.trim();
  if (!trimmed || normalizeLowercaseStringOrEmpty(trimmed) === "default") {
    // The default profile keeps the historical unqualified service names.
    return null;
  }
  return trimmed;
}

export function resolveGatewayProfileSuffix(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  return normalized ? `-${normalized}` : "";
}

export function resolveGatewayLaunchAgentLabel(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  if (!normalized) {
    return GATEWAY_LAUNCH_AGENT_LABEL;
  }
  return `ai.afora.${normalized}`;
}

export function resolveLegacyGatewayLaunchAgentLabels(profile?: string): string[] {
  void profile;
  return [];
}

export function resolveGatewaySystemdServiceName(profile?: string): string {
  const suffix = resolveGatewayProfileSuffix(profile);
  if (!suffix) {
    return GATEWAY_SYSTEMD_SERVICE_NAME;
  }
  return `afora-gateway${suffix}`;
}

export function resolveGatewayWindowsTaskName(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  if (!normalized) {
    return GATEWAY_WINDOWS_TASK_NAME;
  }
  return `Afora Gateway (${normalized})`;
}

type GatewayNativeServiceIdentityConflict = {
  envKey: "AFORA_LAUNCHD_LABEL" | "AFORA_SYSTEMD_UNIT" | "AFORA_WINDOWS_TASK_NAME";
  expected: string;
};

export function resolveGatewayNativeServiceIdentityConflict(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): GatewayNativeServiceIdentityConflict | null {
  const profile = normalizeGatewayProfile(env.AFORA_PROFILE);
  if (!profile) {
    return null;
  }

  if (platform === "darwin") {
    const envKey = "AFORA_LAUNCHD_LABEL";
    const actual = env[envKey]?.trim();
    const expected = resolveGatewayLaunchAgentLabel(profile);
    return actual && actual !== expected ? { envKey, expected } : null;
  }
  if (platform === "linux") {
    const envKey = "AFORA_SYSTEMD_UNIT";
    const actual = env[envKey]?.trim();
    const normalizedActual = actual?.endsWith(".service") ? actual : actual && `${actual}.service`;
    const expected = `${resolveGatewaySystemdServiceName(profile)}.service`;
    return normalizedActual && normalizedActual !== expected ? { envKey, expected } : null;
  }
  if (platform === "win32") {
    const envKey = "AFORA_WINDOWS_TASK_NAME";
    const actual = env[envKey]?.trim();
    const expected = resolveGatewayWindowsTaskName(profile);
    return actual && actual !== expected ? { envKey, expected } : null;
  }
  return null;
}

function formatGatewayServiceDescription(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  if (!normalized) {
    return "Afora Gateway";
  }
  return `Afora Gateway (profile: ${normalized})`;
}

export function resolveGatewayServiceDescription(params: {
  env: Record<string, string | undefined>;
  description?: string;
}): string {
  return params.description ?? formatGatewayServiceDescription(params.env.AFORA_PROFILE);
}

export function resolveNodeLaunchAgentLabel(): string {
  return NODE_LAUNCH_AGENT_LABEL;
}

export function resolveNodeSystemdServiceName(): string {
  return NODE_SYSTEMD_SERVICE_NAME;
}

export function resolveNodeWindowsTaskName(): string {
  return NODE_WINDOWS_TASK_NAME;
}

export function resolveNodeServiceIdentityEnvironment(): Record<string, string> {
  return {
    AFORA_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
    AFORA_SYSTEMD_UNIT: resolveNodeSystemdServiceName(),
    AFORA_WINDOWS_TASK_NAME: resolveNodeWindowsTaskName(),
    AFORA_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
    AFORA_TASK_SCRIPT_NAME: NODE_WINDOWS_TASK_SCRIPT_NAME,
    AFORA_LOG_PREFIX: "node",
    AFORA_SERVICE_MARKER: NODE_SERVICE_MARKER,
    AFORA_SERVICE_KIND: NODE_SERVICE_KIND,
  };
}
