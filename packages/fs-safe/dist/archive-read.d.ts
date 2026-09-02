import { type ArchiveKind } from "./archive-kind.js";
export declare function readArchiveEntry(archivePath: string, entryPath: string, options: {
    maxBytes: number;
    kind?: ArchiveKind;
}): Promise<Buffer>;
