import { createPublicKey } from "node:crypto";
import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import { createCachedJwtKeyResolver, readBearerToken, resolveHttpCacheExpiry, verifySignedJwt, } from "../signed-jwt.js";
import { getBuiltinTargetCodec, MSTEAMS_CONVERSATION_ID_RULE } from "../target-normalizers.js";
import { authorFromBotFlag, genericMockPayloadWithNativeThread, isRecord, optionalRecord, optionalString, requireNativeInboundId, } from "./native-local-mock.js";
import { requireExternalWebhookAuthentication } from "./external-webhook-auth.js";
export function resolveMsTeamsAdapterConfig(config, env = process.env) {
    return {
        appId: config.msteams?.appId ?? env.TEAMS_APP_ID ?? "local-mock-teams-app",
        appPassword: config.msteams?.appPassword ?? env.TEAMS_APP_PASSWORD ?? "local-mock-secret",
        appTenantId: config.msteams?.appTenantId,
        appType: config.msteams?.appType,
        userName: config.msteams?.userName,
    };
}
const BOT_CONNECTOR_ISSUER = "https://api.botframework.com";
const BOT_CONNECTOR_OPENID_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";
export function createMsTeamsWebhookAuthenticator(config, runtime = {}) {
    const appId = config.msteams?.appId ?? (runtime.env ?? process.env).TEAMS_APP_ID;
    if (!appId) {
        return undefined;
    }
    const fetchImpl = runtime.fetch ?? fetch;
    const resolveSigningKey = createCachedJwtKeyResolver({
        async fetchKeys(signal) {
            const fetchedAt = runtime.now?.() ?? Date.now();
            const metadataResponse = await fetchImpl(BOT_CONNECTOR_OPENID_URL, { signal });
            if (!metadataResponse.ok) {
                throw new Error(`Bot Connector metadata fetch failed with HTTP ${metadataResponse.status}.`);
            }
            const metadataExpiry = resolveHttpCacheExpiry(metadataResponse, fetchedAt);
            const metadata = (await metadataResponse.json());
            if (typeof metadata.jwks_uri !== "string") {
                throw new Error("Bot Connector metadata omitted jwks_uri.");
            }
            const keysResponse = await fetchImpl(metadata.jwks_uri, { signal });
            if (!keysResponse.ok) {
                throw new Error(`Bot Connector key fetch failed with HTTP ${keysResponse.status}.`);
            }
            const keyExpiry = resolveHttpCacheExpiry(keysResponse, fetchedAt);
            const keys = (await keysResponse.json());
            if (!Array.isArray(keys.keys)) {
                throw new Error("Bot Connector key response omitted keys.");
            }
            return {
                expiresAt: Math.min(metadataExpiry, keyExpiry),
                values: keys.keys,
            };
        },
        keyId: (value) => value.kid,
        now: runtime.now,
        refreshCooldownMs: runtime.unknownKeyCooldownMs,
        timeoutMs: runtime.keyFetchTimeoutMs,
        unknownKeyMessage: "Bot Connector JWT signing key is unknown.",
    });
    return async (request, rawBody) => {
        const token = readBearerToken(request);
        if (!token) {
            return new Response("unauthorized", {
                headers: { "www-authenticate": "Bearer" },
                status: 401,
            });
        }
        try {
            const payload = JSON.parse(rawBody);
            if (!isRecord(payload)) {
                throw new Error("Bot Connector activity must be an object.");
            }
            const channelId = optionalString(payload, "channelId");
            const serviceUrl = optionalString(payload, "serviceUrl");
            if (channelId !== "msteams" || !serviceUrl) {
                throw new Error("Bot Connector activity requires channelId=msteams and serviceUrl.");
            }
            const claims = await verifySignedJwt({
                audience: appId,
                issuers: [BOT_CONNECTOR_ISSUER],
                now: runtime.now,
                async resolveKey(header) {
                    const key = await resolveSigningKey(header);
                    if (key.endorsements && !key.endorsements.includes(channelId)) {
                        throw new Error("Bot Connector JWT key does not endorse the activity channel.");
                    }
                    return createPublicKey({ format: "jwk", key });
                },
                token,
            });
            if (claims.serviceurl !== serviceUrl) {
                throw new Error("Bot Connector serviceurl claim does not match the activity.");
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
export class MsTeamsProviderAdapter extends LocalMockProviderAdapter {
    constructor(id, config, _userName, runtime) {
        const authRuntime = runtime ?? {};
        requireExternalMsTeamsWebhookAuthentication(config, authRuntime.env ?? process.env);
        const authenticateWebhookRequest = createMsTeamsWebhookAuthenticator(config, authRuntime);
        super({
            codec: getBuiltinTargetCodec("msteams"),
            config,
            id,
            options: {
                ...(authenticateWebhookRequest ? { authenticateWebhookRequest } : {}),
                defaultWebhook: { host: "127.0.0.1", path: "/msteams/webhook", port: 8791 },
                endpointLabel: "webhook endpoint",
                normalizeWebhookPayload: normalizeMsTeamsWebhookPayload,
                platform: "msteams",
                publicUrl: config.msteams?.webhook.publicUrl,
                recorderPath: config.msteams?.recorder.path
                    ? path.resolve(config.msteams.recorder.path)
                    : undefined,
                webhook: config.msteams?.webhook,
            },
        });
    }
}
function requireExternalMsTeamsWebhookAuthentication(config, env) {
    const appId = config.msteams?.appId ?? env.TEAMS_APP_ID;
    requireExternalWebhookAuthentication({
        authenticated: Boolean(appId),
        provider: "Microsoft Teams",
        requirement: "msteams.appId or TEAMS_APP_ID",
        webhook: config.msteams?.webhook,
    });
}
export function normalizeMsTeamsWebhookPayload(payload) {
    if (!isRecord(payload)) {
        throw new CrablineError("Microsoft Teams webhook payload must be an object", {
            kind: "inbound",
        });
    }
    if (optionalRecord(payload, "message")) {
        return genericMockPayloadWithNativeThread({
            channelRule: MSTEAMS_CONVERSATION_ID_RULE,
            payload,
            threadRule: MSTEAMS_CONVERSATION_ID_RULE,
        });
    }
    if (optionalString(payload, "type") !== "message") {
        throw new CrablineError("Microsoft Teams activity payload requires type=message", {
            kind: "inbound",
        });
    }
    const conversation = optionalRecord(payload, "conversation");
    const from = optionalRecord(payload, "from");
    const channelId = optionalString(payload, "channelId");
    const conversationId = conversation ? optionalString(conversation, "id") : undefined;
    const text = optionalString(payload, "text");
    if (channelId !== "msteams" || !conversationId || !text) {
        throw new CrablineError("Microsoft Teams activity payload requires channelId=msteams, conversation.id, and text", {
            kind: "inbound",
        });
    }
    return {
        author: authorFromBotFlag(optionalString(from ?? {}, "role") === "bot"),
        ...(optionalString(payload, "id") ? { id: optionalString(payload, "id") } : {}),
        raw: payload,
        text,
        threadId: requireNativeInboundId(conversationId, MSTEAMS_CONVERSATION_ID_RULE, "Microsoft Teams conversation.id"),
    };
}
