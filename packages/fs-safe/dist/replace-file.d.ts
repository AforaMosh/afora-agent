import syncFs from "node:fs";
import fs from "node:fs/promises";
import { type ReplaceFileAtomicRestoreCleanup, type ReplaceFileAtomicRestoreFailureDetails, type ReplaceFileCopyFallbackRestorePolicy, type ReplaceFileDestinationHardlinkPolicy } from "./replace-file-copy-fallback.js";
export type ReplaceFileAtomicFileSystem = {
    promises: Pick<typeof fs, "mkdir" | "writeFile" | "rename" | "copyFile" | "unlink" | "rm" | "open" | "stat" | "lstat"> & {
        /** @deprecated Accepted for adapter compatibility but never called. */
        chmod?: typeof fs.chmod;
    };
};
export type ReplaceFileAtomicSyncFileSystem = Pick<typeof syncFs, "mkdirSync" | "readFileSync" | "writeFileSync" | "renameSync" | "copyFileSync" | "unlinkSync" | "rmSync" | "openSync" | "fsyncSync" | "closeSync" | "fstatSync" | "statSync" | "lstatSync" | "ftruncateSync" | "readSync" | "writeSync"> & {
    /** @deprecated Accepted for adapter compatibility but never called. */
    chmodSync?: typeof syncFs.chmodSync;
    fchmodSync?: typeof syncFs.fchmodSync;
};
export type { ReplaceFileAtomicRestoreCleanup, ReplaceFileAtomicRestoreFailureDetails, ReplaceFileCopyFallbackRestorePolicy, ReplaceFileDestinationHardlinkPolicy, };
type ReplaceFileAtomicBaseOptions = {
    filePath: string;
    content: string | Uint8Array;
    dirMode?: number;
    mode?: number;
    preserveExistingMode?: boolean;
    tempPrefix?: string;
    renameMaxRetries?: number;
    renameRetryBaseDelayMs?: number;
    copyFallbackOnPermissionError?: boolean;
    copyFallbackRestore?: ReplaceFileCopyFallbackRestorePolicy;
    maxRestoreBytes?: number;
    destinationHardlinks?: ReplaceFileDestinationHardlinkPolicy;
    syncTempFile?: boolean;
    syncParentDir?: boolean;
    throwOnCleanupError?: boolean;
};
export type ReplaceFileAtomicOptions = ReplaceFileAtomicBaseOptions & {
    fileSystem?: ReplaceFileAtomicFileSystem;
    beforeRename?: (params: {
        filePath: string;
        tempPath: string;
    }) => Promise<void>;
};
export type ReplaceFileAtomicSyncOptions = ReplaceFileAtomicBaseOptions & {
    fileSystem?: ReplaceFileAtomicSyncFileSystem;
    beforeRename?: (params: {
        filePath: string;
        tempPath: string;
    }) => void;
};
export type ReplaceFileAtomicResult = {
    method: "rename" | "copy-fallback";
};
export declare function replaceFileAtomic(options: ReplaceFileAtomicOptions): Promise<ReplaceFileAtomicResult>;
export declare function replaceFileAtomicSync(options: ReplaceFileAtomicSyncOptions): ReplaceFileAtomicResult;
