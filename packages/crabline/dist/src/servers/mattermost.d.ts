import { type ServerEventObserver } from "./recorder.js";
export type MattermostServerManifest = {
    adminToken: string;
    baseUrl: string;
    botToken: string;
    botUserId: string;
    endpoints: {
        adminInboundUrl: string;
        apiRoot: string;
        websocketUrl: string;
    };
    env: {
        MATTERMOST_BOT_TOKEN: string;
        MATTERMOST_URL: string;
    };
    provider: "mattermost";
    recorderPath: string;
    version: 1;
};
export type StartedMattermostServer = {
    close(): Promise<void>;
    manifest: MattermostServerManifest;
};
export type StartMattermostServerParams = {
    adminToken?: string | undefined;
    botToken?: string | undefined;
    botUserId?: string | undefined;
    botUsername?: string | undefined;
    host?: string | undefined;
    onEvent?: ServerEventObserver | undefined;
    port?: number | undefined;
    recorderPath?: string | undefined;
    maxPendingInboundEvents?: number | undefined;
    maxWebSocketBufferedBytes?: number | undefined;
    maxWebSocketMessageBytes?: number | undefined;
    maxUnauthenticatedWebSocketClients?: number | undefined;
    websocketAuthenticationTimeoutMs?: number | undefined;
};
export declare function mattermostId(value: string): string;
export declare function startMattermostServer(params?: StartMattermostServerParams): Promise<StartedMattermostServer>;
