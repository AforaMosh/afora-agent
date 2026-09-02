import { type ServerEventObserver } from "./recorder.js";
export type SignalServerManifest = {
    account: string;
    adminToken: string;
    baseUrl: string;
    endpoints: {
        adminInboundUrl: string;
        apiRoot: string;
        eventsUrl: string;
        rpcUrl: string;
    };
    env: Record<string, never>;
    provider: "signal";
    recorderPath: string;
    version: 1;
};
export type StartedSignalServer = {
    close(): Promise<void>;
    manifest: SignalServerManifest;
};
export type StartSignalServerParams = {
    account?: string | undefined;
    adminToken?: string | undefined;
    host?: string | undefined;
    onEvent?: ServerEventObserver | undefined;
    port?: number | undefined;
    recorderPath?: string | undefined;
    maxPendingInboundEvents?: number | undefined;
    maxSseClients?: number | undefined;
};
export declare function startSignalServer(params?: StartSignalServerParams): Promise<StartedSignalServer>;
