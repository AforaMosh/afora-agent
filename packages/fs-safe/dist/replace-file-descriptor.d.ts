import syncFs, { type Stats } from "node:fs";
import fs from "node:fs/promises";
type AsyncTempFileSystem = Pick<typeof fs, "lstat" | "open" | "writeFile">;
type SyncTempFileSystem = Pick<typeof syncFs, "closeSync" | "fstatSync" | "fsyncSync" | "lstatSync" | "openSync" | "writeFileSync">;
export type SyncFchmod = (fd: number, mode: number) => void;
export declare function applyDirectoryMode(params: {
    fsModule: AsyncTempFileSystem;
    dirPath: string;
    mode: number;
}): Promise<void>;
export declare function applyDirectoryModeSync(params: {
    fsModule: SyncTempFileSystem;
    dirPath: string;
    mode: number;
    fchmodSync?: SyncFchmod;
}): void;
export declare function writeTempFile(params: {
    fsModule: AsyncTempFileSystem;
    tempPath: string;
    content: string | Uint8Array;
    mode: number;
    sync: boolean;
}): Promise<Stats>;
export declare function writeTempFileSync(params: {
    fsModule: SyncTempFileSystem;
    tempPath: string;
    content: string | Uint8Array;
    mode: number;
    fchmodSync?: SyncFchmod;
    sync: boolean;
}): Stats;
export {};
