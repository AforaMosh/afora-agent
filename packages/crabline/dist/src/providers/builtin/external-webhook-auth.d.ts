type WebhookConfig = {
    host?: string | undefined;
    publicUrl?: string | undefined;
};
export declare function requireExternalWebhookAuthentication(params: {
    authenticated: boolean;
    provider: string;
    requirement: string;
    webhook: WebhookConfig | undefined;
}): void;
export {};
