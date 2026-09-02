import { createServer } from "node:http";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 5_000;
class RequestBodyTooLargeError extends Error {
}
class RequestBodyTimeoutError extends Error {
}
async function readRequestBody(request, maxBodyBytes, bodyTimeoutMs) {
    return await new Promise((resolve, reject) => {
        const chunks = [];
        let bodyBytes = 0;
        let settled = false;
        const cleanup = (preserveErrorListener = false) => {
            clearTimeout(timeout);
            request.off("data", onData);
            request.off("end", onEnd);
            if (!preserveErrorListener) {
                request.off("error", onError);
            }
            request.off("aborted", onAborted);
        };
        const fail = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup(true);
            reject(error);
        };
        const onData = (chunk) => {
            if (settled) {
                return;
            }
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bodyBytes += buffer.length;
            if (bodyBytes > maxBodyBytes) {
                request.resume();
                fail(new RequestBodyTooLargeError());
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
            resolve(Buffer.concat(chunks));
        };
        const onError = (error) => fail(error);
        const onAborted = () => fail(new Error("request body aborted"));
        const timeout = setTimeout(() => {
            request.resume();
            fail(new RequestBodyTimeoutError());
        }, bodyTimeoutMs);
        request.on("data", onData);
        request.once("end", onEnd);
        request.once("error", onError);
        request.once("aborted", onAborted);
    });
}
async function toFetchRequest(request, url, maxBodyBytes, bodyTimeoutMs) {
    const body = request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await readRequestBody(request, maxBodyBytes, bodyTimeoutMs);
    const init = {
        headers: request.headers,
    };
    if (request.method) {
        init.method = request.method;
    }
    if (body) {
        init.body = body;
        init.duplex = "half";
    }
    return new Request(url, init);
}
async function writeFetchResponse(response, fetchResponse) {
    response.statusCode = fetchResponse.status;
    for (const [name, value] of fetchResponse.headers) {
        response.setHeader(name, value);
    }
    if (!fetchResponse.body) {
        response.end();
        return;
    }
    const body = Buffer.from(await fetchResponse.arrayBuffer());
    response.end(body);
}
function closeServer(server) {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
        server.closeAllConnections();
    });
}
function formatUrlHost(host) {
    return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
export async function startWebhookServer(params) {
    const methods = new Set(params.methods ?? ["POST"]);
    const maxBodyBytes = params.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const bodyTimeoutMs = params.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
    const server = createServer(async (request, response) => {
        try {
            const method = request.method ?? "GET";
            const host = request.headers.host ?? "127.0.0.1";
            const url = new URL(request.url ?? "/", `http://${host}`);
            if (!methods.has(method) || url.pathname !== params.path) {
                request.resume();
                await writeFetchResponse(response, new Response("not found", { status: 404 }));
                return;
            }
            const fetchRequest = await toFetchRequest(request, url, maxBodyBytes, bodyTimeoutMs);
            await writeFetchResponse(response, await params.handle(fetchRequest));
        }
        catch (error) {
            const status = error instanceof RequestBodyTooLargeError
                ? 413
                : error instanceof RequestBodyTimeoutError
                    ? 408
                    : 500;
            if (status === 500) {
                try {
                    params.onError?.(error);
                }
                catch {
                    // Error reporting must not change the public response.
                }
            }
            await writeFetchResponse(response, new Response(status === 413
                ? "request body too large"
                : status === 408
                    ? "request body timeout"
                    : "internal server error", {
                ...(status === 408 ? { headers: { connection: "close" } } : {}),
                status,
            }));
        }
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
        throw new Error("Unable to resolve webhook server address.");
    }
    return {
        async close() {
            await closeServer(server);
        },
        endpointUrl: `http://${formatUrlHost(params.host)}:${address.port}${params.path}`,
    };
}
