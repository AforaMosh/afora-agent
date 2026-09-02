import type { FileHandle } from "node:fs/promises";
import type { ExtractionDeadline } from "./archive-deadline.js";
import { type ResolvedArchiveExtractLimits } from "./archive-limits.js";
export type StagedArchiveFile = {
    path: string;
    cleanup: () => Promise<void>;
};
export declare function writeFileHandleFully(params: {
    handle: FileHandle;
    buffer: Buffer;
    bytes: number;
    deadline: ExtractionDeadline;
}): Promise<void>;
export declare function stageArchiveFileForExtraction(params: {
    archivePath: string;
    limits: ResolvedArchiveExtractLimits;
    deadline: ExtractionDeadline;
}): Promise<StagedArchiveFile>;
