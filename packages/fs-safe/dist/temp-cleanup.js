import fsSync from "node:fs";
import { sameFileIdentity } from "./file-identity.js";
const tempCleanupEntries = new Map();
let cleanupRegistered = false;
function pathStillMatchesReceipt(entry) {
    if (!entry.identity) {
        return false;
    }
    try {
        return sameFileIdentity(fsSync.lstatSync(entry.path), entry.identity);
    }
    catch (error) {
        return error.code === "ENOENT";
    }
}
function cleanupRegisteredTempPathsSync() {
    for (const entry of tempCleanupEntries.values()) {
        try {
            if (pathStillMatchesReceipt(entry)) {
                fsSync.rmSync(entry.path, { force: true, recursive: entry.recursive });
            }
        }
        catch {
            // Process-exit cleanup is best-effort.
        }
    }
    tempCleanupEntries.clear();
}
export function registerTempPathForExit(tempPath, options) {
    if (!cleanupRegistered) {
        cleanupRegistered = true;
        process.once("exit", cleanupRegisteredTempPathsSync);
    }
    const entry = {
        path: tempPath,
        recursive: options?.recursive === true,
        identity: options?.identity,
    };
    if (!entry.identity) {
        try {
            entry.identity = fsSync.lstatSync(tempPath);
        }
        catch {
            // Callers that register before creation set the identity after opening.
        }
    }
    tempCleanupEntries.set(tempPath, entry);
    const unregister = (() => {
        tempCleanupEntries.delete(tempPath);
    });
    unregister.setIdentity = (identity) => {
        entry.identity = identity;
    };
    return unregister;
}
export function __cleanupRegisteredTempPathsForTest() {
    cleanupRegisteredTempPathsSync();
}
export function __cleanupRegisteredTempPathForTest(tempPath) {
    const entry = tempCleanupEntries.get(tempPath);
    if (!entry) {
        return;
    }
    try {
        if (pathStillMatchesReceipt(entry)) {
            fsSync.rmSync(entry.path, { force: true, recursive: entry.recursive });
        }
    }
    finally {
        tempCleanupEntries.delete(tempPath);
    }
}
