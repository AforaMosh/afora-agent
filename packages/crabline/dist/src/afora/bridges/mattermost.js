import { canonicalConversationIdForInbound, createAdminInboundRequest, createAforaCrablineProviderBridge, DEFAULT_ACCOUNT_ID, isRecord, qaTargetForInbound, readNonBlankString, readString, } from "../shared.js";
import { mattermostId } from "../../servers/mattermost.js";
function nativeId(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        throw new Error("Mattermost target is required.");
    }
    return /^[a-z0-9]{26}$/u.test(trimmed) ? trimmed : mattermostId(trimmed);
}
function directChannelId(botUserId, userId) {
    return mattermostId(`dm:${[botUserId, userId].sort().join(":")}`);
}
function targetKey(channelId, rootId) {
    return rootId ? `${channelId}:thread:${rootId}` : channelId;
}
function threadRootId(channelId, value) {
    const trimmed = value.trim();
    return /^[a-z0-9]{26}$/u.test(trimmed) ? trimmed : mattermostId(`thread:${channelId}:${trimmed}`);
}
export const MATTERMOST_AFORA_CRABLINE_PROVIDER_BRIDGE = createAforaCrablineProviderBridge({
    provider: "mattermost",
    createAdapter(mattermost) {
        return {
            async probe(signal) {
                const response = await fetch(`${mattermost.endpoints.apiRoot}/users/me`, {
                    headers: { authorization: `Bearer ${mattermost.botToken}` },
                    ...(signal ? { signal } : {}),
                });
                if (!response.ok) {
                    throw new Error(`Crabline Mattermost probe failed with HTTP ${response.status}.`);
                }
                const payload = await response.json();
                if (!isRecord(payload) ||
                    readString(payload.id) !== mattermost.botUserId ||
                    !readNonBlankString(payload.username) ||
                    typeof payload.update_at !== "number" ||
                    !Number.isSafeInteger(payload.update_at) ||
                    payload.update_at < 0) {
                    throw new Error("Crabline Mattermost users/me probe returned an unexpected user.");
                }
                return payload;
            },
            createBinding() {
                return {
                    accountId: DEFAULT_ACCOUNT_ID,
                    channel: "mattermost",
                    createChannelDriverSmokeEnv: (env) => ({ ...env, ...mattermost.env }),
                    createGatewayConfig: (aforaConfig = {}) => {
                        const channels = isRecord(aforaConfig.channels) ? aforaConfig.channels : {};
                        const mattermostConfig = isRecord(channels.mattermost) ? channels.mattermost : {};
                        return {
                            ...aforaConfig,
                            channels: {
                                ...channels,
                                mattermost: {
                                    ...mattermostConfig,
                                    allowFrom: ["*"],
                                    baseUrl: mattermost.baseUrl,
                                    botToken: mattermost.botToken,
                                    chatmode: "onmessage",
                                    dmPolicy: "open",
                                    enabled: true,
                                    groupAllowFrom: ["*"],
                                    groupPolicy: "open",
                                    network: { dangerouslyAllowPrivateNetwork: true },
                                    streaming: { mode: "off" },
                                },
                            },
                        };
                    },
                    requiredPluginIds: ["mattermost"],
                };
            },
            createAgentDelivery(parsed) {
                if (parsed.threadId) {
                    throw new Error("Mattermost thread targets require Afora QA thread forwarding.");
                }
                const id = nativeId(parsed.id);
                const to = parsed.kind === "direct" ? `user:${id}` : `channel:${id}`;
                return { channel: "mattermost", replyChannel: "mattermost", replyTo: to, to };
            },
            createInbound(input) {
                const kind = input.conversation.kind === "direct" ? "direct" : "group";
                const conversationId = canonicalConversationIdForInbound(input);
                if (!conversationId) {
                    throw new Error("Mattermost conversation id is required.");
                }
                const senderId = nativeId(input.senderId);
                const channelId = kind === "direct"
                    ? directChannelId(mattermost.botUserId, senderId)
                    : nativeId(conversationId);
                const rootId = input.threadId ? threadRootId(channelId, input.threadId) : undefined;
                return {
                    ...createAdminInboundRequest(mattermost),
                    providerBody: {
                        channelId,
                        channelType: kind === "direct" ? "D" : "O",
                        ...(rootId ? { rootId } : {}),
                        senderId,
                        ...(input.senderName ? { senderName: input.senderName } : {}),
                        text: input.text,
                    },
                    providerTargetKey: targetKey(channelId, rootId),
                    qaTarget: qaTargetForInbound(input),
                    stateConversation: { id: conversationId, kind },
                    ...(rootId ? { threadId: rootId } : {}),
                };
            },
            createOutboundFromRecorderEvent({ event, targetByProviderTarget }) {
                if (!isRecord(event) ||
                    event.type !== "api" ||
                    event.method !== "POST" ||
                    event.path !== "/api/v4/posts" ||
                    !isRecord(event.body)) {
                    return null;
                }
                const channelId = readString(event.body.channel_id);
                const rootId = readString(event.body.root_id);
                const text = readNonBlankString(event.body.message);
                if (!channelId || !text) {
                    return null;
                }
                const target = targetByProviderTarget.get(targetKey(channelId, rootId));
                if (!target) {
                    return null;
                }
                return {
                    accountId: DEFAULT_ACCOUNT_ID,
                    senderId: mattermost.botUserId,
                    senderName: "Afora QA",
                    text,
                    to: target,
                };
            },
        };
    },
});
