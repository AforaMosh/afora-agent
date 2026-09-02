import { CrablineError } from "../core/errors.js";
import { ScriptProviderAdapter } from "./builtin/script.js";
import { AFORA_SUPPORT_CATALOG } from "./catalog.js";
import { getBuiltinTargetCodec } from "./target-normalizers.js";
const LAZY_PROVIDER_FACTORIES = {
    async discord({ config, providerId, userName }) {
        const { DiscordProviderAdapter } = await import("./builtin/discord.js");
        return new DiscordProviderAdapter(providerId, config, userName);
    },
    async feishu({ config, providerId, userName }) {
        const { FeishuProviderAdapter } = await import("./builtin/feishu.js");
        return new FeishuProviderAdapter(providerId, config, userName);
    },
    async googlechat({ config, providerId, userName }) {
        const { GoogleChatProviderAdapter } = await import("./builtin/googlechat.js");
        return new GoogleChatProviderAdapter(providerId, config, userName);
    },
    async imessage({ config, providerId, userName }) {
        const { IMessageProviderAdapter } = await import("./builtin/imessage.js");
        return new IMessageProviderAdapter(providerId, config, userName);
    },
    async loopback({ config, providerId, userName }) {
        const { LoopbackProviderAdapter } = await import("./builtin/loopback.js");
        return new LoopbackProviderAdapter(providerId, config, userName);
    },
    async matrix({ config, providerId, userName }) {
        const { MatrixProviderAdapter } = await import("./builtin/matrix.js");
        return new MatrixProviderAdapter(providerId, config, userName);
    },
    async mattermost({ config, providerId, userName }) {
        const { MattermostProviderAdapter } = await import("./builtin/mattermost.js");
        return new MattermostProviderAdapter(providerId, config, userName);
    },
    async msteams({ config, providerId, userName }) {
        const { MsTeamsProviderAdapter } = await import("./builtin/msteams.js");
        return new MsTeamsProviderAdapter(providerId, config, userName);
    },
    async slack({ config, providerId, userName }) {
        const { SlackProviderAdapter } = await import("./builtin/slack.js");
        return new SlackProviderAdapter(providerId, config, userName);
    },
    async telegram({ config, providerId, userName }) {
        const { TelegramProviderAdapter } = await import("./builtin/telegram.js");
        return new TelegramProviderAdapter(providerId, config, userName);
    },
    async whatsapp({ config, providerId, userName }) {
        const { WhatsAppProviderAdapter } = await import("./builtin/whatsapp.js");
        return new WhatsAppProviderAdapter(providerId, config, userName);
    },
    async zalo({ config, providerId, userName }) {
        const { ZaloProviderAdapter } = await import("./builtin/zalo.js");
        return new ZaloProviderAdapter(providerId, config, userName);
    },
};
function createDispatchBarrier() {
    let resolveDispatch;
    const dispatch = {
        promise: new Promise((resolve) => {
            resolveDispatch = resolve;
        }),
        reach() {
            if (dispatch.reached) {
                return;
            }
            dispatch.reached = true;
            resolveDispatch?.();
        },
        reached: false,
    };
    return dispatch;
}
function isLazyAdapter(adapter) {
    return adapter in LAZY_PROVIDER_FACTORIES;
}
function createLazyProvider(params) {
    return new LazyProviderAdapter({
        adapterName: params.adapter,
        factory: () => LAZY_PROVIDER_FACTORIES[params.adapter](params),
        id: params.providerId,
        normalizeTarget: getBuiltinTargetCodec(params.adapter).normalize,
        platform: params.config.platform,
        status: "ready",
        supports: params.config.capabilities,
    });
}
export class LazyProviderAdapter {
    id;
    platform;
    status;
    supports;
    #factory;
    #normalizeTarget;
    #activeWatches = new Set();
    #inFlightOperations = new Set();
    #cleanedUp = false;
    #cleanupPromise = null;
    #providerInstance = null;
    #providerPromise = null;
    constructor(params) {
        this.#factory = params.factory;
        this.#normalizeTarget = params.normalizeTarget;
        this.id = params.id;
        this.platform = params.platform;
        this.status = params.status;
        this.supports = params.supports;
    }
    normalizeTarget(target) {
        this.#assertActive();
        return this.#normalizeTarget(target);
    }
    probe(context) {
        return this.#runOperation((provider) => provider.probe(context), context.signal);
    }
    send(context) {
        return this.#runOperation((provider) => provider.send(context), context.signal);
    }
    waitForInbound(context) {
        return this.#runOperation((provider) => provider.waitForInbound(context), context.signal);
    }
    watch(context) {
        if (this.#cleanedUp) {
            const error = this.#cleanedUpError();
            return {
                [Symbol.asyncIterator]() {
                    return {
                        next: () => Promise.reject(error),
                    };
                },
            };
        }
        const controller = new AbortController();
        const abortFromContext = () => controller.abort(context.signal?.reason);
        if (context.signal?.aborted) {
            abortFromContext();
        }
        else {
            context.signal?.addEventListener("abort", abortFromContext, { once: true });
        }
        const dispatch = createDispatchBarrier();
        const source = this.#watch(context, controller.signal, dispatch)[Symbol.asyncIterator]();
        let activeWatch;
        let closed = false;
        let closePromise = null;
        const finish = () => {
            if (closed) {
                return;
            }
            closed = true;
            context.signal?.removeEventListener("abort", abortFromContext);
            this.#activeWatches.delete(activeWatch);
        };
        const close = () => {
            if (closed) {
                return Promise.resolve({ done: true, value: undefined });
            }
            closePromise ??= (async () => {
                controller.abort();
                try {
                    const result = source.return
                        ? await source.return()
                        : { done: true, value: undefined };
                    if (result.done) {
                        finish();
                    }
                    return result;
                }
                catch (error) {
                    finish();
                    throw error;
                }
                finally {
                    dispatch.reach();
                }
            })();
            const closing = closePromise;
            void closing.then(() => {
                if (closePromise === closing) {
                    closePromise = null;
                }
            }, () => {
                if (closePromise === closing) {
                    closePromise = null;
                }
            });
            return closing;
        };
        const iterator = {
            async next() {
                try {
                    const result = await source.next();
                    if (result.done) {
                        finish();
                    }
                    return result;
                }
                catch (error) {
                    finish();
                    throw error;
                }
            },
            return: close,
            async throw(error) {
                controller.abort();
                try {
                    if (source.throw) {
                        return await source.throw(error);
                    }
                    throw error;
                }
                finally {
                    finish();
                }
            },
            [Symbol.asyncIterator]() {
                return this;
            },
        };
        activeWatch = {
            abort: () => controller.abort(),
            close: async () => {
                while (!(await close()).done) {
                    // Async iterators may yield final values before acknowledging return.
                }
            },
            dispatch,
        };
        this.#activeWatches.add(activeWatch);
        return iterator;
    }
    async cleanup() {
        this.#cleanedUp = true;
        for (const watch of this.#activeWatches) {
            watch.abort();
        }
        this.#cleanupPromise ??= (async () => {
            const operations = [...this.#inFlightOperations];
            const watches = [...this.#activeWatches];
            const closingWatches = watches.map(async (watch) => await watch.close());
            const providerCleanup = this.#cleanupProvider(operations
                .map((operation) => operation.dispatch)
                .concat(watches.map((watch) => watch.dispatch)));
            const [cleanupResult, , watchResults] = await Promise.all([
                providerCleanup.then(() => ({ ok: true }), (error) => ({ error, ok: false })),
                Promise.allSettled(operations.map((operation) => operation.completion)),
                Promise.allSettled(closingWatches),
            ]);
            const teardownErrors = watchResults.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
            if (!cleanupResult.ok) {
                teardownErrors.unshift(cleanupResult.error);
            }
            if (teardownErrors.length === 1) {
                throw teardownErrors[0];
            }
            if (teardownErrors.length > 1) {
                throw new AggregateError(teardownErrors, "Provider cleanup failed.");
            }
        })();
        await this.#cleanupPromise;
    }
    async #provider() {
        this.#assertActive();
        this.#providerPromise ??= this.#factory()
            .then((provider) => {
            this.#providerInstance = provider;
            return provider;
        })
            .catch((error) => {
            this.#providerPromise = null;
            throw error;
        });
        return await this.#providerPromise;
    }
    async *#watch(context, signal, dispatch) {
        try {
            if (signal.aborted) {
                return;
            }
            const provider = await this.#provider();
            if (signal.aborted) {
                return;
            }
            if (!provider.watch) {
                throw new CrablineError(`Provider "${this.id}" does not implement watch.`, {
                    kind: "config",
                });
            }
            dispatch.reach();
            yield* provider.watch({ ...context, signal });
        }
        finally {
            dispatch.reach();
        }
    }
    #assertActive() {
        if (this.#cleanedUp) {
            throw this.#cleanedUpError();
        }
    }
    async #cleanupProvider(dispatches) {
        const pendingDispatches = dispatches
            .filter((dispatch) => !dispatch.reached)
            .map((dispatch) => dispatch.promise);
        if (pendingDispatches.length > 0) {
            await Promise.allSettled(pendingDispatches);
        }
        let provider = this.#providerInstance;
        if (!provider) {
            const providerPromise = this.#providerPromise;
            if (!providerPromise) {
                return;
            }
            provider = await providerPromise;
        }
        if (!provider) {
            return;
        }
        const errors = [];
        try {
            provider.beginCleanup?.();
        }
        catch (error) {
            errors.push(error);
        }
        try {
            await provider.cleanup?.();
        }
        catch (error) {
            errors.push(error);
        }
        if (errors.length === 1) {
            throw errors[0];
        }
        if (errors.length > 1) {
            throw new AggregateError(errors, "Provider teardown failed.");
        }
    }
    #runOperation(run, signal) {
        if (this.#cleanedUp) {
            return Promise.reject(this.#cleanedUpError());
        }
        if (signal?.aborted) {
            return Promise.reject(signal.reason ?? new Error("Provider operation aborted."));
        }
        const dispatch = createDispatchBarrier();
        const underlying = (async () => {
            try {
                const provider = await this.#provider();
                if (signal?.aborted) {
                    throw signal.reason ?? new Error("Provider operation aborted.");
                }
                const result = run(provider);
                dispatch.reach();
                return await result;
            }
            catch (error) {
                dispatch.reach();
                throw error;
            }
        })();
        const operation = { completion: underlying, dispatch };
        this.#inFlightOperations.add(operation);
        void underlying.then(() => this.#inFlightOperations.delete(operation), () => this.#inFlightOperations.delete(operation));
        return underlying;
    }
    #cleanedUpError() {
        return new CrablineError(`Provider "${this.id}" has been cleaned up.`, { kind: "config" });
    }
}
export function createRegistry(manifest, manifestPath) {
    return {
        catalog: AFORA_SUPPORT_CATALOG,
        resolve(providerId, fixtureId) {
            const fixture = manifest.fixtures.find((entry) => entry.id === fixtureId);
            if (!fixture) {
                throw new CrablineError(`Unknown fixture: ${fixtureId}`, { kind: "config" });
            }
            const config = manifest.providers[providerId];
            if (!config) {
                throw new CrablineError(`Unknown provider: ${providerId}`, { kind: "config" });
            }
            if (fixture.provider !== providerId) {
                throw new CrablineError(`Fixture "${fixtureId}" belongs to provider "${fixture.provider}", not "${providerId}".`, { kind: "config" });
            }
            if (config.status === "disabled") {
                throw new CrablineError(`Provider "${providerId}" is disabled.`, { kind: "config" });
            }
            if (config.status === "planned") {
                throw new CrablineError(`Provider "${providerId}" is planned and cannot run.`, {
                    kind: "config",
                });
            }
            const context = {
                config,
                fixture,
                manifestPath,
                providerId,
                userName: manifest.userName,
            };
            if (isLazyAdapter(config.adapter)) {
                return createLazyProvider({
                    adapter: config.adapter,
                    config,
                    providerId,
                    userName: manifest.userName,
                });
            }
            return new ScriptProviderAdapter(context);
        },
    };
}
