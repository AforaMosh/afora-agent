import { Buffer } from "node:buffer";
export type BinaryNode = {
    attrs: Record<string, string>;
    content?: BinaryNode[] | string | Uint8Array;
    tag: string;
};
export declare const WHATSAPP_BINARY_NODE_MAX_COMPRESSED_BYTES: number;
export declare const WHATSAPP_BINARY_NODE_MAX_DECOMPRESSED_BYTES: number;
export declare const WHATSAPP_BINARY_NODE_MAX_DEPTH = 128;
export declare const WHATSAPP_BINARY_NODE_MAX_NODES = 32768;
export declare const WHATSAPP_BINARY_NODE_MAX_LIST_ITEMS = 131072;
export declare const S_WHATSAPP_NET = "@s.whatsapp.net";
export declare function decodeBinaryNode(frame: Buffer): Promise<BinaryNode>;
export declare function encodeBinaryNode(node: BinaryNode): Buffer;
