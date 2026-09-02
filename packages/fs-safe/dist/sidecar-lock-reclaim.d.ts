import { type Stats } from "node:fs";
import type { Root } from "./root-impl.js";
export type SidecarLockStaleSnapshot = {
    lockPath: string;
    normalizedTargetPath: string;
    raw: string;
    payload: unknown;
};
export type SidecarLockSnapshot = {
    raw?: string;
    payload: unknown;
    stat?: Stats;
    ownershipToken?: string;
};
export declare function readSidecarLockOwnershipToken(raw: string): string | undefined;
export declare function serializeSidecarLockPayload(payload: Record<string, unknown>): {
    raw: string;
    ownershipToken: string;
};
export declare function relativeSidecarLockPath(lockRoot: Root, lockPath: string): string;
export declare function parseSidecarLockPayload(raw: string, parser?: (raw: string) => unknown): unknown;
export declare function readSidecarLockSnapshot(lockPath: string, options?: {
    lockRoot?: Root;
    parsePayload?: (raw: string) => unknown;
    rejectNonFile?: boolean;
    allowDescriptorIdentityDrift?: boolean;
}): Promise<SidecarLockSnapshot | null>;
export declare function readSidecarLockSnapshotSync(lockPath: string, parsePayload?: (raw: string) => unknown, options?: {
    rejectNonFile?: boolean;
}): SidecarLockSnapshot | null;
export declare function removeSidecarLockIfUnchangedSync(lockPath: string, observed: SidecarLockSnapshot): boolean;
export declare function sidecarLockSnapshotMatches(current: SidecarLockSnapshot, observed: SidecarLockSnapshot): boolean;
export declare function removeSidecarLockIfUnchanged(lockPath: string, observed: SidecarLockSnapshot | null, options?: {
    lockRoot?: Root;
    parsePayload?: (raw: string) => unknown;
}): Promise<boolean>;
export declare function sidecarLockSnapshotStillPresent(lockPath: string, observed: SidecarLockSnapshot | null, options?: {
    lockRoot?: Root;
    parsePayload?: (raw: string) => unknown;
}): Promise<boolean>;
export declare function sidecarReclaimGuardExists(pathname: string): Promise<boolean>;
export declare function tryAcquireSidecarReclaimGuard(reclaimGuards: Set<string>, reclaimGuardPath: string): Promise<boolean>;
export declare function releaseSidecarReclaimGuard(reclaimGuards: Set<string>, reclaimGuardPath: string): Promise<void>;
export declare function removeStaleSidecarLockIfAllowed(params: {
    lockPath: string;
    normalizedTargetPath: string;
    snapshot: SidecarLockSnapshot;
    shouldRemoveStaleLock?: (snapshot: SidecarLockStaleSnapshot) => boolean | Promise<boolean>;
    lockRoot?: Root;
    parsePayload?: (raw: string) => unknown;
}): Promise<"removed" | "changed" | "not-approved">;
