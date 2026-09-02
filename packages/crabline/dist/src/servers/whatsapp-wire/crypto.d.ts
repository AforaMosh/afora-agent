import { Buffer } from "node:buffer";
export declare const KEY_BUNDLE_TYPE: Buffer<ArrayBuffer>;
export declare const NOISE_MODE = "Noise_XX_25519_AESGCM_SHA256\0\0\0\0";
export declare const NOISE_WA_HEADER: Buffer<ArrayBuffer>;
export type KeyPair = {
    private: Buffer;
    public: Buffer;
};
export type SignedKeyPair = {
    keyId: number;
    keyPair: KeyPair;
    signature: Buffer;
};
type NativeCurveBackend = {
    generateKeyPair(): KeyPair;
    sharedKey(privateKey: Uint8Array, publicKey: Uint8Array): Buffer;
};
type CurveApi = NativeCurveBackend & {
    sign(privateKey: Uint8Array, message: Uint8Array): Buffer;
};
export declare function createCurve(nativeBackend?: NativeCurveBackend): CurveApi;
export declare const Curve: CurveApi;
export declare function aesEncryptGCM(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array, additionalData: Uint8Array): Buffer;
export declare function aesDecryptGCM(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array, additionalData: Uint8Array): Buffer;
export declare function encodeBigEndian(value: number, length?: number): Buffer;
export declare function hkdf(input: Uint8Array, length: number, params: {
    info: string;
    salt: Uint8Array;
}): Buffer<ArrayBuffer>;
export declare function sha256(input: Uint8Array): Buffer;
export declare function signedKeyPair(identityKeyPair: KeyPair, keyId: number): SignedKeyPair;
export {};
