/**
 * Afora-owned tool registration filters.
 *
 * Keeps optional tool gating separate from tool construction so config and execution contracts decide exposure.
 */
import { uniqueStrings } from "@afora/normalization-core/string-normalization";
import type { AforaConfig } from "../config/types.afora.js";
import { isPrimaryBootstrapRun } from "./bootstrap-routing.js";
import { isToolAllowedByPolicyName } from "./tool-policy-match.js";
import { expandShippedCoreToolPolicyNames } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

/**
 * Registration helpers for optional Afora-owned tools.
 *
 * This keeps model/runtime gating separate from tool construction so callers can
 * assemble candidate tools first, then filter by config and execution contract.
 */
/** Drops disabled optional tools while preserving candidate order. */
export function collectPresentAforaTools(
  candidates: readonly (AnyAgentTool | null | undefined)[],
): AnyAgentTool[] {
  return candidates.filter((tool): tool is AnyAgentTool => tool !== null && tool !== undefined);
}

/** Decides whether progress_card should be included in the assembled Afora tool set. */
export function shouldIncludeProgressCardToolForAforaTools(params: {
  config?: AforaConfig;
  pluginToolDenylist?: string[];
}): boolean {
  // `tools.updatePlan` is the shipped kill switch for the replacement progress_card tool.
  if (params.config?.tools?.updatePlan === false) {
    return false;
  }
  const deny = uniqueStrings([
    ...(params.config?.tools?.deny ?? []),
    ...(params.pluginToolDenylist ?? []),
  ]);
  return isToolAllowedByPolicyName("progress_card", {
    deny: expandShippedCoreToolPolicyNames(deny),
  });
}

/** Includes ask_user only on a primary session and when normal deny policy permits it. */
export function shouldIncludeAskUserToolForAforaTools(params: {
  config?: AforaConfig;
  agentSessionKey?: string;
  pluginToolDenylist?: string[];
}): boolean {
  const sessionKey = params.agentSessionKey?.trim();
  if (!sessionKey) {
    return false;
  }
  const deny = uniqueStrings([
    ...(params.config?.tools?.deny ?? []),
    ...(params.pluginToolDenylist ?? []),
  ]);
  return isPrimaryBootstrapRun(sessionKey) && isToolAllowedByPolicyName("ask_user", { deny });
}
