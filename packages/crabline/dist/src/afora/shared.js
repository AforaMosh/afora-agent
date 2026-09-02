import { ADMIN_TOKEN_HEADER } from "../servers/http.js";
export const DEFAULT_ACCOUNT_ID = "default";
export const AFORA_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH = "crabline-fake-provider-capabilities.json";
export const AFORA_CRABLINE_PROVIDER_READINESS_PATH = "crabline-fake-provider-smoke.json";
/** @deprecated Use AFORA_CRABLINE_PROVIDER_READINESS_PATH. */
export const AFORA_CRABLINE_CHANNEL_SMOKE_PATH = AFORA_CRABLINE_PROVIDER_READINESS_PATH;
export const AFORA_CRABLINE_MANIFEST_PATH = "crabline-fake-provider-server.json";
export const AFORA_CRABLINE_ARTIFACT_STORE_DIRECTORY = ".crabline-smoke-artifacts";
export const AFORA_CRABLINE_ARTIFACT_POINTER_PATH = `${AFORA_CRABLINE_ARTIFACT_STORE_DIRECTORY}/current.json`;
export const AFORA_CRABLINE_DEFAULT_CHANNEL = "telegram";
const AFORA_CRABLINE_PROVIDER_PROBE_TIMEOUT_MS = 5_000;
const AFORA_CRABLINE_PROVIDER_PROBE_LABELS = {
    mattermost: "Mattermost users.me",
    matrix: "Matrix whoami",
    signal: "Signal check",
    slack: "Slack auth.test",
    telegram: "Telegram getMe",
    whatsapp: "WhatsApp phone number",
    zalo: "Zalo getMe",
};
export function createAforaCrablineProviderBridge(params) {
    const createAdapter = (manifest) => {
        const adapter = params.createAdapter(manifest);
        return {
            ...adapter,
            createInbound(input) {
                if (!readNonBlankString(input.text)) {
                    throw new Error("Afora Crabline inbound message text is required.");
                }
                if (input.conversation.kind !== "direct" && input.conversation.kind !== "group") {
                    throw new Error("Afora Crabline inbound conversation kind must be direct or group.");
                }
                return adapter.createInbound(input);
            },
        };
    };
    const bridge = {
        createAdapter,
        createAdapterFromManifest(manifest) {
            if (manifest.provider !== params.provider) {
                throw new Error(`Unsupported Afora provider binding: expected ${params.provider}, got ${manifest.provider}.`);
            }
            return createAdapter(manifest);
        },
        provider: params.provider,
    };
    return bridge;
}
export async function runAforaCrablineProviderProbe(provider, probe) {
    const signal = AbortSignal.timeout(AFORA_CRABLINE_PROVIDER_PROBE_TIMEOUT_MS);
    const timeoutError = (cause) => new Error(`Crabline ${AFORA_CRABLINE_PROVIDER_PROBE_LABELS[provider]} probe timed out after ${AFORA_CRABLINE_PROVIDER_PROBE_TIMEOUT_MS} ms.`, { cause });
    let onAbort;
    const timeout = new Promise((_, reject) => {
        onAbort = () => reject(timeoutError(signal.reason));
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
    });
    const probeResult = Promise.resolve()
        .then(() => probe(signal))
        .catch((error) => {
        if (signal.aborted) {
            throw timeoutError(error);
        }
        throw error;
    });
    try {
        return await Promise.race([probeResult, timeout]);
    }
    finally {
        if (onAbort) {
            signal.removeEventListener("abort", onAbort);
        }
    }
}
export function readString(value) {
    if (typeof value === "string" && value.trim()) {
        return value.trim();
    }
    if (typeof value === "number" || typeof value === "bigint") {
        return String(value);
    }
    return undefined;
}
export function readNonBlankString(value) {
    return typeof value === "string" && value.trim() ? value : undefined;
}
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function readInteger(value) {
    const stringValue = readString(value);
    if (!stringValue || !/^-?\d+$/u.test(stringValue)) {
        return undefined;
    }
    return Number(stringValue);
}
export function parseQaTarget(target) {
    const trimmed = target.trim();
    const invalidTarget = () => {
        throw new Error("Afora Crabline target must be a non-blank native id or a valid dm:<id>, group:<id>, channel:<id>, or thread:<id>/<thread-id> target.");
    };
    if (!trimmed) {
        return invalidTarget();
    }
    if (trimmed.startsWith("thread:")) {
        const encoded = trimmed.startsWith("thread:/v1/");
        const rest = trimmed.slice(encoded ? "thread:/v1/".length : "thread:".length);
        const slash = rest.indexOf("/");
        if (slash <= 0 || slash !== rest.lastIndexOf("/")) {
            return invalidTarget();
        }
        let id = rest.slice(0, slash).trim();
        let threadId = rest.slice(slash + 1).trim();
        if (encoded) {
            try {
                id = decodeURIComponent(id).trim();
                threadId = decodeURIComponent(threadId).trim();
            }
            catch {
                return invalidTarget();
            }
        }
        if (!id || !threadId) {
            return invalidTarget();
        }
        return { kind: "group", id, native: false, threadId };
    }
    if (trimmed.startsWith("channel:")) {
        const id = trimmed.slice("channel:".length).trim();
        return id ? { kind: "group", id, native: false } : invalidTarget();
    }
    if (trimmed.startsWith("group:")) {
        const id = trimmed.slice("group:".length).trim();
        return id ? { kind: "group", id, native: false } : invalidTarget();
    }
    if (trimmed.startsWith("dm:")) {
        const id = trimmed.slice("dm:".length).trim();
        return id ? { kind: "direct", id, native: false } : invalidTarget();
    }
    if (/^(?:dm|group|channel|thread)(?=\s*:|$)/iu.test(trimmed)) {
        return invalidTarget();
    }
    return { kind: "direct", id: trimmed, native: true };
}
export function canonicalConversationIdForInbound(input) {
    const conversationId = readNonBlankString(input.conversation.id);
    if (!conversationId) {
        throw new Error("Afora Crabline inbound conversation id is required.");
    }
    return conversationId.trim();
}
function encodeQaThreadComponent(value) {
    return value.replaceAll("%", "%25").replaceAll("/", "%2F");
}
export function qaTargetForInbound(input) {
    const conversationId = canonicalConversationIdForInbound(input);
    const threadId = input.threadId?.trim();
    const prefix = input.conversation.kind === "direct" ? "dm" : "group";
    return threadId
        ? `thread:/v1/${encodeQaThreadComponent(conversationId)}/${encodeQaThreadComponent(threadId)}`
        : `${prefix}:${conversationId}`;
}
export function createAdminInboundRequest(manifest) {
    return {
        providerHeaders: {
            "content-type": "application/json",
            [ADMIN_TOKEN_HEADER]: manifest.adminToken,
        },
        providerUrl: manifest.endpoints.adminInboundUrl,
    };
}
