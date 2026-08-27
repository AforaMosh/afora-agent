/**
 * Standalone MCP server for selected built-in Afora tools.
 *
 * Run via: node --import tsx src/mcp/afora-tools-serve.ts
 * Or: bun src/mcp/afora-tools-serve.ts
 */
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createCronTool } from "../agents/tools/cron-tool.js";
import { createSystemAgentTool } from "../agents/tools/system-agent-tool.js";
import type { SystemAgentToolOptions } from "../agents/tools/system-agent-tool.js";
import { getRuntimeConfig } from "../config/config.js";
import type { AforaConfig } from "../config/types.afora.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  AFORA_TOOLS_MCP_AGENT_SESSION_KEY_ENV,
  resolveToolsMcpAgentSessionKey,
} from "./agent-session-env.js";
import {
  resolveAforaToolsMcpSystemAgentApproval,
  resolveAforaToolsMcpSystemAgentSurface,
  resolveAforaToolsMcpToolSelection,
  type AforaToolsMcpToolId,
} from "./afora-tools-serve-config.js";
import { connectToolsMcpServerToStdio, createToolsMcpServer } from "./tools-stdio-server.js";

export {
  AFORA_TOOLS_MCP_SYSTEM_AGENT_SURFACE_ENV,
  AFORA_TOOLS_MCP_TOOLS_ENV,
} from "./afora-tools-serve-config.js";

export { AFORA_TOOLS_MCP_AGENT_SESSION_KEY_ENV } from "./agent-session-env.js";

export function resolveAforaToolsMcpAgentSessionKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveToolsMcpAgentSessionKey(env);
}

export function resolveAforaToolsForMcp(
  params: {
    agentSessionKey?: string;
    tools?: AforaToolsMcpToolId[];
    systemAgentSurface?: SystemAgentToolOptions["surface"];
    config?: AforaConfig;
  } = {},
): AnyAgentTool[] {
  const selection = params.tools ?? resolveAforaToolsMcpToolSelection();
  return selection.map((tool) => {
    if (tool === "afora") {
      return createSystemAgentTool({
        surface: params.systemAgentSurface ?? resolveAforaToolsMcpSystemAgentSurface(),
        ...resolveAforaToolsMcpSystemAgentApproval(),
      });
    }
    const agentSessionKey = (
      params.agentSessionKey ?? resolveAforaToolsMcpAgentSessionKey()
    )?.trim();
    if (!agentSessionKey) {
      throw new Error(`${AFORA_TOOLS_MCP_AGENT_SESSION_KEY_ENV} is required`);
    }
    return createCronTool({
      agentSessionKey,
      // Same host-config resolution as plugin-tools-serve: the advertised cron
      // surface must reflect this deployment's cron.triggers.enabled gate.
      config: params.config ?? getRuntimeConfig(),
      creatorToolAllowlist: [{ name: AUTOMATIONS_TOOL_NAME }],
    });
  });
}

function createAforaToolsMcpServer(
  params: {
    tools?: AnyAgentTool[];
  } = {},
): Server {
  const tools = params.tools ?? resolveAforaToolsForMcp();
  return createToolsMcpServer({ name: "afora-tools", tools });
}

async function serveAforaToolsMcp(): Promise<void> {
  const server = createAforaToolsMcpServer();
  await connectToolsMcpServerToStdio(server);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  serveAforaToolsMcp().catch((err: unknown) => {
    process.stderr.write(`afora-tools-serve: ${formatErrorMessage(err)}\n`);
    process.exit(1);
  });
}
