import { Buffer } from "node:buffer";
import type { Server } from "node:http";
import { type KeyPair, type SignedKeyPair } from "./whatsapp-wire/crypto.js";
import type { ServerRequestEvent } from "./http.js";
export declare const MAX_WHATSAPP_NOISE_FRAME_BYTES: number;
export declare const MAX_WHATSAPP_WEBSOCKET_BUFFERED_BYTES: number;
export declare const MAX_WHATSAPP_WEBSOCKET_MESSAGE_BYTES: number;
export declare const MAX_WHATSAPP_NOISE_BUFFER_CHUNKS = 1024;
export declare const MAX_WHATSAPP_NOISE_FRAMES_PER_MESSAGE = 1024;
export declare const WHATSAPP_WEBSOCKET_SEND_TIMEOUT_MS = 5000;
export declare const MAX_WHATSAPP_WEBSOCKET_FRAGMENTS = 1024;
export declare const MAX_WHATSAPP_SIGNAL_BUNDLES = 1024;
export declare const MAX_WHATSAPP_WEBSOCKET_CLOSE_REASON_BYTES = 123;
type NodeBuffer = Buffer<ArrayBufferLike>;
type WhatsAppWebSocketRawData = NodeBuffer | ArrayBuffer | NodeBuffer[];
type WhatsAppWebSocketSendTarget = {
    bufferedAmount: number;
    readyState: number;
    send(data: Uint8Array, callback: (error?: Error) => void): void;
    terminate(): void;
};
export type WhatsAppBaileysWebSocketServer = {
    close(): Promise<void>;
    prepareInboundMessage(message: WhatsAppBaileysInboundMessage): PreparedWhatsAppBaileysInboundDelivery | undefined;
};
export type WhatsAppBaileysWebSocketServerParams = {
    accessToken: string;
    appendEvent(event: ServerRequestEvent): Promise<void>;
    httpServer: Server;
    maxPendingInboundMessages?: number | undefined;
    path: string;
    selfJid: string;
};
export type PreparedWhatsAppBaileysInboundDelivery = {
    cancel(): void;
    commit(): Promise<"delivered" | "queued">;
};
export type WhatsAppBaileysInboundMessage = {
    key: {
        fromMe: boolean;
        id: string;
        participant?: string | undefined;
        remoteJid: string;
    };
    message: {
        conversation: string;
    };
    messageTimestamp: number;
    pushName?: string | undefined;
};
export declare function resolveMaxPendingWhatsAppInboundMessages(value: number | undefined): number;
export type MockSignalBundle = {
    identityKey: KeyPair;
    preKey: KeyPair;
    preKeyId: number;
    registrationId: number;
    signedPreKey: SignedKeyPair;
};
export declare class WhatsAppSignalBundleStore {
    #private;
    private readonly maxBundles;
    constructor(maxBundles?: number);
    get size(): number;
    associateLid(phoneNumberJid: string, lidJid: string): void;
    resolveMany(jids: string[]): MockSignalBundle[];
    decryptDirectMessage(params: {
        ciphertext: Uint8Array;
        recipientJid: string;
        remoteJid: string;
        type: "msg" | "pkmsg";
    }): Promise<Buffer | undefined>;
}
export declare function createSerializedMessageHandler<T>(processMessage: (message: T) => Promise<void>, onError: (error: unknown) => void, options?: {
    maxPendingBytes?: number | undefined;
    maxPendingMessages?: number | undefined;
    sizeOf?: ((message: T) => number) | undefined;
}): (message: T) => Promise<void>;
export declare class WhatsAppNoiseFrameDecoder {
    #private;
    get bufferedBytes(): number;
    decodeFrames(data: WhatsAppWebSocketRawData): NodeBuffer[];
}
export declare function sendWhatsAppWebSocketPayload(socket: WhatsAppWebSocketSendTarget, payload: Uint8Array): Promise<void>;
export declare function resolveWhatsAppWebSocketClose(error: unknown): {
    code: 1002 | 1009 | 1011;
    reason: string;
};
export declare function attachWhatsAppBaileysWebSocketServer(params: WhatsAppBaileysWebSocketServerParams): WhatsAppBaileysWebSocketServer;
export declare function parseWhatsAppWebSocketUpgradeUrl(requestTarget: string | undefined): URL | undefined;
export declare function signalBundleIdentityKey(jid: string): string;
export {};
