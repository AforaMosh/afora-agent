/**
 * Default agent workspace resolver.
 *
 * Derives the process workspace directory from env, profile, and home-directory state.
 */
import os from "node:os";
import path from "node:path";
import { normalizeOptionalLowercaseString } from "@afora/normalization-core/string-coerce";
import { resolveProfileStateDir } from "../cli/profile-utils.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";

/** Resolve the default agent workspace directory from env/profile/home state. */
export function resolveDefaultAgentWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const workspaceDir = env.AFORA_WORKSPACE_DIR?.trim();
  if (workspaceDir) {
    return path.resolve(workspaceDir);
  }
  if (env.AFORA_STATE_DIR?.trim()) {
    return path.join(resolveStateDir(env, homedir), "workspace");
  }
  const home = resolveRequiredHomeDir(env, homedir);
  const profile = env.AFORA_PROFILE?.trim();
  if (profile && normalizeOptionalLowercaseString(profile) !== "default") {
    return path.join(resolveProfileStateDir(profile, env, homedir), "workspace");
  }
  return path.join(home, ".afora", "workspace");
}

/** Default agent workspace directory for the current process environment. */
export const DEFAULT_AGENT_WORKSPACE_DIR = resolveDefaultAgentWorkspaceDir();
