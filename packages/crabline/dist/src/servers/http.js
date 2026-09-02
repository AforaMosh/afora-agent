import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { CrablineError } from "../core/errors.js";
export const ADMIN_TOKEN_HEADER = "x-crabline-admin-token";
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
export const DEFAULT_SERVER_SHUTDOWN_GRACE_MS = 250;
export class InvalidJsonBodyError extends Error {
    constructor(cause) {
        super("Request body is not valid JSON.", { cause });
        this.name = "InvalidJsonBodyError";
    }
}
export class RequestBodyTooLargeError extends Error {
    maxBytes;
    constructor(maxBytes) {
        super(`Request body exceeds the ${maxBytes} byte limit.`);
        this.maxBytes = maxBytes;
        this.name = "RequestBodyTooLargeError";
    }
}
export function jsonResponse(value, status = 200) {
    return Response.json(value, { status });
}
export function drainRequestBody(request) {
    const ignoreError = () => { };
    request.on("error", ignoreError);
    if (request.destroyed || request.readableEnded) {
        return;
    }
    const cleanup = () => {
        request.off("close", cleanup);
        request.off("end", cleanup);
        request.off("error", ignoreError);
    };
    request.once("close", cleanup);
    request.once("end", cleanup);
    request.resume();
}
export async function readBody(request, maxBytes = DEFAULT_MAX_REQUEST_BODY_BYTES) {
    const contentLengthHeader = request.headers["content-length"];
    const contentLengthValue = Array.isArray(contentLengthHeader)
        ? contentLengthHeader[0]
        : contentLengthHeader;
    if (contentLengthValue && /^\d+$/u.test(contentLengthValue)) {
        const contentLength = Number(contentLengthValue);
        if (!Number.isSafeInteger(contentLength) || contentLength > maxBytes) {
            drainRequestBody(request);
            throw new RequestBodyTooLargeError(maxBytes);
        }
    }
    return await new Promise((resolve, reject) => {
        const chunks = [];
        let length = 0;
        let settled = false;
        const cleanup = () => {
            request.off("aborted", onAborted);
            request.off("data", onData);
            request.off("end", onEnd);
            request.off("error", onError);
        };
        const fail = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            drainRequestBody(request);
            cleanup();
            reject(error);
        };
        const onAborted = () => fail(new Error("Request body stream was aborted."));
        const onData = (chunk) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            length += buffer.length;
            if (length > maxBytes) {
                fail(new RequestBodyTooLargeError(maxBytes));
                return;
            }
            chunks.push(buffer);
        };
        const onEnd = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(Buffer.concat(chunks, length));
        };
        const onError = (error) => fail(error);
        request.on("aborted", onAborted);
        request.on("data", onData);
        request.on("end", onEnd);
        request.on("error", onError);
    });
}
export async function parseUnknownRequestBody(request, maxBytes = DEFAULT_MAX_REQUEST_BODY_BYTES) {
    const body = await readBody(request, maxBytes);
    if (body.length === 0) {
        return {};
    }
    const contentType = request.headers["content-type"] ?? "";
    const includesJson = Array.isArray(contentType)
        ? contentType.some((entry) => entry.toLowerCase().includes("json"))
        : contentType.toLowerCase().includes("json");
    if (includesJson) {
        try {
            return JSON.parse(body.toString("utf8"));
        }
        catch (error) {
            throw new InvalidJsonBodyError(error);
        }
    }
    const params = new URLSearchParams(body.toString("utf8"));
    return Object.fromEntries(params.entries());
}
export async function parseRequestBody(request) {
    return (await parseUnknownRequestBody(request, Number.MAX_SAFE_INTEGER));
}
export function isJsonObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function queryRecord(url) {
    return Object.fromEntries(url.searchParams.entries());
}
export function formatUrlHost(host) {
    return host.includes(":") ? `[${host}]` : host;
}
export function isLoopbackHost(host) {
    const normalized = host
        .trim()
        .replace(/^\[(.*)\]$/u, "$1")
        .toLowerCase();
    return (normalized === "localhost" ||
        normalized.endsWith(".localhost") ||
        normalized === "::1" ||
        normalized.startsWith("::ffff:127.") ||
        /^127(?:\.\d{1,3}){3}$/u.test(normalized));
}
export async function writeResponse(response, fetchResponse) {
    response.statusCode = fetchResponse.status;
    for (const [name, value] of fetchResponse.headers) {
        if (name.toLowerCase() === "set-cookie") {
            continue;
        }
        response.setHeader(name, value);
    }
    const setCookies = fetchResponse.headers.getSetCookie();
    if (setCookies.length > 0) {
        response.setHeader("set-cookie", setCookies);
    }
    const body = Buffer.from(await fetchResponse.arrayBuffer());
    await new Promise((resolve, reject) => {
        if (response.destroyed ||
            response.req?.aborted ||
            response.req?.socket.destroyed ||
            response.socket?.destroyed) {
            reject(new Error("HTTP response closed before delivery completed."));
            return;
        }
        const cleanup = () => {
            response.off("close", onClose);
            response.off("error", onError);
            response.off("finish", onFinish);
        };
        const onClose = () => {
            if (response.writableFinished) {
                cleanup();
                resolve();
                return;
            }
            cleanup();
            reject(new Error("HTTP response closed before delivery completed."));
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        const onFinish = () => {
            cleanup();
            resolve();
        };
        response.once("close", onClose);
        response.once("error", onError);
        response.once("finish", onFinish);
        try {
            response.end(body);
        }
        catch (error) {
            cleanup();
            reject(error);
        }
    });
}
export function closeServer(server, graceMs = DEFAULT_SERVER_SHUTDOWN_GRACE_MS) {
    return new Promise((resolve, reject) => {
        const closeIdleInterval = setInterval(() => server.closeIdleConnections(), 25);
        closeIdleInterval.unref();
        const forceCloseTimer = setTimeout(() => {
            server.closeAllConnections();
        }, graceMs);
        forceCloseTimer.unref();
        server.close((error) => {
            clearInterval(closeIdleInterval);
            clearTimeout(forceCloseTimer);
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
        server.closeIdleConnections();
    });
}
export async function startHttpJsonServer(params) {
    const handleRequest = async (request, response) => {
        try {
            const result = await params.handle(request, response);
            const handled = result instanceof Response ? { response: result } : result;
            try {
                await writeResponse(response, handled.response);
            }
            catch (error) {
                await handled.onWriteFailure?.();
                throw error;
            }
            try {
                await handled.onWriteSuccess?.();
            }
            catch {
                // Delivery is already committed; lifecycle failures must not trigger another response.
            }
        }
        catch (error) {
            let handled;
            try {
                handled = params.handleError?.(error, request);
            }
            catch {
                handled = undefined;
            }
            try {
                await writeResponse(response, handled ??
                    jsonResponse({
                        error: "internal server error",
                        ok: false,
                    }, 500));
            }
            catch {
                response.destroy();
            }
        }
    };
    const server = createServer((request, response) => {
        void handleRequest(request, response);
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(params.port, params.host, () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new CrablineError(`Unable to resolve ${params.serverName} local server address.`, {
            kind: "connectivity",
        });
    }
    return {
        baseUrl: `http://${formatUrlHost(params.host)}:${address.port}`,
        async close() {
            await closeServer(server);
        },
        server,
    };
}
export function readString(value) {
    if (typeof value === "string" && value.length > 0) {
        return value;
    }
    if (typeof value === "number" || typeof value === "bigint") {
        return value.toString();
    }
    return undefined;
}
export function readTrimmedString(value) {
    const stringValue = readString(value)?.trim();
    return stringValue ? stringValue : undefined;
}
export function readInteger(value) {
    const stringValue = readTrimmedString(value);
    if (!stringValue || !/^-?\d+$/u.test(stringValue)) {
        return undefined;
    }
    const parsed = Number(stringValue);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}
function readBearerToken(authorization) {
    if (!authorization) {
        return undefined;
    }
    const trimmed = authorization.trimStart();
    if (trimmed.slice(0, 7).toLowerCase() !== "bearer ") {
        return undefined;
    }
    return trimmed.slice(7);
}
export function hasAdminToken(request, expectedToken) {
    const header = request.headers[ADMIN_TOKEN_HEADER];
    const directToken = Array.isArray(header) ? header[0] : header;
    const providedToken = directToken ?? readBearerToken(request.headers.authorization);
    if (!providedToken) {
        return false;
    }
    const provided = Buffer.from(providedToken);
    const expected = Buffer.from(expectedToken);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
}
export function adminAuthError() {
    return new Response("unauthorized", {
        headers: { "www-authenticate": "Bearer" },
        status: 401,
    });
}
