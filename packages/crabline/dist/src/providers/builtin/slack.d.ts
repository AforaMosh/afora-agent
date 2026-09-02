import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
type SlackEnvironment = Partial<Pick<NodeJS.ProcessEnv, "SLACK_SIGNING_SECRET">>;
export declare function resolveSlackAdapterConfig(config: ProviderConfig, env?: SlackEnvironment): {
    signingSecret: string | undefined;
};
export declare function handleSlackWebhookPayload(payload: unknown): Response | undefined;
export declare class SlackProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
    constructor(id: string, config: ProviderConfig, _userName: string, _runtime?: unknown);
}
export {};
