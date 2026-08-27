export const AFORA_TOOLS_MCP_AGENT_SESSION_KEY_ENV = "AFORA_TOOLS_MCP_AGENT_SESSION_KEY";

export function resolveToolsMcpAgentSessionKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[AFORA_TOOLS_MCP_AGENT_SESSION_KEY_ENV]?.trim() || undefined;
}
