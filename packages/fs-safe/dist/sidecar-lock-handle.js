import { sidecarLockSnapshotStillPresent, } from "./sidecar-lock-reclaim.js";
export function createSidecarLockHandle(params) {
    let released = false;
    const release = async () => {
        if (released)
            return;
        released = true;
        await params.release();
    };
    return {
        lockPath: params.lockPath,
        normalizedTargetPath: params.normalizedTargetPath,
        verifyStillHeld: params.verifyStillHeld,
        release,
        [Symbol.asyncDispose]: release,
    };
}
export function createHeldSidecarLockHandle(params) {
    return createSidecarLockHandle({
        lockPath: params.held.lockPath,
        normalizedTargetPath: params.normalizedTargetPath,
        verifyStillHeld: async () => await sidecarLockSnapshotStillPresent(params.held.lockPath, params.held.snapshot, {
            lockRoot: params.held.lockRoot,
            parsePayload: params.held.parsePayload,
        }),
        release: params.release,
    });
}
