import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
export declare function resolveZaloAdapterConfig(config: ProviderConfig, env?: NodeJS.ProcessEnv): {
    botToken: string;
    webhookSecret: string | undefined;
};
export declare class ZaloProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
    constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown);
}
export declare function normalizeZaloWebhookPayload(payload: unknown): {
    author?: "assistant" | "system" | "user" | undefined;
    authorIsBot?: boolean;
    id?: string | undefined;
    raw: {};
    text?: string | undefined;
};
