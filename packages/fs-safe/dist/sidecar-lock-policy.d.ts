import type { SidecarLockRetryOptions } from "./sidecar-lock-types.js";
export declare function computeSidecarLockDelayMs(retry: SidecarLockRetryOptions, attempt: number): number;
export declare const maxTransientLockDenials = 8;
export declare function isTransientLockFileDenial(error: unknown, lockPath: string): boolean;
export declare function sidecarLockPayloadIsStale(payload: unknown, staleMs: number, nowMs: number): boolean;
export declare function sidecarLockPayloadCreatedAtMs(payload: unknown): number | null;
export declare function defaultSidecarLockShouldReclaim(params: {
    lockPath: string;
    payload: unknown;
    staleMs: number;
    nowMs: number;
}): Promise<boolean>;
