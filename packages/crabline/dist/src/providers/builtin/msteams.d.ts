import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
export declare function resolveMsTeamsAdapterConfig(config: ProviderConfig, env?: NodeJS.ProcessEnv): {
    appId: string;
    appPassword: string;
    appTenantId: string | undefined;
    appType: "MultiTenant" | "SingleTenant" | undefined;
    userName: string | undefined;
};
type MsTeamsAuthRuntime = {
    env?: NodeJS.ProcessEnv | undefined;
    fetch?: typeof fetch | undefined;
    keyFetchTimeoutMs?: number | undefined;
    now?: (() => number) | undefined;
    unknownKeyCooldownMs?: number | undefined;
};
export declare function createMsTeamsWebhookAuthenticator(config: ProviderConfig, runtime?: MsTeamsAuthRuntime): ((request: Request, rawBody: string) => Promise<Response | undefined>) | undefined;
export declare class MsTeamsProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
    constructor(id: string, config: ProviderConfig, _userName: string, runtime?: unknown);
}
export declare function normalizeMsTeamsWebhookPayload(payload: unknown): {
    author?: "assistant" | "system" | "user" | undefined;
    authorIsBot?: boolean;
    id?: string | undefined;
    raw: {};
    text?: string | undefined;
};
export {};
