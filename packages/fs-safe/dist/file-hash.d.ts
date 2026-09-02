import type { FileHandle } from "node:fs/promises";
import { type NativeBinding } from "./native.js";
export type Sha256FileInput = string | FileHandle;
export type Sha256FileResult = {
    bytes: number;
    digest: string;
};
export declare function hashFileHandle(handle: FileHandle, native?: NativeBinding | undefined): Promise<Sha256FileResult>;
export declare function sha256File(input: Sha256FileInput): Promise<Sha256FileResult>;
