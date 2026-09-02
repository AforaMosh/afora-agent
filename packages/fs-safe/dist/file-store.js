import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readFileDescriptorBoundedSync } from "./bounded-read.js";
import { FsSafeError } from "./errors.js";
import { pruneExpiredStoreEntries } from "./file-store-prune.js";
import { ensureParentInRoot, openWritableStoreRoot, writeStreamToTempSource, } from "./file-store-boundary.js";
import { writeFileSyncAtomic } from "./file-store-sync-write.js";
import { createJsonStore } from "./json-document-store.js";
import { stringifyJsonDocument } from "./json-stringify.js";
import { isNotFoundPathError, resolveSafeRelativePath } from "./path.js";
import { throwFsSafeReadError } from "./read-error.js";
import { root } from "./root.js";
import { DEFAULT_ROOT_MAX_BYTES } from "./root-impl.js";
import { readRegularFile } from "./regular-file.js";
import { matchRootFileOpenFailure, openRootFileSync } from "./root-file.js";
import { assertNoDriveRelativePathSegments } from "./safe-path-segment.js";
import { writeSecretFileAtomic } from "./secret-file.js";
function assertRelativePath(relativePath) {
    const raw = relativePath.trim();
    if (!raw || raw !== relativePath) {
        throw new FsSafeError("invalid-path", "store key must be non-empty and unpadded");
    }
    assertNoDriveRelativePathSegments(raw.replaceAll("\\", "/"), "store key");
    const segments = raw.split("/");
    const delegated = segments.includes("..") || raw.includes("\\") ||
        path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw) || raw.startsWith("//");
    if (delegated)
        return raw;
    if (segments.every((segment) => segment.length === 0 || segment === ".") ||
        segments.some((segment) => segment.length === 0 || segment === ".") ||
        raw.normalize("NFC") !== raw ||
        segments.some((segment) => /[ .]$/u.test(segment))) {
        throw new FsSafeError("invalid-path", "store key must use one canonical relative spelling");
    }
    return raw;
}
function resolveStorePath(rootDir, relativePath) {
    return resolveSafeRelativePath(rootDir, assertRelativePath(relativePath));
}
function assertMaxBytes(size, maxBytes) {
    if (maxBytes !== undefined && size > maxBytes) {
        throw new FsSafeError("too-large", `file exceeds maximum size of ${maxBytes} bytes`);
    }
}
function isNotFound(error) {
    return error instanceof FsSafeError
        ? error.code === "not-found"
        : isNotFoundPathError(error);
}
function handleSyncStoreReadOpenFailure(opened) {
    return matchRootFileOpenFailure(opened, {
        path: (failure) => {
            if (isNotFound(failure.error)) {
                return null;
            }
            throw new FsSafeError("path-mismatch", "store target changed during read", {
                cause: failure.error instanceof Error ? failure.error : undefined,
            });
        },
        validation: (failure) => {
            if (failure.error instanceof FsSafeError) {
                throw failure.error;
            }
            // Validation failures mean the path existed but violated store policy
            // (directory, hardlink, symlink race). Do not report them as missing.
            throw new FsSafeError("path-mismatch", "store target failed read validation", {
                cause: failure.error instanceof Error ? failure.error : undefined,
            });
        },
        io: (failure) => throwFsSafeReadError(failure.error, "store"),
        fallback: (failure) => {
            throw new FsSafeError("path-mismatch", "store target changed during read", {
                cause: failure.error instanceof Error ? failure.error : undefined,
            });
        },
    });
}
async function readFileStoreCopySource(params) {
    const sourceStat = await fs.lstat(params.sourcePath);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
        throw new FsSafeError("not-file", "source path is not a file");
    }
    assertMaxBytes(sourceStat.size, params.maxBytes);
    try {
        return (await readRegularFile({ filePath: params.sourcePath, maxBytes: params.maxBytes }))
            .buffer;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("regular file") || message.includes("not a regular file")) {
            throw new FsSafeError("not-file", "source path is not a file", {
                cause: error instanceof Error ? error : undefined,
            });
        }
        if (params.maxBytes !== undefined && message.includes(`exceeds ${params.maxBytes} bytes`)) {
            throw new FsSafeError("too-large", `file exceeds maximum size of ${params.maxBytes} bytes`, {
                cause: error instanceof Error ? error : undefined,
            });
        }
        throw error;
    }
}
async function copyIntoRoot(params) {
    const relativePath = assertRelativePath(params.relativePath);
    const destination = resolveStorePath(params.rootDir, relativePath);
    const sourceStat = await fs.lstat(params.sourcePath);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
        throw new FsSafeError("not-file", "source path is not a file");
    }
    assertMaxBytes(sourceStat.size, params.maxBytes);
    const dirMode = params.dirMode ?? 0o700;
    const scopedRoot = await openWritableStoreRoot({
        rootDir: params.rootDir,
        dirMode,
        maxBytes: params.maxBytes,
    });
    await ensureParentInRoot(scopedRoot, relativePath, dirMode);
    await scopedRoot.copyIn(relativePath, params.sourcePath, {
        maxBytes: params.maxBytes,
        mkdir: false,
        mode: params.mode ?? 0o600,
    });
    return destination;
}
export function fileStore(options) {
    const rootDir = path.resolve(options.rootDir);
    const privateMode = options.private ?? false;
    const dirMode = options.dirMode ?? 0o700;
    const mode = options.mode ?? 0o600;
    const maxBytes = options.maxBytes;
    async function openRoot() {
        return await root(rootDir, { hardlinks: "reject", maxBytes });
    }
    async function write(relativePath, data, writeOptions) {
        const safeRelativePath = assertRelativePath(relativePath);
        const destination = resolveStorePath(rootDir, safeRelativePath);
        const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
        assertMaxBytes(content.byteLength, writeOptions?.maxBytes ?? maxBytes);
        if (privateMode) {
            await writeSecretFileAtomic({
                rootDir,
                filePath: destination,
                content,
                dirMode: writeOptions?.dirMode ?? dirMode,
                mode: writeOptions?.mode ?? mode,
            });
            return destination;
        }
        const writeDirMode = writeOptions?.dirMode ?? dirMode;
        const scopedRoot = await openWritableStoreRoot({
            rootDir,
            dirMode: writeDirMode,
            maxBytes: writeOptions?.maxBytes ?? maxBytes,
        });
        await ensureParentInRoot(scopedRoot, safeRelativePath, writeDirMode);
        await scopedRoot.write(safeRelativePath, content, {
            mkdir: false,
            mode: writeOptions?.mode ?? mode,
        });
        return destination;
    }
    return {
        rootDir,
        path: (relativePath) => resolveStorePath(rootDir, relativePath),
        root: openRoot,
        write,
        writeStream: async (relativePath, stream, writeOptions) => {
            const safeRelativePath = assertRelativePath(relativePath);
            const destination = resolveStorePath(rootDir, safeRelativePath);
            const limit = writeOptions?.maxBytes ?? maxBytes ?? (privateMode ? DEFAULT_ROOT_MAX_BYTES : undefined);
            if (privateMode) {
                const chunks = [];
                let total = 0;
                for await (const chunk of stream) {
                    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
                    total += buffer.byteLength;
                    assertMaxBytes(total, limit);
                    chunks.push(buffer);
                }
                await writeSecretFileAtomic({
                    rootDir,
                    filePath: destination,
                    content: Buffer.concat(chunks),
                    dirMode: writeOptions?.dirMode ?? dirMode,
                    mode: writeOptions?.mode ?? mode,
                });
                return destination;
            }
            const staged = await writeStreamToTempSource({
                stream,
                maxBytes: limit,
                mode: writeOptions?.mode ?? mode,
            });
            try {
                await copyIntoRoot({
                    rootDir,
                    relativePath: safeRelativePath,
                    sourcePath: staged.path,
                    maxBytes: limit,
                    mode: writeOptions?.mode ?? mode,
                    tempPrefix: writeOptions?.tempPrefix,
                    dirMode: writeOptions?.dirMode ?? dirMode,
                });
            }
            finally {
                await staged.cleanup();
            }
            return destination;
        },
        copyIn: async (relativePath, sourcePath, writeOptions) => privateMode
            ? await (async () => {
                const buffer = await readFileStoreCopySource({
                    sourcePath,
                    maxBytes: writeOptions?.maxBytes ?? maxBytes ?? DEFAULT_ROOT_MAX_BYTES,
                });
                return await write(relativePath, buffer, writeOptions);
            })()
            : await copyIntoRoot({
                rootDir,
                relativePath,
                sourcePath,
                dirMode: writeOptions?.dirMode ?? dirMode,
                maxBytes: writeOptions?.maxBytes ?? maxBytes,
                mode: writeOptions?.mode ?? mode,
                tempPrefix: writeOptions?.tempPrefix,
            }),
        open: async (relativePath, readOptions) => await (await openRoot()).open(assertRelativePath(relativePath), readOptions),
        read: async (relativePath, readOptions) => await (await openRoot()).read(assertRelativePath(relativePath), readOptions),
        readBytes: async (relativePath, readOptions) => await (await openRoot()).readBytes(assertRelativePath(relativePath), readOptions),
        readText: async (relativePath, readOptions) => {
            const { encoding = "utf8", ...options } = readOptions ?? {};
            return (await (await openRoot()).read(assertRelativePath(relativePath), options)).buffer
                .toString(encoding);
        },
        readTextIfExists: async (relativePath, readOptions) => {
            try {
                return await (await openRoot()).readText(assertRelativePath(relativePath), readOptions);
            }
            catch (error) {
                if (isNotFound(error)) {
                    return null;
                }
                throwFsSafeReadError(error, "store");
            }
        },
        readJson: async (relativePath, readOptions) => {
            const { encoding = "utf8", ...options } = readOptions ?? {};
            return JSON.parse((await (await openRoot()).read(assertRelativePath(relativePath), options)).buffer
                .toString(encoding));
        },
        readJsonIfExists: async (relativePath, readOptions) => {
            try {
                return await (await openRoot()).readJson(assertRelativePath(relativePath), readOptions);
            }
            catch (error) {
                if (isNotFound(error)) {
                    return null;
                }
                throwFsSafeReadError(error, "store");
            }
        },
        remove: async (relativePath) => {
            await (await openRoot()).remove(assertRelativePath(relativePath));
        },
        exists: async (relativePath) => await (await openRoot()).exists(assertRelativePath(relativePath)),
        writeText: async (relativePath, data, writeOptions) => await write(relativePath, data, writeOptions),
        writeJson: async (relativePath, data, writeOptions) => {
            const json = stringifyJsonDocument(data, null, 2);
            return await write(relativePath, writeOptions?.trailingNewline === false ? json : `${json}\n`, writeOptions);
        },
        json: (relativePath, jsonOptions) => {
            const filePath = resolveStorePath(rootDir, relativePath);
            return createJsonStore({
                filePath,
                readIfExists: async () => {
                    try {
                        return await (await openRoot()).readJson(assertRelativePath(relativePath));
                    }
                    catch (error) {
                        if (isNotFound(error)) {
                            return undefined;
                        }
                        throw error;
                    }
                },
                readRequired: async () => await (await openRoot()).readJson(assertRelativePath(relativePath)),
                write: async (value, options) => {
                    const json = stringifyJsonDocument(value, null, 2);
                    await write(relativePath, options?.trailingNewline === false ? json : `${json}\n`);
                },
            }, jsonOptions);
        },
        pruneExpired: async (pruneOptions) => {
            await pruneExpiredStoreEntries({ rootDir, dirMode, options: pruneOptions });
        },
    };
}
export function fileStoreSync(options) {
    const rootDir = path.resolve(options.rootDir);
    const privateMode = options.private ?? false;
    const dirMode = options.dirMode ?? 0o700;
    const mode = options.mode ?? 0o600;
    const maxBytes = options.maxBytes;
    function write(relativePath, data, writeOptions) {
        const destination = resolveStorePath(rootDir, relativePath);
        const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
        assertMaxBytes(content.byteLength, writeOptions?.maxBytes ?? maxBytes);
        return writeFileSyncAtomic({
            rootDir,
            filePath: destination,
            content,
            privateMode,
            dirMode: writeOptions?.dirMode ?? dirMode,
            mode: writeOptions?.mode ?? mode,
        });
    }
    return {
        rootDir,
        path: (relativePath) => resolveStorePath(rootDir, relativePath),
        readTextIfExists: (relativePath, readOptions) => {
            const targetPath = resolveStorePath(rootDir, relativePath);
            const opened = openRootFileSync({
                absolutePath: targetPath,
                rootPath: rootDir,
                boundaryLabel: "store root",
                rejectHardlinks: true,
            });
            if (!opened.ok) {
                return handleSyncStoreReadOpenFailure(opened);
            }
            try {
                assertMaxBytes(opened.stat.size, readOptions?.maxBytes ?? maxBytes);
                const limit = readOptions?.maxBytes ?? maxBytes;
                try {
                    return limit === undefined
                        ? syncFs.readFileSync(opened.fd, "utf8")
                        : readFileDescriptorBoundedSync(opened.fd, limit).toString("utf8");
                }
                catch (error) {
                    throwFsSafeReadError(error, "store");
                }
            }
            finally {
                syncFs.closeSync(opened.fd);
            }
        },
        readJsonIfExists: (relativePath, readOptions) => {
            const raw = fileStoreSync({ rootDir, private: privateMode, dirMode, mode, maxBytes })
                .readTextIfExists(relativePath, readOptions);
            return raw === null ? null : JSON.parse(raw);
        },
        write,
        writeText: (relativePath, data, writeOptions) => write(relativePath, data, writeOptions),
        writeJson: (relativePath, data, writeOptions) => {
            const json = stringifyJsonDocument(data, null, 2);
            return write(relativePath, writeOptions?.trailingNewline === false ? json : `${json}\n`, writeOptions);
        },
    };
}
