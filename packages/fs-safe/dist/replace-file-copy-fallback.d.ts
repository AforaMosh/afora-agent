import syncFs from "node:fs";
export type ReplaceFileDestinationHardlinkPolicy = "reject";
export type ReplaceFileCopyFallbackRestorePolicy = "restore-original" | "none";
export type ReplaceFileAtomicRestoreCleanup = "restored" | "restore-failed";
export type ReplaceFileAtomicRestoreFailureDetails = {
    cleanup: ReplaceFileAtomicRestoreCleanup;
};
type AsyncFallbackFs = {
    lstat: typeof import("node:fs/promises").lstat;
    open: typeof import("node:fs/promises").open;
    rm: typeof import("node:fs/promises").rm;
    unlink: typeof import("node:fs/promises").unlink;
};
type SyncFallbackFs = Pick<typeof syncFs, "closeSync" | "fstatSync" | "fsyncSync" | "ftruncateSync" | "lstatSync" | "openSync" | "readSync" | "rmSync" | "unlinkSync" | "writeSync">;
export declare function assertDestinationHardlinkPolicy(fsModule: AsyncFallbackFs, dest: string, policy?: ReplaceFileDestinationHardlinkPolicy): Promise<void>;
export declare function assertDestinationHardlinkPolicySync(fsModule: SyncFallbackFs, dest: string, policy?: ReplaceFileDestinationHardlinkPolicy): void;
export declare function copyFallbackReplace(params: {
    fsModule: AsyncFallbackFs;
    src: string;
    dest: string;
    destinationHardlinks?: ReplaceFileDestinationHardlinkPolicy;
    restore: ReplaceFileCopyFallbackRestorePolicy;
    maxRestoreBytes?: number;
    sync: boolean;
}): Promise<void>;
export declare function copyFallbackReplaceSync(params: {
    fsModule: SyncFallbackFs;
    src: string;
    dest: string;
    destinationHardlinks?: ReplaceFileDestinationHardlinkPolicy;
    restore: ReplaceFileCopyFallbackRestorePolicy;
    maxRestoreBytes?: number;
    fchmodSync?: (fd: number, mode: number) => void;
    sync: boolean;
}): void;
export {};
