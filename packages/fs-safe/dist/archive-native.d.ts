import type { ExtractionDeadline } from "./archive-deadline.js";
import type { ArchiveKind } from "./archive-kind.js";
import { type ArchiveExtractLimits } from "./archive-limits.js";
import type { ExtractArchiveOptions } from "./archive-options.js";
import type { NativeBinding } from "./native.js";
export declare function extractNativeArchive(params: {
    binding: NativeBinding;
    archivePath: string;
    destDir: string;
    kind: ArchiveKind;
    stripComponents?: number;
    limits?: ArchiveExtractLimits;
    deadline: ExtractionDeadline;
    entryModes?: ExtractArchiveOptions["entryModes"];
    entryFilter?: ExtractArchiveOptions["entryFilter"];
    onFiltered?: ExtractArchiveOptions["onFiltered"];
}): Promise<void>;
