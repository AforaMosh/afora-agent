import { isRecord } from "@openclaw/normalization-core/record-coerce";

const MAX_AUTHORITY_ENTRIES = 256;
const MAX_AUTHORITY_NAMES = 2_048;
const MAX_AUTHORITY_NAME_LENGTH = 256;
const MAX_AUTHORITY_JSON_BYTES = 256 * 1024;

type ScheduledRuntimeAuthorityApp = {
  appId: string;
  allowDestructiveActions: boolean;
  allowOpenWorld: boolean;
  approvalMode: "allow" | "deny" | "auto" | "ask";
};

type ScheduledRuntimeAuthorityMcpServer = {
  source: "openclaw" | "codex";
  serverName: string;
  toolNames: string[];
};

type ScheduledRuntimeAuthorityPluginMcpServer = {
  pluginId: string;
  serverName: string;
  toolNames: string[];
};

/** Durable upper bound for runtime-owned capabilities delegated to a scheduled turn. */
export type ScheduledRuntimeAuthority = {
  version: 1;
  runtime: "codex";
  openClawTools: string[];
  apps: ScheduledRuntimeAuthorityApp[];
  userMcpServers: ScheduledRuntimeAuthorityMcpServer[];
  pluginMcpServers: ScheduledRuntimeAuthorityPluginMcpServer[];
};

function normalizeName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_AUTHORITY_NAME_LENGTH ? normalized : undefined;
}

function normalizeNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_AUTHORITY_ENTRIES) {
    return undefined;
  }
  const names = value.map(normalizeName);
  if (names.some((name) => !name)) {
    return undefined;
  }
  return [...new Set(names as string[])].toSorted();
}

function normalizeMcpServers(
  value: unknown,
  pluginOwned: boolean,
):
  | Array<ScheduledRuntimeAuthorityMcpServer | ScheduledRuntimeAuthorityPluginMcpServer>
  | undefined {
  if (!Array.isArray(value) || value.length > MAX_AUTHORITY_ENTRIES) {
    return undefined;
  }
  const normalized = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) {
      return undefined;
    }
    const source = entry.source;
    const serverName = normalizeName(entry.serverName);
    const toolNames = normalizeNames(entry.toolNames);
    const pluginId = pluginOwned ? normalizeName(entry.pluginId) : undefined;
    if (
      (!pluginOwned && source !== "openclaw" && source !== "codex") ||
      !serverName ||
      !toolNames ||
      (pluginOwned && !pluginId)
    ) {
      return undefined;
    }
    const allowedKeys = pluginOwned
      ? new Set(["pluginId", "serverName", "toolNames"])
      : new Set(["source", "serverName", "toolNames"]);
    if (Object.keys(entry).some((key) => !allowedKeys.has(key))) {
      return undefined;
    }
    const key = `${pluginId ?? ""}\0${serverName}`;
    if (seen.has(key)) {
      return undefined;
    }
    seen.add(key);
    normalized.push(
      pluginId
        ? { pluginId, serverName, toolNames }
        : { source: source as "openclaw" | "codex", serverName, toolNames },
    );
  }
  return normalized.toSorted((left, right) => {
    const leftPlugin = "pluginId" in left && typeof left.pluginId === "string" ? left.pluginId : "";
    const rightPlugin =
      "pluginId" in right && typeof right.pluginId === "string" ? right.pluginId : "";
    return leftPlugin.localeCompare(rightPlugin) || left.serverName.localeCompare(right.serverName);
  });
}

/** Accepts only the closed v1 envelope; unknown or oversized input fails closed. */
export function normalizeScheduledRuntimeAuthority(
  value: unknown,
): ScheduledRuntimeAuthority | undefined {
  if (!isRecord(value) || value.version !== 1 || value.runtime !== "codex") {
    return undefined;
  }
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "version",
          "runtime",
          "openClawTools",
          "apps",
          "userMcpServers",
          "pluginMcpServers",
        ].includes(key),
    )
  ) {
    return undefined;
  }
  const openClawTools = normalizeNames(value.openClawTools);
  const userMcpServers = normalizeMcpServers(value.userMcpServers, false);
  const pluginMcpServers = normalizeMcpServers(value.pluginMcpServers, true);
  if (
    !openClawTools ||
    !userMcpServers ||
    !pluginMcpServers ||
    !Array.isArray(value.apps) ||
    value.apps.length > MAX_AUTHORITY_ENTRIES
  ) {
    return undefined;
  }
  const apps: ScheduledRuntimeAuthorityApp[] = [];
  const seenApps = new Set<string>();
  for (const entry of value.apps) {
    if (!isRecord(entry)) {
      return undefined;
    }
    const appId = normalizeName(entry.appId);
    const approvalMode = entry.approvalMode;
    if (
      !appId ||
      seenApps.has(appId) ||
      typeof entry.allowDestructiveActions !== "boolean" ||
      typeof entry.allowOpenWorld !== "boolean" ||
      (approvalMode !== "allow" &&
        approvalMode !== "deny" &&
        approvalMode !== "auto" &&
        approvalMode !== "ask") ||
      Object.keys(entry).some(
        (key) =>
          !["appId", "allowDestructiveActions", "allowOpenWorld", "approvalMode"].includes(key),
      )
    ) {
      return undefined;
    }
    seenApps.add(appId);
    apps.push({
      appId,
      allowDestructiveActions: entry.allowDestructiveActions,
      allowOpenWorld: entry.allowOpenWorld,
      approvalMode,
    });
  }
  const normalized = {
    version: 1,
    runtime: "codex",
    openClawTools,
    apps: apps.toSorted((left, right) => left.appId.localeCompare(right.appId)),
    userMcpServers: userMcpServers as ScheduledRuntimeAuthorityMcpServer[],
    pluginMcpServers: pluginMcpServers as ScheduledRuntimeAuthorityPluginMcpServer[],
  } satisfies ScheduledRuntimeAuthority;
  const totalNames =
    normalized.openClawTools.length +
    normalized.apps.length +
    normalized.userMcpServers.reduce((sum, server) => sum + 1 + server.toolNames.length, 0) +
    normalized.pluginMcpServers.reduce((sum, server) => sum + 2 + server.toolNames.length, 0);
  if (
    totalNames > MAX_AUTHORITY_NAMES ||
    Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_AUTHORITY_JSON_BYTES
  ) {
    return undefined;
  }
  return normalized;
}

/** Binds the duplicated OpenClaw grant to the canonical persisted payload cap. */
export function bindScheduledRuntimeAuthorityToToolsAllow(params: {
  authority: ScheduledRuntimeAuthority;
  toolsAllow: readonly string[];
}): ScheduledRuntimeAuthority {
  const allowed = new Set(
    params.toolsAllow.map((name) => name.trim().toLowerCase()).filter(Boolean),
  );
  return {
    ...params.authority,
    openClawTools: params.authority.openClawTools.filter((name) =>
      allowed.has(name.trim().toLowerCase()),
    ),
  };
}
