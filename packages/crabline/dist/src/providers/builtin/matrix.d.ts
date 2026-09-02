import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
export declare function resolveMatrixAdapterConfig(config: ProviderConfig, userName: string, env?: NodeJS.ProcessEnv): {
    auth: {
        accessToken: string;
        type: "accessToken";
        userID?: string | undefined;
    } | {
        password: string;
        type: "password";
        userID?: string | undefined;
        username: string;
    };
    baseURL: string;
    commandPrefix: string | undefined;
    recoveryKey: string | undefined;
};
export declare class MatrixProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
    constructor(id: string, config: ProviderConfig, userName: string, _runtime?: unknown);
}
export declare function matchesMatrixThread(candidateThreadId: string, expectedThreadId: string | undefined, target: {
    channelId?: string | undefined;
}): boolean;
export declare function normalizeMatrixWebhookPayload(payload: unknown, botUserId?: string): {
    author?: "assistant" | "system" | "user" | undefined;
    authorIsBot?: boolean;
    id?: string | undefined;
    raw: {};
    text?: string | undefined;
};
