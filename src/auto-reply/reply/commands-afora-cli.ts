// Formats Afora CLI command snippets for chat-facing command responses.
import { resolveCurrentAforaCliInvocation } from "../../infra/afora-cli-invocation.js";

const TEST_RUNNER_ENV_PREFIXES = ["VITEST_", "AFORA_VITEST_"];

function quoteShellArg(value: string): string {
  if (process.platform === "win32") {
    return `'${value.replaceAll("'", "''")}'`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Reconstructs the current Afora CLI invocation with extra args. */
export function buildCurrentAforaCliArgv(args: string[]): string[] {
  const invocation = resolveCurrentAforaCliInvocation(args);
  return [invocation.command, ...invocation.args];
}

/** Clears test-runner env inherited by harness-hosted gateways before spawning the CLI. */
export function buildCurrentAforaCliExecEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const overrides: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    if (key === "VITEST" || TEST_RUNNER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      overrides[key] = "";
    }
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/** Builds a shell-quoted command string for rerunning the current Afora CLI. */
export function buildCurrentAforaCliCommand(args: string[]): string {
  return buildCurrentAforaCliArgv(args).map(quoteShellArg).join(" ");
}
