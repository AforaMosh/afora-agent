import type { DirEntry } from "./types.js";
export type RootWalkSymlinkPolicy = "skip" | "follow-within-root";
export type RootWalkLimitBehavior = "truncate" | "throw";
export type RootWalkDirectoryErrorBehavior = "throw" | "skip-and-report";
export type RootWalkEntryFilterResult = "include" | "skip" | "skip-subtree";
export type RootWalkDataEntryKind = "file" | "directory" | "other";
export type RootWalkEntryKind = RootWalkDataEntryKind | "directory-error" | "truncated";
export type RootWalkDataEntry = {
    relativePath: string;
    kind: RootWalkDataEntryKind;
    size: number;
};
export type RootWalkEntry = RootWalkDataEntry | {
    relativePath: string;
    kind: "truncated";
    size: 0;
} | {
    relativePath: string;
    kind: "directory-error";
    size: 0;
    error: unknown;
};
export type RootWalkEntryFilter = (entry: RootWalkDataEntry) => RootWalkEntryFilterResult;
export type RootWalkOptions = {
    maxDepth?: number;
    maxEntries?: number;
    symlinkPolicy: RootWalkSymlinkPolicy;
    signal?: AbortSignal;
    limitBehavior?: RootWalkLimitBehavior;
    entryFilter?: RootWalkEntryFilter;
    onDirectoryError?: RootWalkDirectoryErrorBehavior;
};
type RootWalkCapability = {
    rootReal: string;
    list(relativePath: string, options: {
        withFileTypes: true;
    }): Promise<DirEntry[]>;
};
export declare function walkRoot(root: RootWalkCapability, relativePath: string, options: RootWalkOptions): AsyncGenerator<RootWalkEntry>;
export {};
