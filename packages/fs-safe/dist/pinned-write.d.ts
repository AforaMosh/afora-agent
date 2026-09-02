import type { Readable } from "node:stream";
import type { FileIdentityStat } from "./file-identity.js";
export type PinnedWriteInput = {
    kind: "buffer";
    data: string | Buffer;
    encoding?: BufferEncoding;
} | {
    kind: "stream";
    stream: Readable;
};
export type RenameIdentityMismatchPolicy = "throw" | "verify-content";
export type RenameIdentityPolicy = "strict" | "verify-content-with-lock";
export type PinnedWriteParams = {
    rootPath: string;
    relativeParentPath: string;
    basename: string;
    mkdir: boolean;
    mode: number;
    overwrite?: boolean;
    maxBytes?: number;
    input: PinnedWriteInput;
    rootIdentity?: FileIdentityStat;
    onRenameIdentityMismatch?: RenameIdentityMismatchPolicy;
};
export declare function runPinnedWriteHelper(params: PinnedWriteParams): Promise<FileIdentityStat>;
export declare function runPinnedWriteWithRenamePolicy(params: PinnedWriteParams & {
    targetPath: string;
    renameIdentity?: RenameIdentityPolicy;
}): Promise<FileIdentityStat>;
