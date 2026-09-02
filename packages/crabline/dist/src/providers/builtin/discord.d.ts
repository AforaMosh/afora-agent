import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
type DiscordEnvironment = Partial<Pick<NodeJS.ProcessEnv, "DISCORD_APPLICATION_ID" | "DISCORD_BOT_TOKEN" | "DISCORD_PUBLIC_KEY">>;
export declare function resolveDiscordAdapterConfig(config: ProviderConfig, userName: string, env?: DiscordEnvironment): Promise<{
    applicationId?: string;
    botToken?: string;
    mentionRoleIds?: string[] | undefined;
    publicKey?: string;
    userName: string;
}>;
export declare function normalizeDiscordWebhookPayload(payload: unknown): {
    author?: "assistant" | "system" | "user" | undefined;
    authorIsBot?: boolean;
    id?: string | undefined;
    raw: {};
    text?: string | undefined;
};
export declare function createDiscordInteractionResponse(payload: unknown): Response;
export declare function handleDiscordWebhookPayload(payload: unknown): Response | undefined;
export declare class DiscordProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
    constructor(id: string, config: ProviderConfig, userName: string, runtime?: unknown);
}
export {};
