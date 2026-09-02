export { resolvePathViaExistingAncestorSync } from "./root-path-existing.js";
type RootPathIntent = "read" | "write" | "create" | "delete" | "stat";
export type RootPathAliasPolicy = {
    allowFinalSymlinkForUnlink?: boolean;
    allowFinalHardlinkForUnlink?: boolean;
};
export declare const ROOT_PATH_ALIAS_POLICIES: {
    readonly strict: Readonly<{
        allowFinalSymlinkForUnlink: false;
        allowFinalHardlinkForUnlink: false;
    }>;
    readonly unlinkTarget: Readonly<{
        allowFinalSymlinkForUnlink: true;
        allowFinalHardlinkForUnlink: true;
    }>;
};
type ResolveRootPathParams = {
    absolutePath: string;
    rootPath: string;
    boundaryLabel: string;
    intent?: RootPathIntent;
    policy?: RootPathAliasPolicy;
    rejectSymlinks?: boolean;
    skipLexicalRootCheck?: boolean;
    rootCanonicalPath?: string;
};
type ResolvedRootPathKind = "missing" | "file" | "directory" | "symlink" | "other";
export type ResolvedRootPath = {
    absolutePath: string;
    canonicalPath: string;
    rootPath: string;
    rootCanonicalPath: string;
    relativePath: string;
    exists: boolean;
    kind: ResolvedRootPathKind;
};
export declare function resolveRootPath(params: ResolveRootPathParams): Promise<ResolvedRootPath>;
export declare function resolveRootPathSync(params: ResolveRootPathParams): ResolvedRootPath;
