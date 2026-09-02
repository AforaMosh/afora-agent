import type { Root } from "./root-impl.js";
import { type SidecarLockSnapshot } from "./sidecar-lock-reclaim.js";
import type { SidecarLockHandle } from "./sidecar-lock-types.js";
export declare function createSidecarLockHandle(params: {
    lockPath: string;
    normalizedTargetPath: string;
    verifyStillHeld: () => Promise<boolean>;
    release: () => Promise<unknown>;
}): SidecarLockHandle;
export declare function createHeldSidecarLockHandle(params: {
    normalizedTargetPath: string;
    held: {
        lockPath: string;
        snapshot: SidecarLockSnapshot;
        lockRoot?: Root;
        parsePayload?: (raw: string) => unknown;
    };
    release: () => Promise<unknown>;
}): SidecarLockHandle;
