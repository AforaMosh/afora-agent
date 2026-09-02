import { type ArchiveEntryModePolicy } from "./archive-policy.js";
export type ZipEntry = {
    name: string;
    dir: boolean;
    unixPermissions?: number;
    _data?: {
        crc32?: number;
        uncompressedSize?: number;
    } | PromiseLike<unknown>;
    nodeStream?: () => NodeJS.ReadableStream;
    async: (type: "nodebuffer") => Promise<Buffer>;
};
export declare function zipEntryIntegrityMetadata(entry: ZipEntry): {
    crc32?: number;
    uncompressedSize?: number;
} | undefined;
export declare function hasDeferredEmptyZipData(entry: ZipEntry): boolean;
export declare function isZipSymlinkEntry(entry: ZipEntry): boolean;
export declare function zipEntryMode(entry: ZipEntry, policy: ArchiveEntryModePolicy | undefined): number;
export declare function zipEntryDeclaredSize(entry: ZipEntry): number;
