import type { InboundEnvelope, ProviderAdapter, ProviderContext, SendContext, WaitContext, WatchContext } from "../types.js";
type ScriptWatchIterator = AsyncIterableIterator<InboundEnvelope> & {
    [Symbol.asyncIterator](): ScriptWatchIterator;
    return(): Promise<IteratorResult<InboundEnvelope, undefined>>;
    throw(error?: unknown): Promise<IteratorResult<InboundEnvelope, undefined>>;
};
export declare class ScriptProviderAdapter implements ProviderAdapter {
    #private;
    readonly id: string;
    readonly platform: "bluebubbles" | "discord" | "feishu" | "googlechat" | "imessage" | "irc" | "line" | "loopback" | "matrix" | "mattermost" | "msteams" | "nextcloudtalk" | "nostr" | "signal" | "slack" | "synologychat" | "telegram" | "tlon" | "twitch" | "webchat" | "whatsapp" | "zalo" | "zalouser";
    readonly status: "bridge";
    readonly supports: ("agent" | "probe" | "roundtrip" | "send")[];
    constructor(context: ProviderContext);
    normalizeTarget(target: ProviderContext["fixture"]["target"]): import("../types.js").NormalizedTarget;
    probe(context: ProviderContext): Promise<{
        details: string[];
        healthy: boolean;
    }>;
    send(context: SendContext): Promise<{
        accepted: boolean;
        messageId: string;
        threadId: string;
    }>;
    waitForInbound(context: WaitContext): Promise<{
        author: "assistant" | "system" | "user";
        id: string;
        raw?: unknown;
        sentAt: string;
        text: string;
        threadId: string;
        provider: string;
    } | null>;
    watch(context: WatchContext): ScriptWatchIterator;
}
export {};
