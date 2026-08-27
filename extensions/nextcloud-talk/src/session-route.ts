// Nextcloud Talk plugin module implements session route behavior.
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
import { buildOutboundBaseSessionKey } from "afora-agent/plugin-sdk/routing";
import { stripNextcloudTalkTargetPrefix } from "./normalize.js";

type NextcloudTalkOutboundSessionRouteParams = {
  cfg: AforaConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
};

export function resolveNextcloudTalkOutboundSessionRoute(
  params: NextcloudTalkOutboundSessionRouteParams,
) {
  const roomId = stripNextcloudTalkTargetPrefix(params.target);
  if (!roomId) {
    return null;
  }
  const baseSessionKey = buildOutboundBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "nextcloud-talk",
    accountId: params.accountId,
    peer: {
      kind: "group",
      id: roomId,
    },
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    // Room tokens do not reveal whether inbound keys by room or sender id.
    // Keep delivery behavior, but reject this route for explicit session selection.
    recipientSessionExact: false,
    peer: {
      kind: "group" as const,
      id: roomId,
    },
    chatType: "group" as const,
    from: `nextcloud-talk:room:${roomId}`,
    to: `nextcloud-talk:${roomId}`,
  };
}
