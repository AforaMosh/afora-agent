import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalPathFromExistingAncestor } from "./absolute-path.js";
import { FsSafeError } from "./errors.js";
import { getFsSafeLockConfig } from "./lock-config.js";
import { createSidecarLockManager } from "./sidecar-lock.js";
import { serializePathWrite } from "./write-queue.js";
const activeStoreMutations = new AsyncLocalStorage();
function cloneFallback(value) {
    if (value && typeof value === "object") {
        return structuredClone(value);
    }
    return value;
}
function resolveLockOptions(filePath, options) {
    if (!options.lock) {
        return null;
    }
    const lockOptions = options.lock === true ? {} : options.lock;
    const defaults = getFsSafeLockConfig();
    return {
        managerKey: lockOptions.managerKey ?? `fs-safe.json-store:${filePath}`,
        retry: lockOptions.retry ?? defaults.retry ?? {},
        staleMs: lockOptions.staleMs ?? defaults.staleMs ?? 30_000,
        staleRecovery: lockOptions.staleRecovery ?? defaults.staleRecovery,
        timeoutMs: lockOptions.timeoutMs ?? defaults.timeoutMs ?? 30_000,
    };
}
export function createJsonStore(adapter, options = {}) {
    const lockOptions = resolveLockOptions(adapter.filePath, options);
    const locks = lockOptions ? createSidecarLockManager(lockOptions.managerKey) : null;
    async function read() {
        return await adapter.readIfExists();
    }
    async function readOr(fallback) {
        const current = await read();
        return current === undefined ? cloneFallback(fallback) : current;
    }
    async function write(value) {
        await adapter.write(value, {
            trailingNewline: options.trailingNewline ?? true,
        });
    }
    async function withSerializedMutation(run) {
        const canonicalPath = await canonicalPathFromExistingAncestor(adapter.filePath);
        const activePaths = activeStoreMutations.getStore();
        if (activePaths?.get(canonicalPath)?.active) {
            throw new FsSafeError("store-reentrant-update", `jsonStore cannot write or update ${canonicalPath} from inside its active update callback; return the complete next value from the outer update instead`);
        }
        return await serializePathWrite(`json-store:${canonicalPath}`, async () => {
            const mutationPaths = new Map([...(activePaths ?? [])].filter(([, token]) => token.active));
            const token = { active: true };
            mutationPaths.set(canonicalPath, token);
            return await activeStoreMutations.run(mutationPaths, async () => {
                try {
                    if (!locks || !lockOptions) {
                        return await run();
                    }
                    return await locks.withLock({
                        targetPath: adapter.filePath,
                        staleMs: lockOptions.staleMs,
                        timeoutMs: lockOptions.timeoutMs,
                        retry: lockOptions.retry,
                        staleRecovery: lockOptions.staleRecovery,
                        payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
                    }, run);
                }
                finally {
                    token.active = false;
                }
            });
        });
    }
    return {
        filePath: adapter.filePath,
        read,
        readOr,
        readRequired: adapter.readRequired,
        write: async (value) => {
            await withSerializedMutation(async () => {
                await write(value);
            });
        },
        update: async (run) => await withSerializedMutation(async () => {
            const next = await run(await read());
            await write(next);
            return next;
        }),
        updateOr: async (fallback, run) => await withSerializedMutation(async () => {
            const current = await read();
            const next = await run(current === undefined ? cloneFallback(fallback) : current);
            await write(next);
            return next;
        }),
    };
}
