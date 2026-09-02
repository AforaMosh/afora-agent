import { type Stats } from "node:fs";
import type { ContainmentGuarantee } from "./containment.js";
import { type NativeBinding } from "./native.js";
export type NativeFileHandle = {
    readonly fd: number;
    readonly containment: ContainmentGuarantee;
    close(): Promise<void>;
    stat(): Promise<Stats>;
    writeFile(data: string | Buffer, encoding?: BufferEncoding): Promise<void>;
};
export declare function removeNativeCreatedFileIfStillPinned(params: {
    binding: NativeBinding;
    parentPath: string;
    parentFd: number;
    basename: string;
    created?: Stats;
}): void;
export declare function createNativeExclusiveFile(targetPath: string, mode: number): Promise<NativeFileHandle | undefined>;
export declare function syncNativeFileBestEffort(fd: number): void;
export declare function writeNativeFd(fd: number, data: Buffer): void;
