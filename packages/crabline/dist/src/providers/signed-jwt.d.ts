import { type KeyObject } from "node:crypto";
type JwtHeader = {
    alg: string;
    kid: string;
};
export type JwtClaims = Record<string, unknown>;
export type RemoteJwtKeySet<T> = {
    expiresAt: number;
    values: readonly T[];
};
export declare function readBearerToken(request: Request): string | undefined;
export declare function resolveHttpCacheExpiry(response: Response, now: number): number;
export declare function createCachedJwtKeyResolver<T>(params: {
    fetchKeys(signal: AbortSignal): Promise<RemoteJwtKeySet<T>>;
    keyId(value: T): string | undefined;
    now?: (() => number) | undefined;
    refreshCooldownMs?: number | undefined;
    timeoutMs?: number | undefined;
    unknownKeyMessage: string;
}): (header: JwtHeader) => Promise<T>;
export declare function verifySignedJwt(params: {
    audience: string;
    clockSkewSeconds?: number | undefined;
    issuers: readonly string[];
    now?: (() => number) | undefined;
    resolveKey(header: JwtHeader): Promise<KeyObject>;
    token: string;
}): Promise<JwtClaims>;
export {};
