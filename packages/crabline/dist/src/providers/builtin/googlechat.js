import { createPublicKey } from "node:crypto";
import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import { createCachedJwtKeyResolver, readBearerToken, resolveHttpCacheExpiry, verifySignedJwt, } from "../signed-jwt.js";
import { getBuiltinTargetCodec, GOOGLE_CHAT_SPACE_RULE, GOOGLE_CHAT_THREAD_RULE, } from "../target-normalizers.js";
import { authorFromBotFlag, genericMockPayloadWithNativeThread, isRecord, optionalRecord, optionalString, requireNativeInboundId, } from "./native-local-mock.js";
import { requireExternalWebhookAuthentication } from "./external-webhook-auth.js";
export function resolveGoogleChatAdapterConfig(config, _env = process.env) {
    return {
        endpointUrl: config.googlechat?.endpointUrl,
        projectNumber: config.googlechat?.googleChatProjectNumber ?? "local-mock-googlechat",
        pubsubServiceAccountEmail: config.googlechat?.pubsubServiceAccountEmail ?? config.googlechat?.credentials?.client_email,
        userName: config.googlechat?.userName,
    };
}
const GOOGLE_CHAT_SERVICE_ACCOUNT = "chat@system.gserviceaccount.com";
const GOOGLE_OAUTH_CERTS_URL = "https://www.googleapis.com/oauth2/v1/certs";
const GOOGLE_CHAT_CERTS_URL = "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com";
export function createGoogleChatWebhookAuthenticator(config, runtime = {}) {
    if (config.googlechat?.disableSignatureVerification) {
        return undefined;
    }
    const endpointAudience = config.googlechat?.endpointUrl ?? config.googlechat?.webhook.publicUrl;
    const projectAudience = config.googlechat?.googleChatProjectNumber;
    const pubsubAudience = config.googlechat?.pubsubAudience ?? endpointAudience;
    const pubsubServiceAccount = config.googlechat?.pubsubServiceAccountEmail ?? config.googlechat?.credentials?.client_email;
    if (!(endpointAudience || projectAudience || pubsubAudience)) {
        return undefined;
    }
    const fetchImpl = runtime.fetch ?? fetch;
    const createCertificateResolver = (certificateUrl) => {
        return createCachedJwtKeyResolver({
            async fetchKeys(signal) {
                const fetchedAt = runtime.now?.() ?? Date.now();
                const response = await fetchImpl(certificateUrl, { signal });
                if (!response.ok) {
                    throw new Error(`Google certificate fetch failed with HTTP ${response.status}.`);
                }
                const body = await response.json();
                if (!isRecord(body)) {
                    throw new Error("Google certificate response must be an object.");
                }
                const values = Object.entries(body).flatMap(([kid, certificate]) => typeof certificate === "string" ? [{ certificate, kid }] : []);
                return {
                    expiresAt: resolveHttpCacheExpiry(response, fetchedAt),
                    values,
                };
            },
            keyId: (value) => value.kid,
            now: runtime.now,
            refreshCooldownMs: runtime.unknownKeyCooldownMs,
            timeoutMs: runtime.keyFetchTimeoutMs,
            unknownKeyMessage: "Google JWT signing key is unknown.",
        });
    };
    const resolveGoogleIdentityCertificate = createCertificateResolver(GOOGLE_OAUTH_CERTS_URL);
    const resolveGoogleChatCertificate = createCertificateResolver(GOOGLE_CHAT_CERTS_URL);
    return async (request, rawBody) => {
        const token = readBearerToken(request);
        if (!token) {
            return new Response("unauthorized", {
                headers: { "www-authenticate": "Bearer" },
                status: 401,
            });
        }
        try {
            let payload;
            try {
                payload = JSON.parse(rawBody);
            }
            catch {
                return undefined;
            }
            const isPubsub = isRecord(payload) &&
                isRecord(payload.message) &&
                typeof payload.message.data === "string" &&
                typeof payload.subscription === "string";
            const audience = isPubsub ? pubsubAudience : (projectAudience ?? endpointAudience);
            if (!audience) {
                throw new Error("Google Chat verification is not configured for this transport.");
            }
            const usesGoogleIdentityToken = isPubsub || (projectAudience === undefined && endpointAudience !== undefined);
            const certificateUrl = usesGoogleIdentityToken
                ? GOOGLE_OAUTH_CERTS_URL
                : GOOGLE_CHAT_CERTS_URL;
            const claims = await verifySignedJwt({
                audience,
                issuers: usesGoogleIdentityToken
                    ? ["accounts.google.com", "https://accounts.google.com"]
                    : [GOOGLE_CHAT_SERVICE_ACCOUNT],
                now: runtime.now,
                async resolveKey(header) {
                    const certificate = await (certificateUrl === GOOGLE_OAUTH_CERTS_URL
                        ? resolveGoogleIdentityCertificate(header)
                        : resolveGoogleChatCertificate(header));
                    return createPublicKey(certificate.certificate);
                },
                token,
            });
            if (isPubsub &&
                (!pubsubServiceAccount ||
                    claims.email !== pubsubServiceAccount ||
                    claims.email_verified !== true)) {
                throw new Error("Google Pub/Sub token identity is invalid.");
            }
            if (!isPubsub &&
                usesGoogleIdentityToken &&
                (claims.email !== GOOGLE_CHAT_SERVICE_ACCOUNT || claims.email_verified !== true)) {
                throw new Error("Google Chat ID token identity is invalid.");
            }
            return undefined;
        }
        catch {
            return new Response("unauthorized", {
                headers: { "www-authenticate": "Bearer" },
                status: 401,
            });
        }
    };
}
export function matchesGoogleChatThread(candidateThreadId, expectedThreadId, target = {}) {
    const candidateSpace = GOOGLE_CHAT_THREAD_RULE.pattern.test(candidateThreadId)
        ? candidateThreadId.slice(0, candidateThreadId.indexOf("/threads/"))
        : candidateThreadId;
    if (target.channelId && candidateSpace !== target.channelId) {
        return false;
    }
    if (!expectedThreadId) {
        return true;
    }
    return (candidateThreadId === expectedThreadId ||
        (GOOGLE_CHAT_SPACE_RULE.pattern.test(expectedThreadId) &&
            candidateThreadId.startsWith(`${expectedThreadId}/threads/`)));
}
export class GoogleChatProviderAdapter extends LocalMockProviderAdapter {
    constructor(id, config, _userName, runtime) {
        const endpointAudience = config.googlechat?.endpointUrl ?? config.googlechat?.webhook.publicUrl;
        const pubsubServiceAccount = config.googlechat?.pubsubServiceAccountEmail ?? config.googlechat?.credentials?.client_email;
        const authenticationConfigured = !config.googlechat?.disableSignatureVerification &&
            Boolean(endpointAudience ||
                config.googlechat?.googleChatProjectNumber ||
                (config.googlechat?.pubsubAudience && pubsubServiceAccount));
        requireExternalWebhookAuthentication({
            authenticated: authenticationConfigured,
            provider: "Google Chat",
            requirement: "googlechat.endpointUrl, googlechat.googleChatProjectNumber, or googlechat.pubsubAudience with a Pub/Sub service-account identity and signature verification enabled",
            webhook: config.googlechat?.webhook,
        });
        const authenticateWebhookRequest = createGoogleChatWebhookAuthenticator(config, runtime ?? {});
        super({
            codec: getBuiltinTargetCodec("googlechat"),
            config,
            id,
            options: {
                ...(authenticateWebhookRequest ? { authenticateWebhookRequest } : {}),
                defaultWebhook: { host: "127.0.0.1", path: "/googlechat/webhook", port: 8792 },
                endpointLabel: "webhook endpoint",
                matchesThread: matchesGoogleChatThread,
                normalizeWebhookPayload: normalizeGoogleChatWebhookPayload,
                platform: "googlechat",
                publicUrl: config.googlechat?.webhook.publicUrl,
                recorderPath: config.googlechat?.recorder.path
                    ? path.resolve(config.googlechat.recorder.path)
                    : undefined,
                webhook: config.googlechat?.webhook,
            },
        });
    }
}
export function normalizeGoogleChatWebhookPayload(payload) {
    payload = unwrapGoogleChatPubsubPayload(payload);
    if (!isRecord(payload)) {
        throw new CrablineError("Google Chat webhook payload must be an object", {
            kind: "inbound",
        });
    }
    const chat = optionalRecord(payload, "chat");
    if (chat && "messagePayload" in chat) {
        throw new CrablineError("Google Workspace add-on chat.messagePayload events are unsupported without a configured deployment identity", { kind: "inbound" });
    }
    const payloadMessage = optionalRecord(payload, "message");
    const message = payloadMessage ?? payload;
    if (payloadMessage && optionalString(payloadMessage, "threadId")) {
        return genericMockPayloadWithNativeThread({
            channelRule: GOOGLE_CHAT_SPACE_RULE,
            payload,
            threadRule: GOOGLE_CHAT_THREAD_RULE,
        });
    }
    const space = optionalRecord(message, "space");
    const thread = optionalRecord(message, "thread");
    const sender = optionalRecord(message, "sender");
    const spaceName = space ? optionalString(space, "name") : undefined;
    const threadName = thread ? optionalString(thread, "name") : undefined;
    const text = optionalString(message, "text") ?? optionalString(message, "argumentText");
    if (!spaceName || !text) {
        throw new CrablineError("Google Chat message payload requires space.name and text", {
            kind: "inbound",
        });
    }
    if (threadName && !threadName.startsWith(`${spaceName}/threads/`)) {
        throw new CrablineError("Google Chat thread.name must belong to message.space.name", {
            kind: "inbound",
        });
    }
    return {
        author: authorFromBotFlag(optionalString(sender ?? {}, "type") === "BOT"),
        ...(optionalString(message, "name") ? { id: optionalString(message, "name") } : {}),
        raw: payload,
        text,
        threadId: threadName
            ? requireNativeInboundId(threadName, GOOGLE_CHAT_THREAD_RULE, "Google Chat thread.name")
            : requireNativeInboundId(spaceName, GOOGLE_CHAT_SPACE_RULE, "Google Chat space.name"),
    };
}
function unwrapGoogleChatPubsubPayload(payload) {
    if (!isRecord(payload)) {
        return payload;
    }
    const message = optionalRecord(payload, "message");
    const data = message ? optionalString(message, "data") : undefined;
    if (!data || typeof payload.subscription !== "string") {
        return payload;
    }
    try {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)) {
            throw new Error("invalid base64");
        }
        const decoded = Buffer.from(data, "base64");
        if (decoded.toString("base64") !== data) {
            throw new Error("non-canonical base64");
        }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
    }
    catch {
        throw new CrablineError("Google Pub/Sub message.data must contain base64-encoded JSON.", {
            kind: "inbound",
        });
    }
}
