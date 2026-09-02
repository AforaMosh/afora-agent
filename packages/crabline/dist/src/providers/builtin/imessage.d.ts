import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
export declare function resolveIMessageAdapterConfig(config: ProviderConfig, env?: NodeJS.ProcessEnv): {
    apiKey: string;
    local: boolean;
    serverUrl: string | undefined;
};
export declare class IMessageProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
    constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown);
}
export declare function matchesIMessageThread(candidateThreadId: string, expectedThreadId: string | undefined, target: {
    channelId?: string | undefined;
    id: string;
}, raw?: unknown): boolean;
