import type { ProviderConfig, ProviderPlatform } from "../config/schema.js";
import type { InboundEnvelope, NormalizedTarget, ProbeResult, ProviderAdapter, ProviderContext, SendContext, SendResult, WaitContext, WatchContext } from "./types.js";
export { createGenericLocalMockTargetCodec } from "./target-normalizers.js";
export type LocalMockWebhookConfig = {
    host?: string;
    path?: string;
    port?: number;
    publicUrl?: string | undefined;
};
export type LocalMockAdapterOptions = {
    authenticateWebhookRequest?: (request: Request, rawBody: string) => Promise<Response | undefined> | Response | undefined;
    createWebhookSuccessResponse?: (payload: unknown, id: string) => Promise<Response> | Response;
    defaultWebhook: Required<Pick<LocalMockWebhookConfig, "host" | "path" | "port">>;
    endpointLabel: string;
    matchesThread?: (candidateThreadId: string, expectedThreadId: string | undefined, target: NormalizedTarget, raw?: unknown) => boolean;
    handleWebhookPayload?: (payload: unknown, request: Request, rawBody: string) => Promise<Response | undefined> | Response | undefined;
    normalizeWebhookPayload?: (payload: unknown) => unknown;
    platform: ProviderPlatform;
    publicUrl?: string | undefined;
    recorderPath?: string | undefined;
    settleWebhookRequest?: (params: {
        accepted: boolean;
        payload: unknown;
        rawBody: string;
    }) => void;
    webhook?: LocalMockWebhookConfig | undefined;
};
export type LocalMockTargetCodec = {
    normalize(target: ProviderContext["fixture"]["target"]): NormalizedTarget;
    resolveThreadId(target: ProviderContext["fixture"]["target"]): string;
};
export declare class LocalMockProviderAdapter implements ProviderAdapter {
    #private;
    readonly id: string;
    readonly platform: "bluebubbles" | "discord" | "feishu" | "googlechat" | "imessage" | "irc" | "line" | "loopback" | "matrix" | "mattermost" | "msteams" | "nextcloudtalk" | "nostr" | "signal" | "slack" | "synologychat" | "telegram" | "tlon" | "twitch" | "webchat" | "whatsapp" | "zalo" | "zalouser";
    readonly status: "ready";
    readonly supports: ProviderAdapter["supports"];
    constructor(params: {
        codec: LocalMockTargetCodec;
        config: ProviderConfig;
        id: string;
        options: LocalMockAdapterOptions;
    });
    normalizeTarget(target: ProviderContext["fixture"]["target"]): NormalizedTarget;
    probe(context: ProviderContext): Promise<ProbeResult>;
    send(context: SendContext): Promise<SendResult>;
    waitForInbound(context: WaitContext): Promise<InboundEnvelope | null>;
    watch(context: WatchContext): AsyncIterable<InboundEnvelope>;
    cleanup(): Promise<void>;
}
