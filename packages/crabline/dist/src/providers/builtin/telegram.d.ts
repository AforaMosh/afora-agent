import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
type TelegramEnvironment = Partial<Pick<NodeJS.ProcessEnv, "TELEGRAM_API_BASE_URL" | "TELEGRAM_BOT_USERNAME" | "TELEGRAM_WEBHOOK_SECRET_TOKEN">>;
export declare function resolveTelegramAdapterConfig(config: ProviderConfig, env?: TelegramEnvironment): {
    mode: "auto" | "polling" | "webhook";
    apiUrl?: string;
    secretToken?: string;
    userName?: string;
};
export declare function normalizeTelegramWebhookPayload(payload: unknown): {
    author?: "assistant" | "system" | "user" | undefined;
    authorIsBot?: boolean;
    id?: string | undefined;
    raw: {};
    text?: string | undefined;
} | {
    author: "assistant" | "system" | "user";
    id?: string | undefined;
    raw: Record<string, unknown>;
    text: string;
    threadId: string;
};
export declare class TelegramProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
    constructor(id: string, config: ProviderConfig, _userName: string);
}
export {};
