import type { BinaryNode } from "./binary-node.js";
import { KEY_BUNDLE_TYPE, type KeyPair, type SignedKeyPair } from "./crypto.js";
export declare function xmppPreKey(pair: KeyPair, id: number): BinaryNode;
export declare function xmppSignedPreKey(key: SignedKeyPair): BinaryNode;
export { KEY_BUNDLE_TYPE };
