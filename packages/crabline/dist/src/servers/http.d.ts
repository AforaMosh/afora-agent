import { type IncomingMessage, type Server, type ServerResponse } from "node:http";
export type ServerRequestEvent = {
    at: string;
    body?: unknown;
    method: string;
    path: string;
    query: Record<string, string>;
    type: "admin" | "api";
};
export type HttpJsonHandlerResult = Response | {
    onWriteFailure?(): Promise<void> | void;
    onWriteSuccess?(): Promise<void> | void;
    response: Response;
};
export declare const ADMIN_TOKEN_HEADER = "x-crabline-admin-token";
export declare const DEFAULT_MAX_REQUEST_BODY_BYTES: number;
export declare const DEFAULT_SERVER_SHUTDOWN_GRACE_MS = 250;
export declare class InvalidJsonBodyError extends Error {
    constructor(cause: unknown);
}
export declare class RequestBodyTooLargeError extends Error {
    readonly maxBytes: number;
    constructor(maxBytes: number);
}
export declare function jsonResponse(value: unknown, status?: number): Response;
export declare function drainRequestBody(request: IncomingMessage): void;
export declare function readBody(request: IncomingMessage, maxBytes?: number): Promise<Buffer>;
export declare function parseUnknownRequestBody(request: IncomingMessage, maxBytes?: number): Promise<unknown>;
export declare function parseRequestBody(request: IncomingMessage): Promise<Record<string, unknown>>;
export declare function isJsonObject(value: unknown): value is Record<string, unknown>;
export declare function queryRecord(url: URL): Record<string, string>;
export declare function formatUrlHost(host: string): string;
export declare function isLoopbackHost(host: string): boolean;
export declare function writeResponse(response: ServerResponse, fetchResponse: Response): Promise<void>;
export declare function closeServer(server: Server, graceMs?: number): Promise<void>;
export declare function startHttpJsonServer(params: {
    handle: (request: IncomingMessage, response: ServerResponse) => Promise<HttpJsonHandlerResult>;
    handleError?: (error: unknown, request: IncomingMessage) => Response | undefined;
    host: string;
    port: number;
    serverName: string;
}): Promise<{
    baseUrl: string;
    close(): Promise<void>;
    server: Server;
}>;
export declare function readString(value: unknown): string | undefined;
export declare function readTrimmedString(value: unknown): string | undefined;
export declare function readInteger(value: unknown): number | undefined;
export declare function hasAdminToken(request: IncomingMessage, expectedToken: string): boolean;
export declare function adminAuthError(): Response;
