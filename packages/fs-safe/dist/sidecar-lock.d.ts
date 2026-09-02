import type { SidecarLockAcquireOptions, SidecarLockHandle, SidecarLockHeldEntry, WithSidecarLockOptions } from "./sidecar-lock-types.js";
export type { SidecarLockStaleSnapshot } from "./sidecar-lock-reclaim.js";
export type { SidecarLockAcquireOptions, SidecarLockCompromisedInfo, SidecarLockHandle, SidecarLockHeldEntry, SidecarLockRetryOptions, SidecarLockStaleRecovery, WithSidecarLockOptions, } from "./sidecar-lock-types.js";
export declare function createSidecarLockManager(key: string): {
    acquire: <TPayload extends Record<string, unknown>>(options: SidecarLockAcquireOptions<TPayload>) => Promise<SidecarLockHandle>;
    withLock: <T, TPayload extends Record<string, unknown>>(options: SidecarLockAcquireOptions<TPayload>, fn: () => Promise<T>) => Promise<T>;
    drain: () => Promise<void>;
    reset: () => void;
    heldEntries: () => SidecarLockHeldEntry[];
};
export declare function withSidecarLock<T, TPayload extends Record<string, unknown>>(targetPath: string, options: WithSidecarLockOptions<TPayload>, fn: () => Promise<T>): Promise<T>;
