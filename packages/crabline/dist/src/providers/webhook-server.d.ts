export type StartedWebhookServer = {
    close(): Promise<void>;
    endpointUrl: string;
};
export declare function startWebhookServer(params: {
    handle(request: Request): Promise<Response>;
    bodyTimeoutMs?: number | undefined;
    host: string;
    maxBodyBytes?: number;
    methods?: readonly string[] | undefined;
    onError?: ((error: unknown) => void) | undefined;
    path: string;
    port: number;
}): Promise<StartedWebhookServer>;
