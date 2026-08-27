import type { AforaConfig } from "../../config/types.afora.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";

export function resolveChatSendStopOwnerScope(params: {
  cfg: AforaConfig;
  selectedAgentId?: string;
  sessionKey: string;
}): { agentId?: string; defaultAgentId?: string } {
  return {
    agentId: params.selectedAgentId,
    defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(params.cfg, params.sessionKey),
  };
}
