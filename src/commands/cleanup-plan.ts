// Resolves cleanup inputs from current Afora config and state paths.
import {
  readConfigFileSnapshot,
  readSourceConfigBestEffort,
  resolveConfigPath,
  resolveOAuthDir,
  resolveStateDir,
} from "../config/config.js";
import { formatConfigIssueSummary } from "../config/issue-format.js";
import type { AforaConfig } from "../config/types.afora.js";
import type { RuntimeEnv } from "../runtime.js";
import { buildCleanupPlan } from "./cleanup-utils.js";

function affectsWorkspaceDiscovery(path: string): boolean {
  return (
    path === "agents.defaults.workspace" ||
    (path.startsWith("agents.entries.") && path.endsWith(".workspace"))
  );
}

function buildCleanupPlanForConfig(cfg: AforaConfig) {
  const stateDir = resolveStateDir();
  const configPath = resolveConfigPath();
  const oauthDir = resolveOAuthDir();
  const plan = buildCleanupPlan({ cfg, stateDir, configPath, oauthDir });
  return { cfg, stateDir, configPath, oauthDir, ...plan };
}

/** Build a read-only cleanup preview without recording config health state. */
export async function resolveCleanupPlanForDryRun() {
  return buildCleanupPlanForConfig(await readSourceConfigBestEffort());
}

/** Resolve destructive cleanup inputs without mutating the state being guarded. */
export async function resolveCleanupPlanForRemoval(runtime: RuntimeEnv) {
  const snapshot = await readConfigFileSnapshot({ observe: false, pluginValidation: "core-only" });
  const workspaceWarnings = snapshot.warnings.filter((issue) =>
    affectsWorkspaceDiscovery(issue.path),
  );
  if (!snapshot.valid || workspaceWarnings.length > 0) {
    const issues = snapshot.valid ? workspaceWarnings : snapshot.issues;
    const issueSummary = formatConfigIssueSummary(issues) ?? "configuration read failed";
    runtime.error(
      `Cannot safely remove Afora state because workspace configuration could not be resolved: ${issueSummary}. Fix the configuration and retry.`,
    );
    runtime.exit(1);
    return undefined;
  }
  return buildCleanupPlanForConfig(snapshot.runtimeConfig);
}
