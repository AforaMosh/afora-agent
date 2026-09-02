import { ArchiveSecurityError } from "./archive-errors.js";
export { ArchiveSecurityError, type ArchiveSecurityErrorCode } from "./archive-errors.js";
export declare function prepareArchiveDestinationDir(destDir: string): Promise<string>;
export declare function prepareArchiveOutputPath(params: {
    destinationDir: string;
    destinationRealDir: string;
    relPath: string;
    outPath: string;
    originalPath: string;
    isDirectory: boolean;
}): Promise<void>;
export declare function withStagedArchiveDestination<T>(params: {
    destinationRealDir: string;
    stagingDirPrefix?: string;
    run: (stagingDir: string) => Promise<T>;
}): Promise<T>;
export declare function mergeExtractedTreeIntoDestination(params: {
    sourceDir: string;
    destinationDir: string;
    destinationRealDir: string;
}): Promise<void>;
export declare function createArchiveSymlinkTraversalError(originalPath: string): ArchiveSecurityError;
