export type RootContext = {
    rootDir: string;
    rootIdentity: {
        dev: number;
        ino: number;
    };
    rootReal: string;
    rootWithSep: string;
};
export declare const ensureTrailingSep: (value: string) => string;
export declare function assertValidRootRelativePath(relativePath: string): void;
export declare function assertValidRootDestinationPath(relativePath: string): void;
export declare function expandRelativePathWithHome(relativePath: string): Promise<string>;
export declare function resolveRootContext(rootDir: string): Promise<RootContext>;
export declare function assertRootIdentityCurrent(root: RootContext): Promise<void>;
export declare function resolvePathInRoot(root: RootContext, relativePath: string, options?: {
    aliasErrorCode?: "outside-workspace" | "path-alias";
    allowFinalSymlink?: boolean;
    rejectUnsafeDeviceReads?: boolean;
    rejectSymlinks?: boolean;
}): Promise<{
    rootReal: string;
    rootWithSep: string;
    resolved: string;
}>;
export declare function resolvePathWithinRoot(params: {
    rootDir: string;
    relativePath: string;
}): Promise<{
    rootReal: string;
    rootWithSep: string;
    resolved: string;
}>;
