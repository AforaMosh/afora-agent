import { resolveAgentWorkspaceDir, tryResolveSoleAgentId } from "../agents/agent-scope.js";
import { isLegacyParentWritableUpdateDoctorPass } from "../commands/doctor/shared/update-phase.js";
import type { AforaConfig } from "../config/types.afora.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

export function isUpdateDoctorRun(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
  const value = env.AFORA_UPDATE_IN_PROGRESS;
  return value === "1" || value === "true";
}

export function resolveDoctorMode(cfg: AforaConfig): "local" | "remote" {
  return cfg.gateway?.mode === "remote" ? "remote" : "local";
}
export function resolveDoctorWorkspaceDir(cfg: AforaConfig, env = process.env) {
  const agentId = tryResolveSoleAgentId(cfg);
  return agentId ? resolveAgentWorkspaceDir(cfg, agentId, env) : undefined;
}

export function resolveLegacyParentVersionOverride(ctx: DoctorHealthFlowContext): {
  lastTouchedVersionOverride?: string;
} {
  if (!isLegacyParentWritableUpdateDoctorPass(ctx.env ?? process.env)) {
    return {};
  }
  const version = ctx.configResult.sourceLastTouchedVersion?.trim();
  return version ? { lastTouchedVersionOverride: version } : {};
}
