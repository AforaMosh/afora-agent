import type { Root } from "./root-impl.js";
import { type SidecarLockStaleSnapshot } from "./sidecar-lock-reclaim.js";
import type { SidecarLockCompromisedInfo, SidecarLockRetryOptions, SidecarLockStaleRecovery } from "./sidecar-lock-types.js";
export type FileLockSyncAcquireOptions<TPayload extends Record<string, unknown>> = {
    lockPath?: string;
    staleMs?: number;
    timeoutMs?: number;
    retry?: SidecarLockRetryOptions;
    staleRecovery?: SidecarLockStaleRecovery;
    reentrantOwner?: string;
    payload: () => TPayload;
    shouldReclaim?: (params: {
        lockPath: string;
        normalizedTargetPath: string;
        payload: unknown;
        staleMs: number;
        nowMs: number;
        heldByThisProcess: false;
    }) => boolean;
    shouldRemoveStaleLock?: (snapshot: SidecarLockStaleSnapshot) => boolean;
    parsePayload?: (raw: string) => unknown;
    lockRoot?: Root;
    onCompromised?: (info: SidecarLockCompromisedInfo) => void;
    compromiseCheckIntervalMs?: number;
};
export type FileLockSyncHandle = {
    lockPath: string;
    normalizedTargetPath: string;
    verifyStillHeld(): boolean;
    release(): void;
    [Symbol.dispose](): void;
};
export declare function acquireFileLockSync<TPayload extends Record<string, unknown>>(targetPath: string, options: FileLockSyncAcquireOptions<TPayload>): FileLockSyncHandle;
export declare function withFileLockSync<T, TPayload extends Record<string, unknown>>(targetPath: string, options: FileLockSyncAcquireOptions<TPayload>, fn: () => T): T;
