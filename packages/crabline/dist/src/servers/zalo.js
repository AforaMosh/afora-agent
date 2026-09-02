import { randomBytes } from "node:crypto";
import { validateHeaderValue, } from "node:http";
import path from "node:path";
import { adminAuthError, drainRequestBody, hasAdminToken, InvalidJsonBodyError, isJsonObject, isLoopbackHost, jsonResponse, parseUnknownRequestBody, queryRecord, readTrimmedString, RequestBodyTooLargeError, startHttpJsonServer, } from "./http.js";
import { recordServerEvent } from "./recorder.js";
import { resolveMaxPendingInboundEvents } from "./pending-events.js";
import { postWebhookRequest, validateWebhookTarget, } from "./webhook-target.js";
const DEFAULT_WEBHOOK_DELIVERY_TIMEOUT_MS = 5_000;
const MAX_ACTIVE_ZALO_WEBHOOK_VALIDATIONS = 8;
const MAX_WEBHOOK_DELIVERY_TIMEOUT_MS = 30_000;
const MAX_ZALO_WEBHOOK_SECRET_BYTES = 256;
async function appendEvent(state, event) {
    await recordServerEvent({ event, onEvent: state.onEvent, recorderPath: state.recorderPath });
}
function zaloOk(result) {
    return jsonResponse(result === undefined ? { ok: true } : { ok: true, result });
}
function zaloError(description, status) {
    return jsonResponse({ description, error_code: status, ok: false }, status);
}
function messageId(state) {
    return `${Date.now().toString(16)}${(state.nextMessage++).toString(16).padStart(6, "0")}`;
}
function readChatType(value) {
    return readTrimmedString(value)?.toUpperCase() === "GROUP" ? "GROUP" : "PRIVATE";
}
function requestParams(url, body) {
    return { ...Object.fromEntries(url.searchParams.entries()), ...body };
}
const SENSITIVE_PARAM_NAMES = new Set([
    "accesskey",
    "accesstoken",
    "apikey",
    "auth",
    "authorization",
    "authtoken",
    "bearertoken",
    "clientsecret",
    "consumersecret",
    "credential",
    "credentials",
    "idtoken",
    "key",
    "oauthtoken",
    "password",
    "passwd",
    "privatekey",
    "refreshtoken",
    "secret",
    "secretkey",
    "secrettoken",
    "sessiontoken",
    "signature",
    "signingsecret",
    "token",
    "webhooksecret",
]);
function isSensitiveParam(name) {
    const canonicalName = name
        .normalize("NFKC")
        .replace(/[^A-Za-z0-9]/gu, "")
        .toLowerCase();
    return (SENSITIVE_PARAM_NAMES.has(canonicalName) ||
        /(?:^|[_-])(?:access[_-]?token|api[_-]?key|authorization|key|password|secret|signature|token)(?:$|[_-])/iu.test(name));
}
function redactParams(params) {
    return Object.fromEntries(Object.entries(params).map(([key, value]) => [
        key,
        isSensitiveParam(key)
            ? "<redacted>"
            : key === "url" && typeof value === "string"
                ? redactUrlCredentials(value)
                : value,
    ]));
}
function redactSensitiveSearchParams(searchParams) {
    let redacted = false;
    for (const key of searchParams.keys()) {
        if (isSensitiveParam(key)) {
            searchParams.set(key, "<redacted>");
            redacted = true;
        }
    }
    return redacted;
}
function redactMalformedUrlCredentials(value) {
    const credentialRedacted = value.replace(/^(\s*)((?:[a-z][a-z0-9+.-]*:)?\/\/)[^/?#]*@/iu, "$1$2<redacted>@");
    const queryStart = credentialRedacted.indexOf("?");
    const fragmentStart = credentialRedacted.indexOf("#", queryStart + 1);
    if (queryStart < 0 || (fragmentStart >= 0 && fragmentStart < queryStart)) {
        return credentialRedacted;
    }
    const queryEnd = fragmentStart >= 0 ? fragmentStart : credentialRedacted.length;
    const searchParams = new URLSearchParams(credentialRedacted.slice(queryStart + 1, queryEnd));
    if (!redactSensitiveSearchParams(searchParams)) {
        return credentialRedacted;
    }
    const search = searchParams.toString().replaceAll("%3Credacted%3E", "<redacted>");
    return `${credentialRedacted.slice(0, queryStart)}?${search}${credentialRedacted.slice(queryEnd)}`;
}
function redactUrlCredentials(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return redactMalformedUrlCredentials(value);
    }
    const hasCredentials = Boolean(url.username || url.password);
    const redactedQuery = redactSensitiveSearchParams(url.searchParams);
    if (!hasCredentials && !redactedQuery) {
        return value;
    }
    const search = url.search.replaceAll("%3Credacted%3E", "<redacted>");
    return `${url.protocol}//${hasCredentials ? "<redacted>@" : ""}${url.host}${url.pathname}${search}${url.hash}`;
}
function requireParam(body, name) {
    return readTrimmedString(body[name]) ?? zaloError(`${name} is required`, 400);
}
function firstError(...values) {
    return values.find((value) => value instanceof Response);
}
function webhookDeliveryTimeoutMs(value) {
    if (value === undefined || !Number.isFinite(value)) {
        return DEFAULT_WEBHOOK_DELIVERY_TIMEOUT_MS;
    }
    return Math.max(1, Math.min(Math.floor(value), MAX_WEBHOOK_DELIVERY_TIMEOUT_MS));
}
async function validateWebhookUrl(url, state, signal) {
    const target = await validateWebhookTarget({
        allowLoopbackHttp: state.allowLoopbackHttpWebhook,
        restrictPrivateAddresses: state.restrictWebhookTargets,
        signal,
        url,
    });
    if ("error" in target) {
        return target.error === "unresolvable"
            ? zaloError("url host could not be resolved", 400)
            : target.error === "private-address"
                ? zaloError("url must not target a private or link-local address", 400)
                : zaloError("url must use HTTPS", 400);
    }
    return target;
}
function validateZaloWebhookSecret(secretToken) {
    if (Buffer.byteLength(secretToken) > MAX_ZALO_WEBHOOK_SECRET_BYTES) {
        return zaloError(`secret_token must not exceed ${MAX_ZALO_WEBHOOK_SECRET_BYTES} bytes`, 400);
    }
    try {
        validateHeaderValue("x-bot-api-secret-token", secretToken);
    }
    catch {
        return zaloError("secret_token contains invalid HTTP header characters", 400);
    }
    return undefined;
}
async function validateWebhookUrlWithDeadline(url, state, deadlineAt) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
        throw webhookTimeoutError(state.webhookDeliveryTimeoutMs);
    }
    const validation = new AbortController();
    state.activeWebhookValidations.add(validation);
    const timer = setTimeout(() => validation.abort(webhookTimeoutError(state.webhookDeliveryTimeoutMs)), remainingMs);
    timer.unref();
    try {
        return await validateWebhookUrl(url, state, validation.signal);
    }
    finally {
        clearTimeout(timer);
        state.activeWebhookValidations.delete(validation);
    }
}
function webhookTimeoutError(timeoutMs) {
    return new DOMException(`Webhook delivery timed out after ${timeoutMs}ms`, "TimeoutError");
}
/** @internal */
export async function postZaloWebhook(params) {
    const activeRequests = params.activeRequests ?? new Set();
    const deadlineAt = Date.now() + params.timeoutMs;
    const addresses = params.addresses && params.addresses.length > 0 ? params.addresses : [undefined];
    let lastError;
    for (const [index, address] of addresses.entries()) {
        if (params.shouldCancel?.()) {
            throw new Error("Webhook delivery cancelled.");
        }
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
            throw webhookTimeoutError(params.timeoutMs);
        }
        const attemptsRemaining = addresses.length - index;
        const attemptTimeoutMs = Math.max(1, Math.floor(remainingMs / attemptsRemaining));
        try {
            return await postWebhookRequest({
                activeRequests,
                address,
                body: params.body,
                headerEntries: [["x-bot-api-secret-token", params.verificationValue]],
                timeoutMs: attemptTimeoutMs,
                url: params.url,
            });
        }
        catch (error) {
            if (params.shouldCancel?.()) {
                throw error;
            }
            lastError = error;
            if (error instanceof DOMException &&
                error.name === "TimeoutError" &&
                attemptsRemaining === 1) {
                throw webhookTimeoutError(params.timeoutMs);
            }
        }
    }
    throw lastError;
}
function nextUpdate(request, response, state) {
    if (request.aborted || request.socket.destroyed || response.destroyed) {
        return undefined;
    }
    const update = state.updates[0];
    if (!update) {
        return undefined;
    }
    const order = pollingUpdateOrder(state, update);
    if (state.failedUpdateOrders.has(order) &&
        [...state.reservedUpdateOrders].some((reservedOrder) => reservedOrder < order)) {
        return undefined;
    }
    state.updates.shift();
    reservePollingUpdate(state, update);
    return reservedUpdateResponse(state, update);
}
function pollingUpdateOrder(state, update) {
    const existing = state.updateOrders.get(update);
    if (existing !== undefined) {
        return existing;
    }
    const order = state.nextUpdateOrder++;
    state.updateOrders.set(update, order);
    return order;
}
function queuePollingUpdate(state, update) {
    const order = pollingUpdateOrder(state, update);
    const insertionIndex = state.updates.findIndex((queued) => pollingUpdateOrder(state, queued) > order);
    if (insertionIndex < 0) {
        state.updates.push(update);
    }
    else {
        state.updates.splice(insertionIndex, 0, update);
    }
}
function reservePollingUpdate(state, update) {
    const order = pollingUpdateOrder(state, update);
    state.failedUpdateOrders.delete(order);
    state.reservedUpdateOrders.add(order);
}
function flushPendingPollingUpdate(state) {
    const pending = state.pendingRequest;
    const update = state.updates[0];
    if (!pending || !update) {
        return;
    }
    if (!isPendingUpdateRequestLive(pending)) {
        settlePendingUpdate(state, pending, { kind: "disconnect" });
        return;
    }
    const order = pollingUpdateOrder(state, update);
    if (state.failedUpdateOrders.has(order) &&
        [...state.reservedUpdateOrders].some((reservedOrder) => reservedOrder < order)) {
        return;
    }
    state.updates.shift();
    reservePollingUpdate(state, update);
    settlePendingUpdate(state, pending, { kind: "update", update });
}
function reservedUpdateResponse(state, update) {
    let settled = false;
    const release = () => {
        if (settled) {
            return false;
        }
        settled = true;
        state.reservedUpdateOrders.delete(pollingUpdateOrder(state, update));
        return true;
    };
    return {
        onWriteFailure() {
            if (!release()) {
                return;
            }
            state.failedUpdateOrders.add(pollingUpdateOrder(state, update));
            queuePollingUpdate(state, update);
            flushPendingPollingUpdate(state);
        },
        onWriteSuccess() {
            if (release()) {
                flushPendingPollingUpdate(state);
            }
        },
        response: zaloOk(update),
    };
}
function settlePendingUpdate(state, pending, result) {
    if (!pending.active) {
        return false;
    }
    pending.active = false;
    if (state.pendingRequest === pending) {
        state.pendingRequest = undefined;
    }
    if (pending.timeout) {
        clearTimeout(pending.timeout);
    }
    pending.request.socket.off("close", pending.onDisconnect);
    pending.request.off("aborted", pending.onDisconnect);
    pending.response.off("close", pending.onDisconnect);
    pending.resolve(result);
    return true;
}
function isPendingUpdateRequestLive(pending) {
    return (!pending.request.aborted && !pending.request.socket.destroyed && !pending.response.destroyed);
}
async function waitForUpdate(request, response, state, timeoutSeconds) {
    if (request.aborted || request.socket.destroyed || response.destroyed) {
        return zaloError("Client closed request", 499);
    }
    const previous = state.pendingRequest;
    if (previous) {
        settlePendingUpdate(state, previous, { kind: "conflict" });
    }
    const queued = nextUpdate(request, response, state);
    if (queued) {
        return queued;
    }
    if (timeoutSeconds <= 0) {
        return zaloError("Request timeout", 408);
    }
    const result = await new Promise((resolve) => {
        const pending = {
            active: true,
            onDisconnect: () => {
                settlePendingUpdate(state, pending, { kind: "disconnect" });
            },
            request,
            response,
            resolve,
            timeout: undefined,
        };
        state.pendingRequest = pending;
        request.once("aborted", pending.onDisconnect);
        request.socket.once("close", pending.onDisconnect);
        response.once("close", pending.onDisconnect);
        pending.timeout = setTimeout(() => {
            settlePendingUpdate(state, pending, { kind: "timeout" });
        }, timeoutSeconds * 1000);
        pending.timeout.unref();
        if (request.socket.destroyed || response.destroyed) {
            pending.onDisconnect();
        }
    });
    switch (result.kind) {
        case "conflict":
            return zaloError("Conflict: terminated by other getUpdates request", 409);
        case "disconnect":
            return zaloError("Client closed request", 499);
        case "shutdown":
            return zaloError("Server shutting down", 503);
        case "timeout":
            return zaloError("Request timeout", 408);
        case "update":
            return reservedUpdateResponse(state, result.update);
    }
}
function deliverPollingUpdate(state, update) {
    pollingUpdateOrder(state, update);
    if (state.updates.length > 0) {
        if (state.updates.length + state.reservedUpdateOrders.size >= state.maxPendingInboundEvents) {
            return false;
        }
        queuePollingUpdate(state, update);
        flushPendingPollingUpdate(state);
        return true;
    }
    const pending = state.pendingRequest;
    if (pending) {
        if (isPendingUpdateRequestLive(pending)) {
            reservePollingUpdate(state, update);
            settlePendingUpdate(state, pending, { kind: "update", update });
            return true;
        }
        settlePendingUpdate(state, pending, { kind: "disconnect" });
    }
    if (state.updates.length + state.reservedUpdateOrders.size >= state.maxPendingInboundEvents) {
        return false;
    }
    queuePollingUpdate(state, update);
    return true;
}
async function deliverWebhookUpdate(state, webhook, update) {
    const deadlineAt = Date.now() + state.webhookDeliveryTimeoutMs;
    const url = new URL(webhook.url);
    let target;
    try {
        target = await validateWebhookUrlWithDeadline(url, state, deadlineAt);
    }
    catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") {
            return zaloError(`Webhook delivery timed out after ${state.webhookDeliveryTimeoutMs}ms`, 502);
        }
        throw error;
    }
    if (target instanceof Response) {
        return target;
    }
    try {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
            throw webhookTimeoutError(state.webhookDeliveryTimeoutMs);
        }
        const status = await postZaloWebhook({
            activeRequests: state.activeWebhookRequests,
            addresses: target.addresses,
            body: JSON.stringify(update),
            shouldCancel: () => state.closing,
            timeoutMs: remainingMs,
            url,
            verificationValue: webhook.secretToken,
        });
        if (status < 200 || status >= 300) {
            return zaloError(`Webhook delivery failed with HTTP ${status}`, 502);
        }
    }
    catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") {
            return zaloError(`Webhook delivery timed out after ${state.webhookDeliveryTimeoutMs}ms`, 502);
        }
        return zaloError(`Webhook delivery failed: ${error instanceof Error ? error.message : String(error)}`, 502);
    }
    return undefined;
}
async function handleAdminInbound(request, state, url) {
    if (!hasAdminToken(request, state.adminToken)) {
        drainRequestBody(request);
        return adminAuthError();
    }
    const parsedBody = await parseUnknownRequestBody(request);
    if (!isJsonObject(parsedBody)) {
        return zaloError("Bad Request: can't parse JSON object", 400);
    }
    const body = parsedBody;
    const chatId = requireParam(body, "chatId");
    const senderId = requireParam(body, "senderId");
    const text = requireParam(body, "text");
    if (chatId instanceof Response || senderId instanceof Response || text instanceof Response) {
        return [chatId, senderId, text].find((value) => value instanceof Response);
    }
    let releaseAdmission;
    const previousAdmission = state.inboundAdmission;
    state.inboundAdmission = new Promise((resolve) => {
        releaseAdmission = resolve;
    });
    await previousAdmission;
    try {
        if (!state.webhook?.url &&
            state.updates.length + state.reservedUpdateOrders.size >= state.maxPendingInboundEvents) {
            return zaloError(`Pending inbound queue is full (${state.maxPendingInboundEvents} updates)`, 429);
        }
        const update = {
            event_name: "message.text.received",
            message: {
                chat: { chat_type: readChatType(body.chatType), id: chatId },
                date: Date.now(),
                from: {
                    display_name: readTrimmedString(body.senderName) ?? senderId,
                    id: senderId,
                    is_bot: false,
                },
                message_id: messageId(state),
                text,
            },
        };
        await appendEvent(state, {
            at: new Date().toISOString(),
            body,
            method: request.method ?? "POST",
            path: url.pathname,
            query: queryRecord(url),
            type: "admin",
        });
        if (state.webhook?.url) {
            const error = await deliverWebhookUpdate(state, state.webhook, update);
            if (error) {
                return error;
            }
        }
        else if (!deliverPollingUpdate(state, update)) {
            return zaloError(`Pending inbound queue is full (${state.maxPendingInboundEvents} updates)`, 429);
        }
        return zaloOk(update);
    }
    finally {
        releaseAdmission();
    }
}
async function handleZaloMethod(request, response, state, url, method) {
    const parsedBody = await parseUnknownRequestBody(request);
    if (!isJsonObject(parsedBody)) {
        return zaloError("Bad Request: can't parse JSON object", 400);
    }
    const body = requestParams(url, parsedBody);
    const event = {
        at: new Date().toISOString(),
        ...(Object.keys(body).length > 0 ? { body: redactParams(body) } : {}),
        method: request.method ?? "GET",
        path: `/bot<redacted>/${method}`,
        query: redactParams(queryRecord(url)),
        type: "api",
    };
    if (method === "sendMessage" || method === "sendPhoto") {
        const chatId = requireParam(body, "chat_id");
        const content = requireParam(body, method === "sendMessage" ? "text" : "photo");
        const error = firstError(chatId, content);
        const sendResponse = error ?? zaloOk({ date: Date.now(), message_id: messageId(state) });
        event.accepted = sendResponse.ok;
        try {
            await appendEvent(state, event);
        }
        catch (appendError) {
            if (!event.accepted) {
                throw appendError;
            }
        }
        return sendResponse;
    }
    await appendEvent(state, event);
    if (method === "getMe") {
        return zaloOk({
            account_name: state.botName,
            account_type: "BASIC",
            can_join_groups: true,
            id: state.botId,
        });
    }
    if (method === "getUpdates") {
        if (state.webhook?.url) {
            return zaloError("Webhook is configured; delete it before using getUpdates", 400);
        }
        const parsedTimeout = Number(readTrimmedString(body.timeout) ?? "30");
        const timeout = Number.isFinite(parsedTimeout) ? Math.max(0, Math.min(parsedTimeout, 50)) : 30;
        return await waitForUpdate(request, response, state, timeout);
    }
    if (method === "sendChatAction") {
        const chatId = requireParam(body, "chat_id");
        const action = requireParam(body, "action");
        const error = firstError(chatId, action);
        if (error) {
            return error;
        }
        if (action !== "typing" && action !== "upload_photo") {
            return zaloError("action must be typing or upload_photo", 400);
        }
        return zaloOk();
    }
    if (method === "setWebhook") {
        const webhookUrl = requireParam(body, "url");
        const secretToken = requireParam(body, "secret_token");
        const error = firstError(webhookUrl, secretToken);
        if (error) {
            return error;
        }
        if (typeof webhookUrl !== "string" || typeof secretToken !== "string") {
            return zaloError("Invalid webhook parameters", 400);
        }
        const secretError = validateZaloWebhookSecret(secretToken);
        if (secretError) {
            return secretError;
        }
        let parsedUrl;
        try {
            parsedUrl = new URL(webhookUrl);
        }
        catch {
            return zaloError("url must be a valid HTTPS URL", 400);
        }
        if (state.activeWebhookValidations.size >= MAX_ACTIVE_ZALO_WEBHOOK_VALIDATIONS) {
            return zaloError("Too many webhook validations", 429);
        }
        let target;
        try {
            target = await validateWebhookUrlWithDeadline(parsedUrl, state, Date.now() + state.webhookDeliveryTimeoutMs);
        }
        catch {
            return zaloError("url host could not be resolved", 400);
        }
        if (target instanceof Response) {
            return target;
        }
        if (state.reservedUpdateOrders.size > 0) {
            return zaloError("Polling deliveries are still in progress", 409);
        }
        const webhook = { secretToken, updatedAt: Date.now(), url: parsedUrl.href };
        if (state.pendingRequest) {
            settlePendingUpdate(state, state.pendingRequest, { kind: "conflict" });
        }
        state.webhook = webhook;
        return zaloOk({ updated_at: webhook.updatedAt, url: webhook.url });
    }
    if (method === "deleteWebhook") {
        const updatedAt = Date.now();
        state.webhook = undefined;
        return zaloOk({ updated_at: updatedAt, url: "" });
    }
    if (method === "getWebhookInfo") {
        return zaloOk(state.webhook ? { updated_at: state.webhook.updatedAt, url: state.webhook.url } : { url: "" });
    }
    return zaloError("Bad request - invalid API name", 400);
}
export async function startZaloServer(params = {}) {
    const host = params.host ?? "127.0.0.1";
    const state = {
        activeWebhookRequests: new Set(),
        activeWebhookValidations: new Set(),
        adminToken: params.adminToken ?? randomBytes(24).toString("hex"),
        allowLoopbackHttpWebhook: isLoopbackHost(host),
        botId: params.botId ?? "1459232241454765289",
        botName: params.botName ?? "bot.crabline",
        botToken: params.botToken ??
            (isLoopbackHost(host) ? "crabline-zalo-bot-token" : randomBytes(32).toString("base64url")),
        closing: false,
        failedUpdateOrders: new Set(),
        inboundAdmission: Promise.resolve(),
        maxPendingInboundEvents: resolveMaxPendingInboundEvents(params.maxPendingInboundEvents),
        nextMessage: 1,
        nextUpdateOrder: 1,
        onEvent: params.onEvent,
        pendingRequest: undefined,
        recorderPath: params.recorderPath ?? path.resolve(".crabline", "servers", "zalo.jsonl"),
        reservedUpdateOrders: new Set(),
        restrictWebhookTargets: true,
        updateOrders: new WeakMap(),
        updates: [],
        webhook: undefined,
        webhookDeliveryTimeoutMs: webhookDeliveryTimeoutMs(params.webhookDeliveryTimeoutMs),
    };
    const httpServer = await startHttpJsonServer({
        handle: async (request, response) => {
            const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
            if (request.method === "POST" && url.pathname === "/crabline/zalo/inbound") {
                return await handleAdminInbound(request, state, url);
            }
            const match = /^\/bot([^/]+)\/([^/]+)$/u.exec(url.pathname);
            if (!match || (request.method !== "GET" && request.method !== "POST")) {
                return zaloError("Not found", 404);
            }
            if (match[1] !== state.botToken) {
                drainRequestBody(request);
                return zaloError("Unauthorized", 401);
            }
            return await handleZaloMethod(request, response, state, url, match[2] ?? "");
        },
        handleError: (error) => {
            if (error instanceof InvalidJsonBodyError) {
                return zaloError("Bad Request: can't parse JSON object", 400);
            }
            if (error instanceof RequestBodyTooLargeError) {
                return zaloError("Request Entity Too Large", 413);
            }
            return undefined;
        },
        host,
        port: params.port ?? 0,
        serverName: "Zalo",
    });
    const manifest = {
        adminToken: state.adminToken,
        baseUrl: httpServer.baseUrl,
        botId: state.botId,
        botToken: state.botToken,
        endpoints: {
            adminInboundUrl: `${httpServer.baseUrl}/crabline/zalo/inbound`,
            apiRoot: httpServer.baseUrl,
        },
        env: {
            ZALO_API_URL: httpServer.baseUrl,
            ZALO_BOT_TOKEN: state.botToken,
        },
        provider: "zalo",
        recorderPath: state.recorderPath,
        version: 1,
    };
    return {
        async close() {
            state.closing = true;
            for (const request of state.activeWebhookRequests) {
                request.destroy(new Error("Zalo server is shutting down."));
            }
            for (const validation of state.activeWebhookValidations) {
                validation.abort(new Error("Zalo server is shutting down."));
            }
            if (state.pendingRequest) {
                settlePendingUpdate(state, state.pendingRequest, { kind: "shutdown" });
            }
            await httpServer.close();
        },
        manifest,
    };
}
