import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { InboundEnvelope, ProbeResult, ProviderAdapter, ProviderContext, SendContext, SendResult, WaitContext, WatchContext } from "../types.js";
type NormalizedWhatsAppWebhookMessage = {
    author?: "assistant" | "system" | "user";
    authorIsBot?: boolean;
    id?: string;
    message?: {
        author?: "assistant" | "system" | "user";
        authorIsBot?: boolean;
        id?: string;
        raw?: unknown;
        sentAt?: string;
        text?: string;
        threadId?: string;
    };
    raw?: unknown;
    sentAt?: string;
    text?: string;
    threadId?: string;
};
export declare function resolveWhatsAppAdapterConfig(config: ProviderConfig, env?: NodeJS.ProcessEnv): {
    accessToken: string;
    appSecret: string;
    phoneNumberId: string;
    verifyToken: string;
};
export declare class WhatsAppProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
    #private;
    constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown);
    probe(context: ProviderContext): Promise<ProbeResult>;
    send(context: SendContext): Promise<SendResult>;
    waitForInbound(context: WaitContext): Promise<InboundEnvelope | null>;
    watch(context: WatchContext): AsyncIterable<InboundEnvelope>;
    beginCleanup(): void;
    cleanup(): Promise<void>;
}
export declare function normalizeWhatsAppWebhookPayload(payload: unknown, expectedPhoneNumberId?: string): NormalizedWhatsAppWebhookMessage[];
export {};
