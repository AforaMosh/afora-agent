export type WindowsAclRunner = (command: string, args: string[], options: {
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
}) => Promise<void>;
export declare function resolveWindowsPowerShellPath(systemRoot: string | null | undefined): string;
export declare function applyOwnerOnlyWindowsAcl(filePath: string, run?: WindowsAclRunner, systemRoot?: string | null | undefined): Promise<void>;
export declare function applyOwnerOnlyWindowsDirectoryAcl(directoryPath: string, run?: WindowsAclRunner, systemRoot?: string | null | undefined): Promise<void>;
export type SecuredPrivateDirectory = {
    assertIdentityAt(directoryPath?: string): Promise<void>;
    directoryPath: string;
};
export declare function captureDirectoryIdentity(directoryPath: string): Promise<SecuredPrivateDirectory>;
export declare function syncParentDirectory(filePath: string, platform?: NodeJS.Platform): Promise<void>;
export declare function removeSecuredPrivateDirectory(secured: SecuredPrivateDirectory, currentPath?: string, quarantineBaseName?: string): Promise<void>;
export declare function securePrivateDirectory(directoryPath: string, options?: {
    currentUserId?: number;
    platform?: NodeJS.Platform;
    secureWindowsDirectory?: (directoryPath: string) => Promise<void>;
    syncParent?: (filePath: string, platform?: NodeJS.Platform) => Promise<void>;
}): Promise<SecuredPrivateDirectory>;
export declare function publishPrivateFileAtomically(filePath: string, contents: string, options?: {
    afterRename?: (filePath: string) => Promise<void>;
    beforeRename?: (temporaryPath: string) => Promise<void>;
    platform?: NodeJS.Platform;
    removeTemporaryFile?: (temporaryPath: string) => Promise<void>;
    secureWindowsFile?: (temporaryPath: string) => Promise<void>;
    syncParent?: (filePath: string, platform?: NodeJS.Platform) => Promise<void>;
}): Promise<void>;
