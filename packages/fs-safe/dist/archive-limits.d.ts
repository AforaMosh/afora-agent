import { Transform } from "node:stream";
export type ArchiveExtractLimits = {
    /**
     * Max archive file bytes (compressed).
     */
    maxArchiveBytes?: number;
    /** Max number of extracted entries (files + dirs). */
    maxEntries?: number;
    /** Max extracted bytes (sum of all files). */
    maxExtractedBytes?: number;
    /** Max extracted bytes for a single file entry. */
    maxEntryBytes?: number;
    /** Max bytes in one PAX, GNU long-name, or related TAR metadata entry. */
    maxMetaEntryBytes?: number;
    /** Max path components in one extracted entry after stripComponents. */
    maxEntryPathComponents?: number;
};
export declare const DEFAULT_MAX_ARCHIVE_BYTES_ZIP: number;
export declare const DEFAULT_MAX_ENTRIES = 50000;
export declare const DEFAULT_MAX_EXTRACTED_BYTES: number;
export declare const DEFAULT_MAX_ENTRY_BYTES: number;
export declare const DEFAULT_MAX_META_ENTRY_BYTES: number;
export declare const DEFAULT_MAX_ENTRY_PATH_COMPONENTS = 256;
export declare const ARCHIVE_LIMIT_ERROR_CODE: {
    readonly ARCHIVE_SIZE_EXCEEDS_LIMIT: "archive-size-exceeds-limit";
    readonly ENTRY_COUNT_EXCEEDS_LIMIT: "archive-entry-count-exceeds-limit";
    readonly ENTRY_EXTRACTED_SIZE_EXCEEDS_LIMIT: "archive-entry-extracted-size-exceeds-limit";
    readonly EXTRACTED_SIZE_EXCEEDS_LIMIT: "archive-extracted-size-exceeds-limit";
    readonly META_ENTRY_SIZE_EXCEEDS_LIMIT: "archive-meta-entry-size-exceeds-limit";
    readonly MANIFEST_SIZE_EXCEEDS_LIMIT: "archive-manifest-size-exceeds-limit";
    readonly ENTRY_PATH_COMPONENTS_EXCEEDS_LIMIT: "archive-entry-path-components-exceeds-limit";
};
export type ArchiveLimitErrorCode = (typeof ARCHIVE_LIMIT_ERROR_CODE)[keyof typeof ARCHIVE_LIMIT_ERROR_CODE];
export declare class ArchiveLimitError extends Error {
    readonly code: ArchiveLimitErrorCode;
    constructor(code: ArchiveLimitErrorCode);
}
export type ResolvedArchiveExtractLimits = Required<ArchiveExtractLimits>;
export declare function resolveExtractLimits(limits?: ArchiveExtractLimits): ResolvedArchiveExtractLimits;
export declare function assertArchiveEntryPathComponentsWithinLimit(entryPath: string, limits: ResolvedArchiveExtractLimits): void;
export declare function assertArchiveEntryCountWithinLimit(entryCount: number, limits: ResolvedArchiveExtractLimits): void;
export declare function createByteBudgetTracker(limits: ResolvedArchiveExtractLimits): {
    startEntry: () => void;
    addBytes: (bytes: number) => void;
    addEntrySize: (size: number) => void;
};
export declare function createExtractBudgetTransform(params: {
    onChunkBytes: (bytes: number) => void;
}): Transform;
