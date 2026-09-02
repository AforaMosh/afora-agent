import { randomUUID } from "node:crypto";
import path from "node:path";
import { CrablineError } from "../../core/errors.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import { getBuiltinTargetCodec } from "../target-normalizers.js";
function createMessageId() {
    return `loopback-mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function cloneRawMessage(raw) {
    return { ...raw };
}
function cloneMessage(message) {
    return {
        ...message,
        author: { ...message.author },
        metadata: {
            dateSent: new Date(message.metadata.dateSent),
            edited: message.metadata.edited,
            ...(message.metadata.editedAt ? { editedAt: new Date(message.metadata.editedAt) } : {}),
        },
        raw: cloneRawMessage(message.raw),
    };
}
function toPostableText(message) {
    if (typeof message === "string") {
        return message;
    }
    if ("raw" in message) {
        return message.raw;
    }
    if ("markdown" in message) {
        return message.markdown;
    }
    return message.fallbackText ?? "[card]";
}
export class LoopbackChatAdapter {
    name = "loopback";
    persistMessageHistory = true;
    userName;
    #messages = new Map();
    #nextSequence = new Map();
    constructor(userName) {
        this.userName = userName;
    }
    addReaction() {
        return Promise.resolve();
    }
    channelIdFromThreadId(threadId) {
        const [address = threadId] = threadId.split("::");
        if (!address.startsWith("loopback+v2:")) {
            return address;
        }
        return this.decodeThreadId(threadId).channelId ?? address;
    }
    decodeThreadId(threadId) {
        const [address = threadId, rawThreadId] = threadId.split("::");
        const [platform, rawChannelOrId, rawId] = address.split(":");
        if (platform !== "loopback+v2" || !rawChannelOrId) {
            const [, channelId = address, id = address] = address.split(":");
            const decoded = { id };
            if (channelId) {
                decoded.channelId = channelId;
            }
            if (rawThreadId) {
                decoded.threadId = rawThreadId;
            }
            return decoded;
        }
        const decoded = {
            id: decodeURIComponent(rawId ?? rawChannelOrId),
        };
        if (rawId) {
            decoded.channelId = decodeURIComponent(rawChannelOrId);
        }
        if (rawThreadId) {
            decoded.threadId = decodeURIComponent(rawThreadId);
        }
        return decoded;
    }
    deleteMessage(threadId, messageId) {
        const messages = this.#messages.get(threadId) ?? [];
        this.#messages.set(threadId, messages.filter((entry) => entry.message.id !== messageId));
        return Promise.resolve();
    }
    editMessage(threadId, messageId, message) {
        const messages = this.#messages.get(threadId) ?? [];
        const stored = messages.find((entry) => entry.message.id === messageId);
        if (!stored) {
            throw new CrablineError(`Loopback message not found: ${messageId}`, { kind: "inbound" });
        }
        const existing = stored.message;
        const text = toPostableText(message);
        existing.text = text;
        existing.formatted = text;
        existing.metadata.edited = true;
        existing.metadata.editedAt = new Date();
        existing.raw.text = text;
        return Promise.resolve({ id: existing.id, raw: cloneRawMessage(existing.raw), threadId });
    }
    encodeThreadId(platformData) {
        const address = platformData.channelId
            ? `loopback+v2:${encodeURIComponent(platformData.channelId)}:${encodeURIComponent(platformData.id)}`
            : `loopback+v2:${encodeURIComponent(platformData.id)}`;
        return platformData.threadId
            ? `${address}::${encodeURIComponent(platformData.threadId)}`
            : address;
    }
    fetchMessages(threadId, options) {
        const storedMessages = [...(this.#messages.get(threadId) ?? [])];
        if (options?.limit !== undefined &&
            (!Number.isSafeInteger(options.limit) || options.limit <= 0)) {
            throw new CrablineError("Loopback message limit must be a positive safe integer.", {
                kind: "config",
            });
        }
        const limit = options?.limit ?? storedMessages.length;
        let cursor;
        if (options?.cursor) {
            if (!/^[1-9]\d*$/u.test(options.cursor)) {
                throw new CrablineError("Loopback message cursor must be a positive safe integer.", {
                    kind: "config",
                });
            }
            cursor = Number(options.cursor);
            if (!Number.isSafeInteger(cursor) || cursor > (this.#nextSequence.get(threadId) ?? 0)) {
                throw new CrablineError("Loopback message cursor must be a positive safe integer within message history.", { kind: "config" });
            }
        }
        const eligibleMessages = cursor === undefined
            ? storedMessages
            : storedMessages.filter((entry) => entry.sequence < cursor);
        const page = eligibleMessages.slice(-limit);
        const result = {
            messages: page.map((entry) => cloneMessage(entry.message)),
        };
        if (eligibleMessages.length > page.length && page[0]) {
            result.nextCursor = String(page[0].sequence);
        }
        return Promise.resolve(result);
    }
    fetchThread(threadId) {
        return Promise.resolve({
            channelId: this.channelIdFromThreadId(threadId),
            id: threadId,
            isDM: true,
            metadata: {},
        });
    }
    handleWebhook(_request) {
        return Promise.resolve(new Response("loopback adapter has no webhook surface", { status: 501 }));
    }
    isDM() {
        return true;
    }
    parseMessage(raw) {
        return {
            author: {
                isMe: raw.author === "assistant",
                userName: raw.author === "assistant" ? this.userName : "loopback",
            },
            formatted: raw.text,
            id: raw.id,
            metadata: {
                dateSent: new Date(raw.timestamp),
                edited: false,
            },
            raw: cloneRawMessage(raw),
            text: raw.text,
            threadId: raw.threadId,
        };
    }
    postMessage(threadId, message) {
        const text = toPostableText(message);
        const raw = {
            author: "assistant",
            id: createMessageId(),
            text,
            threadId,
            timestamp: new Date().toISOString(),
        };
        const parsed = this.parseMessage(raw);
        this.#append(threadId, parsed);
        return Promise.resolve({ id: raw.id, raw: cloneRawMessage(raw), threadId });
    }
    removeReaction() {
        return Promise.resolve();
    }
    renderFormatted(content) {
        return content;
    }
    startTyping() {
        return Promise.resolve();
    }
    ingestUserMessage(threadId, text) {
        const raw = {
            author: "user",
            id: createMessageId(),
            text,
            threadId,
            timestamp: new Date().toISOString(),
        };
        const parsed = this.parseMessage(raw);
        this.#append(threadId, parsed);
        return cloneMessage(parsed);
    }
    listSince(threadId, since) {
        const sinceTime = new Date(since).getTime();
        return (this.#messages.get(threadId) ?? [])
            .map((entry) => entry.message)
            .filter((message) => message.metadata.dateSent.getTime() >= sinceTime)
            .map(cloneMessage);
    }
    #append(threadId, message) {
        const bucket = this.#messages.get(threadId) ?? [];
        const sequence = (this.#nextSequence.get(threadId) ?? 0) + 1;
        bucket.push({ message: cloneMessage(message), sequence });
        this.#messages.set(threadId, bucket);
        this.#nextSequence.set(threadId, sequence);
    }
}
export class LoopbackProviderAdapter extends LocalMockProviderAdapter {
    constructor(id, config, _userName) {
        super({
            codec: getBuiltinTargetCodec("loopback"),
            config,
            id,
            options: {
                defaultWebhook: { host: "127.0.0.1", path: "/loopback/webhook", port: 0 },
                endpointLabel: "webhook endpoint",
                platform: "loopback",
                recorderPath: path.resolve(".crabline", "recorders", `${id}-${randomUUID()}.jsonl`),
            },
        });
    }
}
