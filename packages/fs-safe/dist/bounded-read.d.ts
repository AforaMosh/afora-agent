import type { FileHandle } from "node:fs/promises";
type ReadableFileHandle = Pick<FileHandle, "read">;
/**
 * Reads from the handle's current offset without closing it. A bounded read
 * consumes at most maxBytes + 1 bytes so growth after an earlier stat cannot
 * force an unbounded allocation.
 */
export declare function readFileHandleBounded(handle: ReadableFileHandle, maxBytes: number): Promise<Buffer>;
/** Async bounded read from a numeric descriptor. The caller owns the descriptor. */
export declare function readFileDescriptorBounded(fd: number, maxBytes: number): Promise<Buffer>;
/** Sync bounded read from a numeric descriptor. The caller owns the descriptor. */
export declare function readFileDescriptorBoundedSync(fd: number, maxBytes: number): Buffer;
export {};
