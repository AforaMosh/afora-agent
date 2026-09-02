import { type ClientRequest } from "node:http";
export type WebhookAddress = {
    address: string;
    family: 4 | 6;
};
export type WebhookTargetError = "https-required" | "private-address" | "unresolvable";
export type ValidatedWebhookTarget = {
    addresses: WebhookAddress[] | undefined;
} | {
    error: WebhookTargetError;
};
export declare const MAX_CONCURRENT_WEBHOOK_DNS_LOOKUPS = 8;
type WebhookDnsLookupResult = ReadonlyArray<{
    address: string;
    family: number;
}>;
type WebhookDnsLookup = (hostname: string) => Promise<WebhookDnsLookupResult>;
export declare class WebhookDnsLookupPool {
    #private;
    private readonly maxConcurrent;
    private readonly lookupHostname;
    constructor(maxConcurrent: number, lookupHostname?: WebhookDnsLookup);
    resolve(hostname: string, signal?: AbortSignal): Promise<WebhookDnsLookupResult>;
}
export declare function validateWebhookTarget(params: {
    allowLoopbackHttp: boolean;
    restrictPrivateAddresses: boolean;
    signal?: AbortSignal | undefined;
    url: URL;
}): Promise<ValidatedWebhookTarget>;
export declare function postWebhookRequest(params: {
    activeRequests?: Set<ClientRequest> | undefined;
    address?: WebhookAddress | undefined;
    body: string;
    headerEntries?: ReadonlyArray<readonly [string, string]> | undefined;
    signal?: AbortSignal | undefined;
    timeoutMs: number;
    url: URL;
}): Promise<number>;
export {};
