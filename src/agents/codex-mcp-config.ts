/**
 * Projects enabled bundle MCP servers into Codex app-server thread config.
 * The projection keeps loopback approval defaults and header env placeholders
 * compatible with Codex's MCP config shape.
 */
import crypto from "node:crypto";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import type { SessionToolOverrides } from "../config/sessions/types.js";
import {
  loadEnabledBundleMcpConfig,
  type BundleMcpConfig,
  type BundleMcpServerConfig,
} from "../plugins/bundle-mcp.js";
import { isRecord } from "../utils.js";
import { shouldCreateBundleMcpRuntimeForAttempt } from "./agent-bundle-mcp-attempt-gate.js";
import {
  decodeHeaderEnvPlaceholder,
  normalizeBundleMcpServerConfig,
  normalizeStringRecord,
} from "./bundle-mcp-adapter.js";
import type {
  CodexBundleMcpThreadConfig,
  CodexMcpServersConfig,
  LoadCodexBundleMcpThreadConfigParams,
} from "./codex-mcp-config.types.js";
import {
  normalizeCodexMcpToolApprovalMode,
  resolveEffectiveCodexMcpToolApprovalMode,
} from "./mcp-codex-tool-approval.js";
import { partitionMcpServersByConnectionScope } from "./mcp-connection-resolver.js";

function readCodexProjectionConfig(server: BundleMcpServerConfig): Record<string, unknown> {
  return isRecord(server.codex) ? server.codex : {};
}

function resolveCodexDefaultToolsApprovalMode(
  server: BundleMcpServerConfig,
): ReturnType<typeof normalizeCodexMcpToolApprovalMode> {
  const codex = readCodexProjectionConfig(server);
  return (
    normalizeCodexMcpToolApprovalMode(codex.defaultToolsApprovalMode) ??
    normalizeCodexMcpToolApprovalMode(codex.default_tools_approval_mode)
  );
}

function normalizeToolFilterList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function assertCodexExactToolFilters(
  serverName: string,
  fieldName: "include" | "exclude",
  patterns: string[],
): void {
  const wildcard = patterns.find((pattern) => pattern.includes("*"));
  if (!wildcard) {
    return;
  }
  const codexFieldName = fieldName === "include" ? "enabled_tools" : "disabled_tools";
  throw new Error(
    `Cannot project mcp.servers.${serverName}.toolFilter.${fieldName} pattern "${wildcard}" into Codex ${codexFieldName}: Codex MCP projection only supports exact tool names.`,
  );
}

function applyCodexToolFilter(
  next: Record<string, unknown>,
  name: string,
  server: BundleMcpServerConfig,
): void {
  if (!isRecord(server.toolFilter)) {
    return;
  }
  const include = normalizeToolFilterList(server.toolFilter.include);
  const exclude = normalizeToolFilterList(server.toolFilter.exclude);
  assertCodexExactToolFilters(name, "include", include);
  assertCodexExactToolFilters(name, "exclude", exclude);
  if (include.length > 0) {
    next.enabled_tools = include;
  }
  if (exclude.length > 0) {
    next.disabled_tools = exclude;
  }
}

/** Adds exact session denials to a server's configured filter before Codex projection. */
export function applyCodexSessionMcpToolDenials(
  name: string,
  server: BundleMcpServerConfig,
  toolOverrides?: Pick<SessionToolOverrides, "mcpToolsDeny">,
): BundleMcpServerConfig {
  const denialMap = toolOverrides?.mcpToolsDeny;
  const denied = denialMap && Object.hasOwn(denialMap, name) ? denialMap[name] : undefined;
  if (!denied?.length) {
    return server;
  }
  const toolFilter = isRecord(server.toolFilter) ? server.toolFilter : {};
  const existing = normalizeToolFilterList(toolFilter.exclude);
  return {
    ...server,
    toolFilter: {
      ...toolFilter,
      exclude: [...new Set([...existing, ...denied])].toSorted(),
    },
  };
}

/** Normalizes one bundle MCP server into Codex's mcp_servers shape. */
export function normalizeCodexMcpServerConfig(
  name: string,
  server: BundleMcpServerConfig,
): Record<string, unknown> {
  const next = normalizeBundleMcpServerConfig(server);
  applyCodexToolFilter(next, name, server);
  const defaultToolsApprovalMode = resolveCodexDefaultToolsApprovalMode(server);
  if (defaultToolsApprovalMode) {
    next.default_tools_approval_mode = defaultToolsApprovalMode;
  } else if (resolveEffectiveCodexMcpToolApprovalMode(name, server) !== "auto") {
    // Preserve the shipped loopback exception unless plugin metadata selected
    // another mode; other omissions remain Codex's native `auto` default.
    next.default_tools_approval_mode = resolveEffectiveCodexMcpToolApprovalMode(name, server);
  }
  const httpHeaders = normalizeStringRecord(server.headers);
  if (httpHeaders) {
    const staticHeaders: Record<string, string> = {};
    const envHeaders: Record<string, string> = {};
    for (const [nameLocal, value] of Object.entries(httpHeaders)) {
      const decoded = decodeHeaderEnvPlaceholder(value);
      if (!decoded) {
        staticHeaders[nameLocal] = value;
        continue;
      }
      if (decoded.bearer && normalizeOptionalLowercaseString(nameLocal) === "authorization") {
        // Codex has a dedicated bearer token env field for Authorization headers.
        next.bearer_token_env_var = decoded.envVar;
        continue;
      }
      envHeaders[nameLocal] = decoded.envVar;
    }
    if (Object.keys(staticHeaders).length > 0) {
      next.http_headers = staticHeaders;
    }
    if (Object.keys(envHeaders).length > 0) {
      next.env_http_headers = envHeaders;
    }
  }
  return next;
}

/**
 * Build Codex `mcp_servers` config from normalized bundle MCP config.
 * Requester-scoped servers are excluded: harness-native MCP clients are
 * session-shared and must never dial placeholder or requester-bound URLs.
 */
export function buildCodexMcpServersConfig(config: BundleMcpConfig): CodexMcpServersConfig {
  const { staticServers } = partitionMcpServersByConnectionScope(config.mcpServers);
  return Object.fromEntries(
    Object.entries(staticServers).map(([name, server]) => [
      name,
      normalizeCodexMcpServerConfig(name, server),
    ]),
  );
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableJsonValue(child)]),
  );
}

function fingerprintCodexMcpServersConfig(config: CodexMcpServersConfig): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableJsonValue(config)))
    .digest("hex");
}

/** Load bundle MCP config for one Codex app-server thread. */
export function loadCodexBundleMcpThreadConfig(
  params: LoadCodexBundleMcpThreadConfigParams,
): CodexBundleMcpThreadConfig {
  const shouldCreateRuntime = shouldCreateBundleMcpRuntimeForAttempt({
    toolsEnabled: params.toolsEnabled ?? true,
    disableTools: params.disableTools,
    toolsAllow: params.toolsAllow,
  });
  if (!shouldCreateRuntime) {
    return {
      diagnostics: [],
      evaluated: true,
    };
  }
  const bundleMcp = loadEnabledBundleMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  const configuredMcp = normalizeConfiguredMcpServers(params.cfg?.mcp?.servers);
  const serverOverrides = params.toolOverrides?.mcpServers;
  const mcpServers = buildCodexMcpServersConfig({
    mcpServers: Object.fromEntries(
      Object.entries(bundleMcp.config.mcpServers)
        .filter(([name]) => {
          const override =
            serverOverrides && Object.hasOwn(serverOverrides, name)
              ? serverOverrides[name]
              : undefined;
          return (
            override !== false && (override === true || configuredMcp[name]?.enabled !== false)
          );
        })
        .map(([name, server]) => [
          name,
          applyCodexSessionMcpToolDenials(name, server, params.toolOverrides),
        ]),
    ),
  });
  if (Object.keys(mcpServers).length === 0) {
    return {
      diagnostics: bundleMcp.diagnostics,
      evaluated: true,
    };
  }
  return {
    configPatch: {
      mcp_servers: mcpServers,
    },
    diagnostics: bundleMcp.diagnostics,
    evaluated: true,
    fingerprint: fingerprintCodexMcpServersConfig(mcpServers),
  };
}
