import { type NativeFileHandle } from "./native-operations.js";
import type { Root } from "./root-impl.js";
import { type SidecarLockSnapshot } from "./sidecar-lock-reclaim.js";
import type { SidecarLockAcquireOptions, SidecarLockHandle } from "./sidecar-lock-types.js";
type SidecarFileHandle = Pick<NativeFileHandle, "close" | "stat" | "writeFile">;
export type HeldSidecarLock = {
    refCount: number;
    reentrantOwner?: string;
    handle: SidecarFileHandle;
    lockPath: string;
    snapshot: SidecarLockSnapshot;
    acquiredAt: number;
    metadata: Record<string, unknown>;
    releasePromise?: Promise<void>;
    lockRoot?: Root;
    parsePayload?: (raw: string) => unknown;
    compromiseTimer?: NodeJS.Timeout;
};
type SidecarLockAcquisitionContext = {
    held: Map<string, HeldSidecarLock>;
    reclaimGuards: Set<string>;
    ensureExitCleanupRegistered(): void;
    handleForHeldLock(normalizedTargetPath: string, held: HeldSidecarLock): SidecarLockHandle;
    releaseHeldLock(normalizedTargetPath: string, held: HeldSidecarLock, options?: {
        force?: boolean;
    }): Promise<boolean>;
};
export declare function acquireSidecarLock<TPayload extends Record<string, unknown>>(options: SidecarLockAcquireOptions<TPayload>, context: SidecarLockAcquisitionContext): Promise<SidecarLockHandle>;
export {};
