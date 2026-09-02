import { type ServerEventObserver } from "./recorder.js";
export type SlackServerManifest = {
    adminToken: string;
    baseUrl: string;
    botToken: string;
    endpoints: {
        adminInboundUrl: string;
        apiRoot: string;
        eventsUrl: string;
    };
    env: {
        SLACK_API_URL: string;
        SLACK_BOT_TOKEN: string;
        SLACK_SIGNING_SECRET: string;
    };
    provider: "slack";
    recorderPath: string;
    signingSecret: string;
    version: 1;
};
export type StartedSlackServer = {
    close(): Promise<void>;
    manifest: SlackServerManifest;
};
export type StartSlackServerParams = {
    adminToken?: string | undefined;
    botId?: string | undefined;
    botToken?: string | undefined;
    botUserId?: string | undefined;
    chatPostMessageRateLimit?: {
        remaining: number;
        retryAfterSeconds: number;
    } | undefined;
    eventsRequestUrl?: string | undefined;
    host?: string | undefined;
    onEvent?: ServerEventObserver | undefined;
    port?: number | undefined;
    recorderPath?: string | undefined;
    signingSecret?: string | undefined;
};
export declare function startSlackServer(params?: StartSlackServerParams): Promise<StartedSlackServer>;
