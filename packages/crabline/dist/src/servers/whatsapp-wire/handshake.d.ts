import { Buffer } from "node:buffer";
export type HandshakeMessage = {
    clientFinish?: {
        payload?: Buffer;
        staticKey?: Buffer;
    };
    clientHello?: {
        ephemeral?: Buffer;
    };
    serverHello?: {
        ephemeral: Uint8Array;
        payload: Uint8Array;
        staticKey: Uint8Array;
    };
};
export declare function decodeHandshakeMessage(data: Uint8Array): HandshakeMessage;
export declare function encodeHandshakeMessage(message: HandshakeMessage): Buffer;
