import type { ProviderConfig } from "../../config/schema.js";
import { LocalMockProviderAdapter } from "../local-mock.js";
import type { LoopbackMessage, LoopbackRawMessage, ProviderAdapter } from "../types.js";
type ThreadAddress = {
    channelId?: string | undefined;
    id: string;
    threadId?: string | undefined;
};
type PostableMessage = string | {
    card: unknown;
    fallbackText?: string;
} | {
    markdown: string;
} | {
    raw: string;
};
export declare class LoopbackChatAdapter {
    #private;
    readonly name = "loopback";
    readonly persistMessageHistory = true;
    readonly userName: string;
    constructor(userName: string);
    addReaction(): Promise<void>;
    channelIdFromThreadId(threadId: string): string;
    decodeThreadId(threadId: string): ThreadAddress;
    deleteMessage(threadId: string, messageId: string): Promise<void>;
    editMessage(threadId: string, messageId: string, message: PostableMessage): Promise<{
        id: string;
        raw: LoopbackRawMessage;
        threadId: string;
    }>;
    encodeThreadId(platformData: ThreadAddress): string;
    fetchMessages(threadId: string, options?: {
        cursor?: string;
        limit?: number;
    }): Promise<{
        messages: LoopbackMessage[];
        nextCursor?: string;
    }>;
    fetchThread(threadId: string): Promise<{
        channelId: string;
        id: string;
        isDM: boolean;
        metadata: {};
    }>;
    handleWebhook(_request?: Request): Promise<Response>;
    isDM(): boolean;
    parseMessage(raw: LoopbackRawMessage): LoopbackMessage;
    postMessage(threadId: string, message: PostableMessage): Promise<{
        id: string;
        raw: LoopbackRawMessage;
        threadId: string;
    }>;
    removeReaction(): Promise<void>;
    renderFormatted(content: string): string;
    startTyping(): Promise<void>;
    ingestUserMessage(threadId: string, text: string): LoopbackMessage;
    listSince(threadId: string, since: string): LoopbackMessage[];
}
export declare class LoopbackProviderAdapter extends LocalMockProviderAdapter implements ProviderAdapter {
    constructor(id: string, config: ProviderConfig, _userName: string);
}
export {};
