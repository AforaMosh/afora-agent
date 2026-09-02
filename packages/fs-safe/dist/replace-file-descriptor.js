import syncFs, {} from "node:fs";
import fs, {} from "node:fs/promises";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
function directoryOpenFlags() {
    return (syncFs.constants.O_RDONLY |
        syncFs.constants.O_DIRECTORY |
        syncFs.constants.O_NOFOLLOW |
        syncFs.constants.O_NONBLOCK);
}
function assertDirectory(identity, dirPath) {
    if (identity.isSymbolicLink() || !identity.isDirectory()) {
        throw new FsSafeError("not-file", `Atomic replace parent must be a real directory: ${dirPath}`);
    }
}
function assertSameDirectory(expected, opened, dirPath) {
    assertDirectory(opened, dirPath);
    if (!sameFileIdentity(expected, opened)) {
        throw new FsSafeError("path-mismatch", `Atomic replace parent changed before its mode could be applied: ${dirPath}`);
    }
}
export async function applyDirectoryMode(params) {
    // Node does not enforce POSIX directory modes on Windows, and its directory
    // descriptors are not consistently openable. mkdir(mode) remains the only
    // bounded behavior there; never fall back to a pathname chmod.
    if (process.platform === "win32") {
        return;
    }
    const expected = await params.fsModule.lstat(params.dirPath);
    assertDirectory(expected, params.dirPath);
    const handle = await params.fsModule.open(params.dirPath, directoryOpenFlags());
    try {
        assertSameDirectory(expected, await handle.stat(), params.dirPath);
        await handle.chmod(params.mode);
    }
    finally {
        await handle.close();
    }
}
export function applyDirectoryModeSync(params) {
    if (process.platform === "win32") {
        return;
    }
    const expected = params.fsModule.lstatSync(params.dirPath);
    assertDirectory(expected, params.dirPath);
    const fd = params.fsModule.openSync(params.dirPath, directoryOpenFlags());
    try {
        assertSameDirectory(expected, params.fsModule.fstatSync(fd), params.dirPath);
        params.fchmodSync?.(fd, params.mode);
    }
    finally {
        params.fsModule.closeSync(fd);
    }
}
export async function writeTempFile(params) {
    const handle = await params.fsModule.open(params.tempPath, "wx", params.mode);
    try {
        await params.fsModule.writeFile(handle, params.content);
        await handle.chmod(params.mode);
        if (params.sync) {
            try {
                await handle.sync();
            }
            catch (error) {
                if (error.code !== "EPERM") {
                    throw error;
                }
            }
        }
        return await handle.stat();
    }
    finally {
        await handle.close();
    }
}
export function writeTempFileSync(params) {
    const fd = params.fsModule.openSync(params.tempPath, "wx", params.mode);
    try {
        params.fsModule.writeFileSync(fd, params.content);
        params.fchmodSync?.(fd, params.mode);
        if (params.sync) {
            try {
                params.fsModule.fsyncSync(fd);
            }
            catch (error) {
                if (error.code !== "EPERM") {
                    throw error;
                }
            }
        }
        return params.fsModule.fstatSync(fd);
    }
    finally {
        params.fsModule.closeSync(fd);
    }
}
