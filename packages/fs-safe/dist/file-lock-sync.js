import fs from "node:fs";
import path from "node:path";
import { FsSafeError } from "./errors.js";
import { readSidecarLockSnapshotSync, relativeSidecarLockPath, removeSidecarLockIfUnchangedSync, serializeSidecarLockPayload, sidecarLockSnapshotMatches, } from "./sidecar-lock-reclaim.js";
import { computeSidecarLockDelayMs, sidecarLockPayloadCreatedAtMs, } from "./sidecar-lock-policy.js";
import { sleepSync } from "./timing.js";
const SYNC_HELD_LOCKS_KEY = Symbol.for("fsSafe.syncSidecarLocks");
const SYNC_CLEANUP_REGISTERED_KEY = Symbol.for("fsSafe.syncSidecarLockCleanupRegistered");
const SYNC_CLEANUP_HANDLER_KEY = Symbol.for("fsSafe.syncSidecarLockCleanupHandler");
function getSyncHeldLocks() {
    const globalWithState = globalThis;
    if (!globalWithState[SYNC_HELD_LOCKS_KEY]) {
        globalWithState[SYNC_HELD_LOCKS_KEY] = new Map();
    }
    return globalWithState[SYNC_HELD_LOCKS_KEY];
}
function releaseAllSyncHeldLocks() {
    const heldLocks = getSyncHeldLocks();
    for (const [normalizedTargetPath, held] of heldLocks) {
        if (held.timer) {
            clearInterval(held.timer);
            held.timer = undefined;
        }
        try {
            fs.closeSync(held.fd);
        }
        catch {
            // Best-effort process-exit cleanup.
        }
        try {
            removeSidecarLockIfUnchangedSync(held.lockPath, held.snapshot);
        }
        catch {
            // A surviving sidecar fails closed and can be reclaimed by policy.
        }
        heldLocks.delete(normalizedTargetPath);
    }
}
function ensureSyncExitCleanupRegistered() {
    const globalWithCleanup = globalThis;
    if (globalWithCleanup[SYNC_CLEANUP_REGISTERED_KEY])
        return;
    globalWithCleanup[SYNC_CLEANUP_REGISTERED_KEY] = true;
    globalWithCleanup[SYNC_CLEANUP_HANDLER_KEY] = releaseAllSyncHeldLocks;
    process.on("exit", releaseAllSyncHeldLocks);
}
function verifySyncHeldLock(held) {
    const current = readSidecarLockSnapshotSync(held.lockPath, held.parsePayload);
    return !!current && sidecarLockSnapshotMatches(current, held.snapshot);
}
function releaseSyncHeldLock(held) {
    const heldLocks = getSyncHeldLocks();
    if (heldLocks.get(held.normalizedTargetPath) !== held)
        return false;
    held.refCount -= 1;
    if (held.refCount > 0)
        return false;
    heldLocks.delete(held.normalizedTargetPath);
    if (held.timer) {
        clearInterval(held.timer);
        held.timer = undefined;
    }
    fs.closeSync(held.fd);
    removeSidecarLockIfUnchangedSync(held.lockPath, held.snapshot);
    return true;
}
function createSyncHeldLockHandle(held) {
    let released = false;
    const release = () => {
        if (released)
            return;
        released = true;
        releaseSyncHeldLock(held);
    };
    return {
        lockPath: held.lockPath,
        normalizedTargetPath: held.normalizedTargetPath,
        verifyStillHeld: () => verifySyncHeldLock(held),
        release,
        [Symbol.dispose]: release,
    };
}
function normalizeTargetPath(targetPath) {
    const resolved = path.resolve(targetPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    try {
        return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
    }
    catch {
        return resolved;
    }
}
function boundedLockPath(lockPath, lockRoot) {
    const resolved = path.resolve(lockPath);
    if (!lockRoot)
        return resolved;
    relativeSidecarLockPath(lockRoot, resolved);
    const parent = path.dirname(resolved);
    const parentReal = fs.realpathSync(parent);
    const parentRelative = path.relative(lockRoot.rootReal, parentReal);
    if (parentRelative === ".." || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) {
        throw new FsSafeError("outside-workspace", "sidecar lock parent is outside lockRoot");
    }
    return path.join(parentReal, path.basename(resolved));
}
function defaultShouldReclaim(payload, lockPath, staleMs, nowMs) {
    const createdAtMs = sidecarLockPayloadCreatedAtMs(payload);
    if (createdAtMs !== null)
        return nowMs - createdAtMs > staleMs;
    try {
        return nowMs - fs.statSync(lockPath).mtimeMs > staleMs;
    }
    catch {
        return true;
    }
}
function reclaimGuardExists(reclaimGuardPath) {
    try {
        fs.lstatSync(reclaimGuardPath);
        return true;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}
export function acquireFileLockSync(targetPath, options) {
    const normalizedTargetPath = normalizeTargetPath(targetPath);
    const lockPath = boundedLockPath(options.lockPath ?? `${normalizedTargetPath}.lock`, options.lockRoot);
    const heldLocks = getSyncHeldLocks();
    const held = heldLocks.get(normalizedTargetPath);
    if (held &&
        options.reentrantOwner !== undefined &&
        held.reentrantOwner !== undefined &&
        options.reentrantOwner === held.reentrantOwner) {
        held.refCount += 1;
        return createSyncHeldLockHandle(held);
    }
    const staleMs = options.staleMs ?? 30_000;
    const retry = options.retry ?? {};
    const startedAt = Date.now();
    let attempt = 0;
    const reclaimGuardPath = `${lockPath}.reclaim`;
    const waitForRetry = () => {
        const elapsed = Date.now() - startedAt;
        const timedOut = options.timeoutMs !== undefined && elapsed >= options.timeoutMs;
        if (timedOut || (retry.retries !== undefined && attempt >= retry.retries)) {
            throw Object.assign(new Error(`file lock timeout for ${normalizedTargetPath}`), {
                code: "file_lock_timeout",
                lockPath,
                normalizedTargetPath,
            });
        }
        sleepSync(computeSidecarLockDelayMs(retry, attempt));
        attempt += 1;
    };
    while (true) {
        if (reclaimGuardExists(reclaimGuardPath)) {
            waitForRetry();
            continue;
        }
        let fd;
        try {
            const payload = options.payload();
            const { raw, ownershipToken } = serializeSidecarLockPayload(payload);
            const noFollow = process.platform !== "win32" && typeof fs.constants.O_NOFOLLOW === "number"
                ? fs.constants.O_NOFOLLOW
                : 0;
            fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
            fs.writeFileSync(fd, raw, "utf8");
            fs.fsyncSync(fd);
            const snapshot = {
                raw,
                payload,
                stat: fs.fstatSync(fd),
                ownershipToken,
            };
            const createdHeld = {
                fd,
                lockPath,
                normalizedTargetPath,
                parsePayload: options.parsePayload,
                refCount: 1,
                reentrantOwner: options.reentrantOwner,
                snapshot,
            };
            heldLocks.set(normalizedTargetPath, createdHeld);
            ensureSyncExitCleanupRegistered();
            const returnedHandle = createSyncHeldLockHandle(createdHeld);
            if (options.onCompromised && (options.compromiseCheckIntervalMs ?? 0) > 0) {
                createdHeld.timer = setInterval(() => {
                    if (!returnedHandle.verifyStillHeld()) {
                        if (createdHeld.timer)
                            clearInterval(createdHeld.timer);
                        createdHeld.timer = undefined;
                        options.onCompromised?.({ lockPath, normalizedTargetPath });
                    }
                }, options.compromiseCheckIntervalMs);
                createdHeld.timer.unref();
            }
            fd = undefined;
            return returnedHandle;
        }
        catch (error) {
            if (fd !== undefined) {
                const failed = { payload: null, stat: fs.fstatSync(fd) };
                fs.closeSync(fd);
                fd = undefined;
                removeSidecarLockIfUnchangedSync(lockPath, failed);
            }
            if (error.code !== "EEXIST")
                throw error;
            if (heldLocks.has(normalizedTargetPath)) {
                waitForRetry();
                continue;
            }
            const snapshot = readSidecarLockSnapshotSync(lockPath, options.parsePayload, {
                rejectNonFile: true,
            });
            if (!snapshot)
                continue;
            const nowMs = Date.now();
            const reclaim = options.shouldReclaim
                ? options.shouldReclaim({
                    lockPath,
                    normalizedTargetPath,
                    payload: snapshot.payload,
                    staleMs,
                    nowMs,
                    heldByThisProcess: false,
                })
                : defaultShouldReclaim(snapshot.payload, lockPath, staleMs, nowMs);
            if (reclaim) {
                if (options.staleRecovery === "remove-if-unchanged" &&
                    snapshot.raw !== undefined &&
                    options.shouldRemoveStaleLock?.({
                        lockPath,
                        normalizedTargetPath,
                        raw: snapshot.raw,
                        payload: snapshot.payload,
                    })) {
                    let ownsReclaimGuard = false;
                    try {
                        fs.mkdirSync(reclaimGuardPath);
                        ownsReclaimGuard = true;
                        if (removeSidecarLockIfUnchangedSync(lockPath, snapshot))
                            continue;
                    }
                    catch (reclaimError) {
                        if (reclaimError.code !== "EEXIST") {
                            throw reclaimError;
                        }
                        waitForRetry();
                        continue;
                    }
                    finally {
                        if (ownsReclaimGuard) {
                            try {
                                fs.rmdirSync(reclaimGuardPath);
                            }
                            catch {
                                // A surviving reclaim guard fails closed.
                            }
                        }
                    }
                }
                throw Object.assign(new Error(`file lock stale for ${normalizedTargetPath}`), {
                    code: "file_lock_stale",
                    lockPath,
                    normalizedTargetPath,
                });
            }
            waitForRetry();
        }
    }
}
export function withFileLockSync(targetPath, options, fn) {
    const lock = acquireFileLockSync(targetPath, options);
    try {
        return fn();
    }
    finally {
        lock.release();
    }
}
