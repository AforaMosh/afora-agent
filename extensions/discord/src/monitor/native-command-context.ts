import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
// Discord plugin module implements native command context behavior.
import type { CommandArgs } from "openclaw/plugin-sdk/command-auth-native";
import { resolveDiscordConversationIdentity } from "../conversation-identity.js";
import type { DiscordChannelConfigResolved, DiscordGuildEntryResolved } from "./allow-list.js";
import { buildDiscordInboundAccessContext } from "./inbound-context.js";
import type { DiscordInboundRuntime } from "./inbound-runtime.js";

type BuildDiscordNativeCommandContextParams = {
  prompt: string;
  commandArgs: CommandArgs;
  agentId: string;
  sessionKey: string;
  commandTargetSessionKey: string;
  accountId?: string | null;
  interactionId: string;
  channelId: string;
  threadParentId?: string;
  memberRoleIds?: string[];
  guildId?: string;
  guildName?: string;
  channelTopic?: string;
  channelConfig?: DiscordChannelConfigResolved | null;
  guildInfo?: DiscordGuildEntryResolved | null;
  allowNameMatching?: boolean;
  commandAuthorized: boolean;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  isGuild: boolean;
  isThreadChannel: boolean;
  user: {
    id: string;
    username: string;
    globalName?: string | null;
  };
  sender: {
    id: string;
    name?: string;
    tag?: string;
  };
  timestampMs?: number;
  /** Supplied by live native ingress; omitted only by detached context tests. */
  inbound?: DiscordInboundRuntime;
};

export async function buildDiscordNativeCommandContext(
  params: BuildDiscordNativeCommandContextParams,
) {
  const conversationLabel = params.isDirectMessage
    ? (params.user.globalName ?? params.user.username)
    : params.channelId;
  const { groupSystemPrompt, ownerAllowFrom, channelStructuredContext } =
    buildDiscordInboundAccessContext({
      channelConfig: params.channelConfig,
      guildInfo: params.guildInfo,
      sender: params.sender,
      allowNameMatching: params.allowNameMatching,
      isGuild: params.isGuild,
      channelTopic: params.channelTopic,
    });

  const chatType = params.isDirectMessage ? "direct" : params.isGroupDm ? "group" : "channel";
  const from = params.isDirectMessage
    ? `discord:${params.user.id}`
    : params.isGroupDm
      ? `discord:group:${params.channelId}`
      : `discord:channel:${params.channelId}`;
  // Detached unit callers keep the public builder only to exercise context
  // projection. Live slash ingress receives the paired facade from its command.
  const buildContext = params.inbound?.buildContext ?? buildChannelInboundEventContext;
  return await buildContext({
    channel: "discord",
    accountId: params.accountId ?? undefined,
    messageId: params.interactionId,
    timestamp: params.timestampMs ?? Date.now(),
    from,
    sender: {
      id: params.user.id,
      name: params.user.globalName ?? params.user.username,
      username: params.user.username,
      tag: params.sender.tag,
      roles: params.memberRoleIds,
    },
    conversation: {
      kind: chatType,
      id: params.channelId,
      label: conversationLabel,
      spaceId: params.isGuild
        ? (params.guildInfo?.id ?? params.guildInfo?.slug ?? params.guildId)
        : undefined,
      parentId: params.isThreadChannel ? params.threadParentId : undefined,
      threadId: params.isThreadChannel ? params.channelId : undefined,
      nativeChannelId: params.channelId,
    },
    route: {
      agentId: params.agentId,
      accountId: params.accountId ?? undefined,
      routeSessionKey: params.sessionKey,
      dispatchSessionKey: params.sessionKey,
    },
    reply: {
      to: `slash:${params.user.id}`,
      originatingTo:
        resolveDiscordConversationIdentity({
          isDirectMessage: params.isDirectMessage,
          userId: params.user.id,
          channelId: params.channelId,
        }) ?? (params.isDirectMessage ? `user:${params.user.id}` : `channel:${params.channelId}`),
      nativeChannelId: params.channelId,
      messageThreadId: params.isThreadChannel ? params.channelId : undefined,
      threadParentId: params.isThreadChannel ? params.threadParentId : undefined,
    },
    message: {
      body: params.prompt,
      bodyForAgent: params.prompt,
      rawBody: params.prompt,
      commandBody: params.prompt,
    },
    access: {
      mentions: { canDetectMention: true, wasMentioned: true },
      commands: { authorized: params.commandAuthorized },
    },
    command: {
      kind: "native",
      body: params.prompt,
      authorized: params.commandAuthorized,
    },
    supplemental: { groupSystemPrompt },
    extra: {
      CommandArgs: params.commandArgs,
      CommandTargetSessionKey: params.commandTargetSessionKey,
      GroupSubject: params.isGuild ? params.guildName : undefined,
      ChannelStructuredContext: channelStructuredContext,
      OwnerAllowFrom: ownerAllowFrom,
    },
  });
}
