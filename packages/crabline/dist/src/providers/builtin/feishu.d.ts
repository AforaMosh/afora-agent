import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { ProviderAdapter } from "../types.js";
type FeishuEnvironment = Partial<Pick<NodeJS.ProcessEnv, "FEISHU_ENCRYPT_KEY" | "FEISHU_VERIFICATION_TOKEN">>;
type FeishuAuthRuntime = {
    now?: (() => number) | undefined;
};
export declare function resolveFeishuAdapterConfig(config: ProviderConfig, env?: FeishuEnvironment): {
    appId: string;
    encryptKey: string | undefined;
    userName: string | undefined;
    verificationToken: string | undefined;
};
export declare function handleFeishuWebhookPayload(payload: unknown): Response | undefined;
export declare function createFeishuWebhookAuthenticator(config: ProviderConfig, env?: FeishuEnvironment, runtime?: FeishuAuthRuntime): ((request: Request, rawBody: string) => Promise<Response | undefined>) | undefined;
export declare class FeishuProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
    constructor(id: string, config: ProviderConfig, _userName: string, runtime?: unknown);
}
export declare function normalizeFeishuWebhookPayload(payload: unknown): {
    author?: "assistant" | "system" | "user" | undefined;
    authorIsBot?: boolean;
    id?: string | undefined;
    raw: {};
    text?: string | undefined;
};
export declare function decryptFeishuWebhookPayload(payload: unknown, encryptKey: string): unknown;
export {};
