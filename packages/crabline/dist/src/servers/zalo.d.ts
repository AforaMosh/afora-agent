import { type ClientRequest } from "node:http";
import { type ServerEventObserver } from "./recorder.js";
import { type WebhookAddress } from "./webhook-target.js";
export type ZaloServerManifest = {
    adminToken: string;
    baseUrl: string;
    botId: string;
    botToken: string;
    endpoints: {
        adminInboundUrl: string;
        apiRoot: string;
    };
    env: {
        ZALO_API_URL: string;
        ZALO_BOT_TOKEN: string;
    };
    provider: "zalo";
    recorderPath: string;
    version: 1;
};
export type StartedZaloServer = {
    close(): Promise<void>;
    manifest: ZaloServerManifest;
};
export type StartZaloServerParams = {
    adminToken?: string | undefined;
    botId?: string | undefined;
    botName?: string | undefined;
    botToken?: string | undefined;
    host?: string | undefined;
    onEvent?: ServerEventObserver | undefined;
    port?: number | undefined;
    recorderPath?: string | undefined;
    maxPendingInboundEvents?: number | undefined;
    webhookDeliveryTimeoutMs?: number | undefined;
};
/** @internal */
export declare function postZaloWebhook(params: {
    activeRequests?: Set<ClientRequest>;
    addresses?: WebhookAddress[] | undefined;
    body: string;
    shouldCancel?: (() => boolean) | undefined;
    timeoutMs: number;
    url: URL;
    verificationValue: string;
}): Promise<number>;
export declare function startZaloServer(params?: StartZaloServerParams): Promise<StartedZaloServer>;
