export type CreatePrivateDirectoryOptions = {
    platform?: NodeJS.Platform;
};
export declare function createPrivateDirectory(targetPath: string, options?: CreatePrivateDirectoryOptions): Promise<void>;
