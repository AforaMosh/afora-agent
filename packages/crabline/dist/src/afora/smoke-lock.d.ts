import { type CrablineServerChannel } from "../servers/index.js";
export type AforaCrablineSmokeRunLock = {
    assertOwned(): Promise<void>;
    commitFileAtomically(params: {
        contents: string;
        destinationPath: string;
        stageDirectory?: string;
        stageFile(filePath: string, contents: string): Promise<void>;
    }): Promise<void>;
    release(): Promise<void>;
};
type HeartbeatController = {
    assertHealthy(): void;
    settle(): Promise<void>;
    stop(): Promise<void>;
};
type RemoveLockDirectory = (lockDirectory: string) => Promise<void>;
type Sleep = (delayMs: number) => Promise<void>;
type IsProcessAlive = (pid: number) => boolean;
type GetProcessIdentity = (pid: number) => string | null;
type StartHeartbeat = (renew: () => Promise<void>, intervalMs: number) => HeartbeatController;
type BeforeRecoveryClaim = () => Promise<void>;
type BeforeRecoveryDeleteClaim = () => Promise<void>;
type BeforeReleaseClaim = () => Promise<void>;
type BeforeCommitClaim = () => Promise<void>;
type BeforeCommitFileRename = () => Promise<void>;
type BeforeCommitRename = () => Promise<void>;
type SecureWindowsDirectory = (directoryPath: string) => Promise<void>;
type AfterLockDirectoryWrite = (directoryPath: string) => Promise<void>;
export declare function processStartedAtMsFromTimeOrigin(timeOrigin: number): number;
export declare const isProcessAlive: IsProcessAlive;
export declare function processIdentityFromLinuxStat(value: string, bootId: string): string | null;
export declare function processIdentityFromDarwin(processStartedAt: string, bootTime: string): string | null;
export declare function darwinProcessIdentityEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function acquireAforaCrablineSmokeRunLock(params: {
    channel: CrablineServerChannel;
    outputDir: string;
}, dependencies?: {
    afterLockCandidateInstall?: AfterLockDirectoryWrite;
    afterLockOwnerWrite?: AfterLockDirectoryWrite;
    getProcessIdentity?: GetProcessIdentity;
    isProcessAlive?: IsProcessAlive;
    leaseMs?: number;
    now?: () => number;
    pid?: number;
    processIdentity?: string | null;
    processStartedAtMs?: number;
    platform?: NodeJS.Platform;
    secureWindowsDirectory?: SecureWindowsDirectory;
    beforeCommitClaim?: BeforeCommitClaim;
    beforeCommitFileRename?: BeforeCommitFileRename;
    beforeCommitRename?: BeforeCommitRename;
    beforeRecoveryDeleteClaim?: BeforeRecoveryDeleteClaim;
    beforeRecoveryClaim?: BeforeRecoveryClaim;
    beforeReleaseClaim?: BeforeReleaseClaim;
    removeDirectory?: RemoveLockDirectory;
    sleep?: Sleep;
    startHeartbeat?: StartHeartbeat;
}): Promise<AforaCrablineSmokeRunLock>;
export declare function releaseAforaCrablineSmokeRunLock(lock: Pick<AforaCrablineSmokeRunLock, "release">, dependencies?: {
    sleep?: Sleep;
}): Promise<void>;
export {};
