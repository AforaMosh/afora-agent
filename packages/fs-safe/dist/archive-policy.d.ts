export type ArchiveEntryKind = "file" | "directory" | "symlink" | "other";
export type ArchiveEntryModePolicy = "clamp" | "preserve";
export type ArchiveFilteredEntryPolicy = "reject-archive" | "skip-entry";
export type ArchiveEntryFilter = (entry: {
    path: string;
    kind: ArchiveEntryKind;
    size: number;
}) => "extract" | "skip";
export declare function archiveEntryKindFromTarType(type: string): ArchiveEntryKind;
export declare function resolveArchiveEntryMode(params: {
    kind: "file" | "directory";
    archivedMode?: number;
    policy?: ArchiveEntryModePolicy;
}): number;
export declare function shouldExtractArchiveEntry(params: {
    filter?: ArchiveEntryFilter;
    onFiltered?: ArchiveFilteredEntryPolicy;
    entry: Parameters<ArchiveEntryFilter>[0];
}): boolean;
