import type { FileHandle } from "node:fs/promises";
import type { FileIdentityStat } from "./file-identity.js";
export type FsSafeTestHooks = {
    afterPreOpenLstat?: (filePath: string) => Promise<void> | void;
    beforeOpen?: (filePath: string, flags: number) => Promise<void> | void;
    afterOpen?: (filePath: string, handle: FileHandle) => Promise<void> | void;
    beforeArchiveOutputMutation?: (operation: "mkdir" | "chmod", targetPath: string) => Promise<void> | void;
    beforeFileStorePruneDescend?: (dirPath: string) => Promise<void> | void;
    beforeFileStoreSyncPrivateWrite?: (filePath: string) => void;
    beforeRootFallbackMutation?: (operation: "mkdir" | "move" | "remove", targetPath: string) => Promise<void> | void;
    afterPinnedWriteFallbackRename?: (targetPath: string) => Promise<void> | void;
    beforeSiblingTempWrite?: (tempPath: string) => Promise<void> | void;
    beforeSidecarLockSnapshotOpen?: (lockPath: string) => Promise<void> | void;
    beforeTrashMove?: (targetPath: string, destPath: string) => void;
    afterPublishTargetCreated?: (method: "hardlink" | "exclusive-copy" | "rename-noreplace", targetPath: string, identity: FileIdentityStat) => Promise<void> | void;
    beforePublishDirectorySync?: (method: "hardlink" | "exclusive-copy" | "rename-noreplace", targetPath: string, identity: FileIdentityStat) => Promise<void> | void;
};
export declare function getFsSafeTestHooks(): FsSafeTestHooks | undefined;
export declare function __setFsSafeTestHooksForTest(hooks?: FsSafeTestHooks): void;
