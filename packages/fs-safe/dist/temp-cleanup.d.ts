import { type FileIdentityStat } from "./file-identity.js";
export type TempPathIdentityReceipt = FileIdentityStat;
export type TempPathRegistration = (() => void) & {
    setIdentity(identity: FileIdentityStat): void;
};
export declare function registerTempPathForExit(tempPath: string, options?: {
    recursive?: boolean;
    identity?: FileIdentityStat;
}): TempPathRegistration;
export declare function __cleanupRegisteredTempPathsForTest(): void;
export declare function __cleanupRegisteredTempPathForTest(tempPath: string): void;
