import { normalizeOptionalString } from "@afora/normalization-core/string-coerce";
import type { AforaConfig } from "../../config/types.afora.js";
import type { SkillProposalOrigin, SkillWorkshopRunOptions } from "../../skills/workshop/types.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

export function createConfiguredSkillWorkshopTool(params: {
  workspaceDir: string;
  config?: AforaConfig;
  agentId: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string | number;
  run?: SkillWorkshopRunOptions;
}) {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const runId = normalizeOptionalString(params.runId);
  const messageId = normalizeOptionalString(
    params.messageId === undefined ? undefined : String(params.messageId),
  );
  return createSkillWorkshopTool({
    workspaceDir: params.workspaceDir,
    config: params.config,
    env: params.run?.env,
    agentId: params.agentId,
    origin:
      params.run?.origin ??
      ({
        agentId: params.agentId,
        ...(sessionKey ? { sessionKey } : {}),
        ...(runId ? { runId } : {}),
        ...(messageId ? { messageId } : {}),
      } satisfies SkillProposalOrigin),
    proposalOnly: params.run?.proposalOnly,
    ...(params.run?.updateProposals ? { updateProposals: true } : {}),
    ...(params.run?.autonomousCapture ? { autonomousCapture: true } : {}),
    proposalMutationBudget:
      params.run?.proposalMutationBudget ??
      (params.run?.proposalOnly ? { remaining: 1 } : undefined),
    proposalReviewCompletion: params.run?.proposalReviewCompletion,
    collectionReconcile: params.run?.collectionReconcile,
  });
}
