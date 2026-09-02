import { readFileHandleBounded } from "./bounded-read.js";
import { FsSafeError } from "./errors.js";
export async function readOpenedFileSafely(params) {
    if (params.maxBytes !== undefined && params.opened.stat.size > params.maxBytes) {
        throw new FsSafeError("too-large", `file exceeds limit of ${params.maxBytes} bytes (got ${params.opened.stat.size})`);
    }
    const buffer = params.maxBytes === undefined
        ? await params.opened.handle.readFile()
        : await readFileHandleBounded(params.opened.handle, params.maxBytes);
    return {
        buffer,
        containment: params.opened.containment,
        realPath: params.opened.realPath,
        stat: params.opened.stat,
    };
}
