// Telegram plugin module implements sticker vision behavior.
import {
  findModelInCatalog,
  loadPreparedModelCatalog,
  modelSupportsVision,
  resolveAgentDir,
  resolveDefaultModelForAgent,
} from "afora-agent/plugin-sdk/agent-runtime";
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";

export async function resolveStickerVisionSupportRuntime(params: {
  cfg: AforaConfig;
  agentId?: string;
}): Promise<boolean> {
  const catalog = await loadPreparedModelCatalog({
    config: params.cfg,
    ...(params.agentId
      ? {
          agentId: params.agentId,
          agentDir: resolveAgentDir(params.cfg, params.agentId),
        }
      : {}),
    readOnly: true,
  });
  const defaultModel = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
  if (!entry) {
    return false;
  }
  return modelSupportsVision(entry);
}
