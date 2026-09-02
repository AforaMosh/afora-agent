import { type ArchiveExtractLimits } from "./archive-limits.js";
import { type ArchiveEntryFilter, type ArchiveFilteredEntryPolicy } from "./archive-policy.js";
export type TarEntryInfo = {
    path: string;
    type: string;
    size: number;
    mode?: number;
};
export declare function readTarEntryInfo(entry: unknown): TarEntryInfo;
export declare function createTarEntryPreflightChecker(params: {
    rootDir: string;
    stripComponents?: number;
    limits?: ArchiveExtractLimits;
    escapeLabel?: string;
    entryFilter?: ArchiveEntryFilter;
    onFiltered?: ArchiveFilteredEntryPolicy;
}): (entry: TarEntryInfo) => boolean;
