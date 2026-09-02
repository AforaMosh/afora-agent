import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
export declare function resolveMattermostAdapterConfig(config: ProviderConfig, env?: NodeJS.ProcessEnv): {
    baseUrl: string;
    botToken: string;
    userName: string | undefined;
};
export declare class MattermostProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
    constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown);
}
export declare function matchesMattermostThread(candidateThreadId: string, expectedThreadId: string | undefined, target: {
    channelId?: string | undefined;
}): boolean;
export declare function normalizeMattermostWebhookPayload(payload: unknown): {
    author?: "assistant" | "system" | "user" | undefined;
    authorIsBot?: boolean;
    id?: string | undefined;
    raw: {};
    text?: string | undefined;
};
