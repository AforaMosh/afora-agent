import { type ServerEventObserver } from "./recorder.js";
export type MatrixServerManifest = {
    accessToken: string;
    adminToken: string;
    baseUrl: string;
    botUserId: string;
    deviceId: string;
    endpoints: {
        adminInboundUrl: string;
        clientApiRoot: string;
        syncUrl: string;
    };
    env: {
        MATRIX_ACCESS_TOKEN: string;
        MATRIX_BASE_URL: string;
        MATRIX_USER_ID: string;
    };
    provider: "matrix";
    recorderPath: string;
    version: 1;
};
export type StartedMatrixServer = {
    close(): Promise<void>;
    manifest: MatrixServerManifest;
};
export type StartMatrixServerParams = {
    accessToken?: string | undefined;
    adminToken?: string | undefined;
    botUserId?: string | undefined;
    deviceId?: string | undefined;
    host?: string | undefined;
    onEvent?: ServerEventObserver | undefined;
    port?: number | undefined;
    recorderPath?: string | undefined;
    roomId?: string | undefined;
    roomName?: string | undefined;
    serverName?: string | undefined;
};
export declare function startMatrixServer(params?: StartMatrixServerParams): Promise<StartedMatrixServer>;
