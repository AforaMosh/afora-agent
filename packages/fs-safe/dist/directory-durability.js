import fsSync, {} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureAbsoluteDirectory } from "./absolute-path.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
function directoryOpenFlags() {
    if (process.platform === "win32") {
        return "r";
    }
    return (fsSync.constants.O_RDONLY |
        fsSync.constants.O_DIRECTORY |
        fsSync.constants.O_NOFOLLOW |
        fsSync.constants.O_NONBLOCK);
}
function isWindowsDirectorySyncUnsupported(error) {
    if (process.platform !== "win32") {
        return false;
    }
    const code = error.code;
    return (code === "EACCES" ||
        code === "EINVAL" ||
        code === "EISDIR" ||
        code === "ENOSYS" ||
        code === "ENOTSUP" ||
        code === "EPERM");
}
function isWindowsDirectoryOpenUnsupported(error) {
    if (process.platform !== "win32") {
        return false;
    }
    const code = error.code;
    return code === "EINVAL" || code === "EISDIR" || code === "ENOSYS" || code === "ENOTSUP";
}
function unsupportedOutcome(error) {
    const code = error.code;
    return code ? { status: "unsupported", code } : { status: "unsupported" };
}
function assertDirectory(identity, pathname, label) {
    if (identity.isSymbolicLink() || !identity.isDirectory()) {
        throw new FsSafeError("not-file", `${label} must be a real directory: ${pathname}`);
    }
}
async function createDirectoryReceipt(directoryPath, label) {
    const resolvedPath = path.resolve(directoryPath);
    const identity = await fs.lstat(resolvedPath);
    assertDirectory(identity, resolvedPath, label);
    return {
        path: resolvedPath,
        realPath: await fs.realpath(resolvedPath),
        identity,
    };
}
function createDirectoryReceiptSync(directoryPath, label) {
    const resolvedPath = path.resolve(directoryPath);
    const identity = fsSync.lstatSync(resolvedPath);
    assertDirectory(identity, resolvedPath, label);
    return {
        path: resolvedPath,
        realPath: fsSync.realpathSync(resolvedPath),
        identity,
    };
}
async function assertDirectoryReceiptCurrent(receipt, label) {
    const currentIdentity = await fs.lstat(receipt.path);
    assertDirectory(currentIdentity, receipt.path, label);
    if (!sameFileIdentity(receipt.identity, currentIdentity) ||
        (await fs.realpath(receipt.path)) !== receipt.realPath) {
        throw new FsSafeError("path-mismatch", `${label} changed during durable directory operation: ${receipt.path}`);
    }
}
function assertDirectoryReceiptCurrentSync(receipt, label) {
    const currentIdentity = fsSync.lstatSync(receipt.path);
    assertDirectory(currentIdentity, receipt.path, label);
    if (!sameFileIdentity(receipt.identity, currentIdentity) ||
        fsSync.realpathSync(receipt.path) !== receipt.realPath) {
        throw new FsSafeError("path-mismatch", `${label} changed during durable directory operation: ${receipt.path}`);
    }
}
async function assertOpenDirectoryCurrent(handle, receipt, label) {
    const openedIdentity = await handle.stat();
    assertDirectory(openedIdentity, receipt.path, label);
    if (!sameFileIdentity(receipt.identity, openedIdentity)) {
        throw new FsSafeError("path-mismatch", `${label} handle changed during directory sync: ${receipt.path}`);
    }
    await assertDirectoryReceiptCurrent(receipt, label);
}
class PinnedDirectoryImpl {
    receipt;
    #handle;
    #label;
    #closed = false;
    constructor(handle, receipt, label) {
        this.#handle = handle;
        this.receipt = receipt;
        this.#label = label;
    }
    async assertCurrent() {
        if (this.#closed) {
            throw new FsSafeError("helper-failed", `${this.#label} pin is already closed`);
        }
        await assertOpenDirectoryCurrent(this.#handle, this.receipt, this.#label);
    }
    async sync() {
        await this.assertCurrent();
        try {
            await this.#handle.sync();
        }
        catch (error) {
            if (!isWindowsDirectorySyncUnsupported(error)) {
                throw error;
            }
            await this.assertCurrent();
            return unsupportedOutcome(error);
        }
        await this.assertCurrent();
        return { status: "synced" };
    }
    async close() {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        await this.#handle.close();
    }
}
export async function pinDirectory(directory, options = {}) {
    const label = options.label ?? "directory";
    const receipt = typeof directory === "string" ? await createDirectoryReceipt(directory, label) : directory;
    await assertDirectoryReceiptCurrent(receipt, label);
    const handle = await fs.open(receipt.path, directoryOpenFlags());
    try {
        await assertOpenDirectoryCurrent(handle, receipt, label);
        return new PinnedDirectoryImpl(handle, receipt, label);
    }
    catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
    }
}
export async function syncDirectory(directory, options = {}) {
    const label = options.label ?? "directory";
    const receipt = typeof directory === "string" ? await createDirectoryReceipt(directory, label) : directory;
    let pinned;
    try {
        pinned = await pinDirectory(receipt, { label });
    }
    catch (error) {
        if (!isWindowsDirectoryOpenUnsupported(error)) {
            throw error;
        }
        await assertDirectoryReceiptCurrent(receipt, label);
        return unsupportedOutcome(error);
    }
    try {
        return await pinned.sync();
    }
    finally {
        await pinned.close();
    }
}
export function syncDirectorySync(directory, options = {}) {
    const label = options.label ?? "directory";
    const receipt = typeof directory === "string" ? createDirectoryReceiptSync(directory, label) : directory;
    assertDirectoryReceiptCurrentSync(receipt, label);
    let descriptor;
    try {
        descriptor = fsSync.openSync(receipt.path, directoryOpenFlags());
    }
    catch (error) {
        if (!isWindowsDirectoryOpenUnsupported(error)) {
            throw error;
        }
        assertDirectoryReceiptCurrentSync(receipt, label);
        return unsupportedOutcome(error);
    }
    try {
        const openedIdentity = fsSync.fstatSync(descriptor);
        assertDirectory(openedIdentity, receipt.path, label);
        if (!sameFileIdentity(receipt.identity, openedIdentity)) {
            throw new FsSafeError("path-mismatch", `${label} handle changed during directory sync: ${receipt.path}`);
        }
        assertDirectoryReceiptCurrentSync(receipt, label);
        try {
            fsSync.fsyncSync(descriptor);
        }
        catch (error) {
            if (!isWindowsDirectorySyncUnsupported(error)) {
                throw error;
            }
            assertDirectoryReceiptCurrentSync(receipt, label);
            return unsupportedOutcome(error);
        }
        assertDirectoryReceiptCurrentSync(receipt, label);
        return { status: "synced" };
    }
    finally {
        fsSync.closeSync(descriptor);
    }
}
export async function syncDirectoryBestEffort(directoryPath) {
    await syncDirectory(directoryPath).catch(() => undefined);
}
export function syncDirectoryBestEffortSync(directoryPath) {
    try {
        syncDirectorySync(directoryPath);
    }
    catch {
        // Compatibility helper for operations whose primary write may remain usable.
    }
}
async function findExistingAncestorReceipt(targetPath, label) {
    let currentPath = path.resolve(targetPath);
    while (true) {
        try {
            return await createDirectoryReceipt(currentPath, label);
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }
        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) {
            throw new FsSafeError("not-found", `${label} has no existing directory ancestor`);
        }
        currentPath = parentPath;
    }
}
export async function ensureDurableDirectory(options) {
    const directoryPath = path.resolve(options.directoryPath);
    const label = options.label ?? "directory";
    const ancestorReceipt = await findExistingAncestorReceipt(directoryPath, label);
    const targetExists = ancestorReceipt.path === directoryPath;
    if (options.expectedExistingIdentity &&
        (!targetExists || !sameFileIdentity(options.expectedExistingIdentity, ancestorReceipt.identity))) {
        throw new FsSafeError("path-mismatch", `${label} changed before durable directory pinning: ${directoryPath}`);
    }
    const ancestor = await pinDirectory(ancestorReceipt, { label });
    const pinnedDirectories = [ancestor];
    try {
        await ancestor.assertCurrent();
        if (!targetExists) {
            if (options.create) {
                await options.create(directoryPath);
            }
            else {
                const created = await ensureAbsoluteDirectory(directoryPath, {
                    mode: options.mode,
                    scopeLabel: label,
                });
                if (!created.ok) {
                    throw created.error;
                }
            }
        }
        await ancestor.assertCurrent();
        let currentPath = ancestor.receipt.path;
        for (const segment of path
            .relative(ancestor.receipt.path, directoryPath)
            .split(path.sep)
            .filter(Boolean)) {
            currentPath = path.join(currentPath, segment);
            pinnedDirectories.push(await pinDirectory(currentPath, { label }));
        }
        let parentSync = { status: "not-needed" };
        for (let index = pinnedDirectories.length - 1; index > 0; index -= 1) {
            const parent = pinnedDirectories[index - 1];
            const child = pinnedDirectories[index];
            if (!parent || !child) {
                throw new FsSafeError("helper-failed", `${label} directory pin chain is incomplete`);
            }
            await child.assertCurrent();
            try {
                const outcome = await parent.sync();
                if (outcome.status === "unsupported") {
                    parentSync = outcome;
                }
                else if (parentSync.status === "not-needed") {
                    parentSync = outcome;
                }
            }
            catch (error) {
                throw new FsSafeError("helper-failed", `${label} could not sync created directory edge ${child.receipt.path} through ${parent.receipt.path}`, { cause: error });
            }
            await child.assertCurrent();
        }
        const finalReceipt = pinnedDirectories.at(-1)?.receipt;
        if (!finalReceipt) {
            throw new FsSafeError("helper-failed", `${label} directory receipt is missing`);
        }
        await ancestor.assertCurrent();
        await assertDirectoryReceiptCurrent(finalReceipt, label);
        return { ...finalReceipt, parentSync };
    }
    finally {
        await Promise.all(pinnedDirectories.toReversed().map(async (directory) => directory.close()));
    }
}
