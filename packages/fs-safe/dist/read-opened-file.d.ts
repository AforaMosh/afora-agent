import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { ContainmentGuarantee } from "./containment.js";
export type ReadResult = {
    buffer: Buffer;
    containment: ContainmentGuarantee;
    realPath: string;
    stat: Stats;
};
type OpenedFile = {
    handle: FileHandle;
    containment: ContainmentGuarantee;
    realPath: string;
    stat: Stats;
};
export declare function readOpenedFileSafely(params: {
    opened: OpenedFile;
    maxBytes?: number;
}): Promise<ReadResult>;
export {};
