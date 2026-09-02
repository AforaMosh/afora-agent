import { randomBytes } from "node:crypto";
import fsSync, {} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readFileDescriptorBoundedSync, readFileHandleBounded } from "./bounded-read.js";
import { FsSafeError } from "./errors.js";
import { sameFileIdentity } from "./file-identity.js";
import { getFsSafeTestHooks } from "./test-hooks.js";
const MAX_LOCK_PAYLOAD_BYTES = 1024 * 1024;
const SIDECAR_LOCK_OWNERSHIP_TOKEN_BYTES = 16;
const SIDECAR_LOCK_OWNERSHIP_TOKEN_BITS = SIDECAR_LOCK_OWNERSHIP_TOKEN_BYTES * 8;
const SIDECAR_LOCK_OWNERSHIP_TOKEN_PREFIX = "\t".repeat(8);
const SIDECAR_LOCK_OWNERSHIP_TOKEN_PATTERN = new RegExp(`\\n(${SIDECAR_LOCK_OWNERSHIP_TOKEN_PREFIX}[ \\t]{${SIDECAR_LOCK_OWNERSHIP_TOKEN_BITS}})\\n$`);
function createSidecarLockOwnershipToken() {
    let token = SIDECAR_LOCK_OWNERSHIP_TOKEN_PREFIX;
    for (const byte of randomBytes(SIDECAR_LOCK_OWNERSHIP_TOKEN_BYTES)) {
        for (let bit = 7; bit >= 0; bit -= 1) {
            token += byte & (1 << bit) ? "\t" : " ";
        }
    }
    return token;
}
export function readSidecarLockOwnershipToken(raw) {
    return SIDECAR_LOCK_OWNERSHIP_TOKEN_PATTERN.exec(raw)?.[1];
}
export function serializeSidecarLockPayload(payload) {
    const ownershipToken = createSidecarLockOwnershipToken();
    return {
        raw: `${JSON.stringify(payload, null, 2)}\n${ownershipToken}\n`,
        ownershipToken,
    };
}
export function relativeSidecarLockPath(lockRoot, lockPath) {
    const resolved = path.resolve(lockPath);
    const lexicalRelative = path.relative(lockRoot.rootDir, resolved);
    const relative = lexicalRelative !== ".." &&
        !lexicalRelative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(lexicalRelative)
        ? lexicalRelative
        : path.relative(lockRoot.rootReal, resolved);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new FsSafeError("outside-workspace", "sidecar lock path is outside lockRoot");
    }
    return relative.split(path.sep).join(path.posix.sep);
}
export function parseSidecarLockPayload(raw, parser) {
    if (parser) {
        return parser(raw);
    }
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
export async function readSidecarLockSnapshot(lockPath, options = {}) {
    let handle;
    try {
        if (options.lockRoot) {
            const opened = await options.lockRoot.open(relativeSidecarLockPath(options.lockRoot, lockPath));
            try {
                const raw = (await readFileHandleBounded(opened.handle, MAX_LOCK_PAYLOAD_BYTES)).toString("utf8");
                return {
                    raw,
                    payload: parseSidecarLockPayload(raw, options.parsePayload),
                    stat: opened.stat,
                };
            }
            finally {
                await opened.handle.close().catch(() => undefined);
            }
        }
        const before = await fs.lstat(lockPath);
        if (!before.isFile() || before.isSymbolicLink()) {
            if (options.rejectNonFile) {
                throw new FsSafeError("not-file", `sidecar lock is not a regular file: ${lockPath}`);
            }
            return null;
        }
        await getFsSafeTestHooks()?.beforeSidecarLockSnapshotOpen?.(lockPath);
        const noFollow = process.platform !== "win32" && typeof fsSync.constants.O_NOFOLLOW === "number"
            ? fsSync.constants.O_NOFOLLOW
            : 0;
        try {
            handle = await fs.open(lockPath, fsSync.constants.O_RDONLY |
                noFollow |
                (typeof fsSync.constants.O_NONBLOCK === "number" ? fsSync.constants.O_NONBLOCK : 0));
        }
        catch (error) {
            if (options.rejectNonFile && error.code === "ELOOP") {
                throw new FsSafeError("not-file", `sidecar lock is not a regular file: ${lockPath}`, {
                    cause: error,
                });
            }
            throw error;
        }
        const opened = await handle.stat();
        if (!opened.isFile()) {
            if (options.rejectNonFile) {
                throw new FsSafeError("not-file", `sidecar lock is not a regular file: ${lockPath}`);
            }
            return null;
        }
        if (!options.allowDescriptorIdentityDrift && !sameFileIdentity(before, opened))
            return null;
        const raw = (await readFileHandleBounded(handle, MAX_LOCK_PAYLOAD_BYTES)).toString("utf8");
        const after = await fs.lstat(lockPath);
        if (!after.isFile() || !sameFileIdentity(before, after))
            return null;
        return { raw, payload: parseSidecarLockPayload(raw, options.parsePayload), stat: after };
    }
    catch (err) {
        if (err.code === "ENOENT" ||
            (err instanceof FsSafeError && err.code === "not-found")) {
            return null;
        }
        throw err;
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}
export function readSidecarLockSnapshotSync(lockPath, parsePayload, options = {}) {
    let fd;
    try {
        const before = fsSync.lstatSync(lockPath);
        if (!before.isFile() || before.isSymbolicLink()) {
            if (options.rejectNonFile) {
                throw new FsSafeError("not-file", `sidecar lock is not a regular file: ${lockPath}`);
            }
            return null;
        }
        const noFollow = process.platform !== "win32" && typeof fsSync.constants.O_NOFOLLOW === "number"
            ? fsSync.constants.O_NOFOLLOW
            : 0;
        fd = fsSync.openSync(lockPath, fsSync.constants.O_RDONLY | noFollow);
        const opened = fsSync.fstatSync(fd);
        const raw = readFileDescriptorBoundedSync(fd, MAX_LOCK_PAYLOAD_BYTES).toString("utf8");
        const after = fsSync.lstatSync(lockPath);
        if (!sameFileIdentity(before, opened) || !sameFileIdentity(opened, after))
            return null;
        return {
            raw,
            payload: parseSidecarLockPayload(raw, parsePayload),
            stat: after,
            ownershipToken: readSidecarLockOwnershipToken(raw),
        };
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
    finally {
        if (fd !== undefined)
            fsSync.closeSync(fd);
    }
}
export function removeSidecarLockIfUnchangedSync(lockPath, observed) {
    const current = readSidecarLockSnapshotSync(lockPath);
    if (!current || !sidecarLockSnapshotMatches(current, observed))
        return false;
    fsSync.rmSync(lockPath);
    return true;
}
export function sidecarLockSnapshotMatches(current, observed) {
    if (observed.ownershipToken !== undefined) {
        return (current.stat?.isFile() === true &&
            current.raw !== undefined &&
            observed.raw !== undefined &&
            readSidecarLockOwnershipToken(current.raw) === observed.ownershipToken &&
            readSidecarLockOwnershipToken(observed.raw) === observed.ownershipToken &&
            current.raw === observed.raw);
    }
    if (observed.stat && current.stat && !sameFileIdentity(observed.stat, current.stat)) {
        return false;
    }
    if (observed.raw !== undefined) {
        return current.raw === observed.raw;
    }
    return observed.stat !== undefined && current.stat !== undefined;
}
export async function removeSidecarLockIfUnchanged(lockPath, observed, options = {}) {
    const current = await readSidecarLockSnapshot(lockPath, {
        ...options,
        allowDescriptorIdentityDrift: observed?.ownershipToken !== undefined,
    });
    if (!current || !observed || !sidecarLockSnapshotMatches(current, observed)) {
        return false;
    }
    if (options.lockRoot) {
        await options.lockRoot.remove(relativeSidecarLockPath(options.lockRoot, lockPath)).catch(() => undefined);
    }
    else {
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
    }
    return true;
}
export async function sidecarLockSnapshotStillPresent(lockPath, observed, options = {}) {
    const current = await readSidecarLockSnapshot(lockPath, {
        ...options,
        allowDescriptorIdentityDrift: observed?.ownershipToken !== undefined,
    });
    return !!current && !!observed && sidecarLockSnapshotMatches(current, observed);
}
export async function sidecarReclaimGuardExists(pathname) {
    try {
        await fs.lstat(pathname);
        return true;
    }
    catch (err) {
        if (err.code === "ENOENT") {
            return false;
        }
        throw err;
    }
}
export async function tryAcquireSidecarReclaimGuard(reclaimGuards, reclaimGuardPath) {
    try {
        await fs.mkdir(reclaimGuardPath);
        reclaimGuards.add(reclaimGuardPath);
        return true;
    }
    catch (err) {
        if (err.code === "EEXIST") {
            return false;
        }
        throw err;
    }
}
export async function releaseSidecarReclaimGuard(reclaimGuards, reclaimGuardPath) {
    await fs.rmdir(reclaimGuardPath);
    reclaimGuards.delete(reclaimGuardPath);
}
export async function removeStaleSidecarLockIfAllowed(params) {
    if (!params.shouldRemoveStaleLock || params.snapshot.raw === undefined) {
        return "not-approved";
    }
    const ioOptions = { lockRoot: params.lockRoot, parsePayload: params.parsePayload };
    if (!(await sidecarLockSnapshotStillPresent(params.lockPath, params.snapshot, ioOptions))) {
        return "changed";
    }
    if (!(await params.shouldRemoveStaleLock({
        lockPath: params.lockPath,
        normalizedTargetPath: params.normalizedTargetPath,
        raw: params.snapshot.raw,
        payload: params.snapshot.payload,
    }))) {
        return "not-approved";
    }
    if (!(await sidecarLockSnapshotStillPresent(params.lockPath, params.snapshot, ioOptions))) {
        return "changed";
    }
    try {
        if (params.lockRoot) {
            await params.lockRoot.remove(relativeSidecarLockPath(params.lockRoot, params.lockPath));
        }
        else {
            await fs.rm(params.lockPath);
        }
        return "removed";
    }
    catch (err) {
        if (err.code === "ENOENT") {
            return "changed";
        }
        throw err;
    }
}
