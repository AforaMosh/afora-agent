import { type Stats } from "node:fs";
import { type DirectoryReceipt, type DirectorySyncOutcome } from "./directory-durability.js";
import { type FileIdentityStat } from "./file-identity.js";
import { type PublishFileExclusiveSyncFailurePolicy } from "./publish-file-failure.js";
export type { PublishFileExclusiveCleanup, PublishFileExclusiveDirectorySyncFailure, PublishFileExclusiveFailureDetails, PublishFileExclusiveFailurePhase, PublishFileExclusiveSyncFailurePolicy, } from "./publish-file-failure.js";
export type PublishFileExclusiveStrategy = "link-or-copy" | "link-required" | "rename-noreplace";
export type PublishFileExclusiveResult = {
    method: "hardlink" | "exclusive-copy" | "rename-noreplace";
    identity: Stats;
    directorySync: DirectorySyncOutcome;
};
export declare function isHardlinkFallbackError(error: unknown): boolean;
export declare function publishFileExclusive(params: {
    sourcePath: string;
    targetPath: string;
    expectedSourceIdentity?: FileIdentityStat;
    strategy: PublishFileExclusiveStrategy;
    onSyncFailure?: PublishFileExclusiveSyncFailurePolicy;
    parentReceipt?: DirectoryReceipt;
}): Promise<PublishFileExclusiveResult>;
