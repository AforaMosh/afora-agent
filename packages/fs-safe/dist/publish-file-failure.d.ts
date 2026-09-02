import { FsSafeError } from "./errors.js";
import type { FileIdentityStat } from "./file-identity.js";
export type PublishFileExclusiveSyncFailurePolicy = "rollback" | "preserve";
export type PublishFileExclusiveDirectorySyncFailure = {
    status: "failed";
    code?: string;
};
export type PublishFileExclusiveFailurePhase = "copy-create" | "copy-verify" | "directory-sync" | "hardlink-create" | "hardlink-verify" | "rename-create" | "rename-verify";
export type PublishFileExclusiveCleanup = "removed" | "preserved" | "unknown";
export type PublishFileExclusiveFailureDetails = {
    phase: PublishFileExclusiveFailurePhase;
    targetCreated: boolean;
    targetIdentity?: FileIdentityStat;
    cleanup: PublishFileExclusiveCleanup;
    directorySync?: PublishFileExclusiveDirectorySyncFailure;
};
export type PublishFailureState = {
    phase: PublishFileExclusiveFailurePhase;
    targetCreated: boolean;
    targetIdentity?: FileIdentityStat;
    targetCleanupIdentity?: FileIdentityStat;
    preserveTarget: boolean;
    directorySync?: PublishFileExclusiveDirectorySyncFailure;
};
export declare function rememberCreatedTarget(state: PublishFailureState, identity: FileIdentityStat, phase: PublishFileExclusiveFailurePhase): void;
export declare function publicationFailure(error: unknown, state: PublishFailureState, cleanup: PublishFileExclusiveCleanup): FsSafeError;
export declare function directorySyncFailure(error: unknown): PublishFileExclusiveDirectorySyncFailure;
