//#region src/loading.ts
function isRouteControl(value) {
	return typeof value === "object" && value !== null && "type" in value && (value.type === "notFound" || value.type === "redirect");
}
function now() {
	return Date.now();
}
function createRouteLoading(options, matchStore) {
	const moduleCache = /* @__PURE__ */ new Map();
	const inFlight = /* @__PURE__ */ new Map();
	const gcTimers = /* @__PURE__ */ new Map();
	const freshTimeFor = (match, route, cause) => match.preload || cause === "preload" ? route.preloadStaleTime ?? options.preloadStaleTime : route.staleTime ?? options.staleTime;
	const isFresh = (match, route, cause) => match.status === "success" && !match.invalid && (!route.loader || now() - match.updatedAt < freshTimeFor(match, route, cause));
	const scheduleGc = (match, route) => {
		const gcTime = match.preload ? route.preloadGcTime ?? options.preloadGcTime : route.gcTime ?? options.gcTime;
		const remaining = gcTime - (now() - match.updatedAt);
		if (!matchStore.getCachedMatch(match.id) || remaining <= 0) {
			if (remaining <= 0) {
				matchStore.removeCached(match.id);
				gcTimers.delete(match.id);
			}
			return;
		}
		const previousTimer = gcTimers.get(match.id);
		if (previousTimer) globalThis.clearTimeout(previousTimer);
		const timer = globalThis.setTimeout(() => {
			const current = matchStore.getCachedMatch(match.id);
			if (!current) {
				gcTimers.delete(match.id);
				return;
			}
			if (now() - current.updatedAt < gcTime) {
				scheduleGc(current, route);
				return;
			}
			matchStore.removeCached(match.id);
			gcTimers.delete(match.id);
		}, remaining);
		gcTimers.set(match.id, timer);
		timer.unref?.();
	};
	const loadModule = (route, match) => {
		if (match.module !== void 0) return Promise.resolve(match.module);
		const cached = moduleCache.get(route.id);
		if (cached) return cached;
		const loaded = Promise.resolve(route.component());
		moduleCache.set(route.id, loaded);
		loaded.catch(() => moduleCache.delete(route.id));
		return loaded;
	};
	const loadData = (match, route, context, hookOptions, force) => {
		const current = matchStore.getMatch(match.id) ?? match;
		if (!force && isFresh(current, route, hookOptions.cause)) {
			matchStore.updateMatch(current.id, (next) => ({
				...next,
				preload: hookOptions.cause === "preload"
			}));
			scheduleGc(current, route);
			return Promise.resolve({
				data: current.data,
				updatedAt: current.updatedAt
			});
		}
		const loaded = route.loader?.(context, {
			...hookOptions,
			deps: current.deps
		});
		return Promise.resolve(loaded).then((data) => {
			if (isRouteControl(data)) throw data;
			return {
				data,
				updatedAt: now()
			};
		});
	};
	const loadRoute = async (match, route, context, hookOptions, force, onComponentLoaded) => {
		const existing = inFlight.get(match.id);
		if (existing && !force) return existing;
		const current = matchStore.getMatch(match.id) ?? match;
		const fetchCount = current.fetchCount + 1;
		matchStore.updateMatch(match.id, (next) => ({
			...next,
			isFetching: "loader",
			fetchCount
		}));
		const dataPromise = loadData(current, route, context, hookOptions, force);
		const visibleModulePromise = loadModule(route, current).then((module) => {
			if (matchStore.getMatch(current.id)?.fetchCount === fetchCount && !hookOptions.signal.aborted) {
				matchStore.updateMatch(current.id, (next) => ({
					...next,
					module
				}));
				onComponentLoaded?.(module);
			}
			return module;
		});
		const promise = Promise.all([dataPromise, visibleModulePromise]).then(([dataResult, module]) => {
			if (matchStore.getMatch(current.id)?.fetchCount !== fetchCount || hookOptions.signal.aborted) return {
				data: dataResult.data,
				module
			};
			matchStore.updateMatch(current.id, (next) => ({
				...next,
				data: dataResult.data,
				module,
				status: "success",
				isFetching: false,
				error: void 0,
				invalid: false,
				preload: hookOptions.cause === "preload",
				updatedAt: dataResult.updatedAt
			}));
			const resolved = matchStore.getMatch(current.id);
			if (resolved) scheduleGc(resolved, route);
			return {
				data: dataResult.data,
				module
			};
		});
		inFlight.set(match.id, promise);
		try {
			return await promise;
		} catch (error) {
			if (matchStore.getMatch(match.id)?.fetchCount === fetchCount && !hookOptions.signal.aborted) matchStore.updateMatch(match.id, (next) => ({
				...next,
				status: "error",
				isFetching: false,
				error,
				updatedAt: now()
			}));
			throw error;
		} finally {
			if (inFlight.get(match.id) === promise) inFlight.delete(match.id);
		}
	};
	return {
		loadRoute,
		scheduleGc,
		isFresh,
		shouldReloadInBackground: (route) => (route.staleReloadMode ?? options.staleReloadMode) === "background",
		clear() {
			const state = matchStore.getState();
			for (const match of [
				...state.matches,
				...state.pendingMatches,
				...state.cachedMatches
			]) if (match.isFetching || match.status === "pending") match.abortController.abort();
			for (const timer of gcTimers.values()) globalThis.clearTimeout(timer);
			gcTimers.clear();
			inFlight.clear();
			moduleCache.clear();
		}
	};
}
//#endregion
//#region src/matches.ts
function matchIdForLocation(routeId, deps) {
	return `${routeId}\u0000${deps}`;
}
function createRouteMatch(routeId, location, deps, cause, abortController, preload = false) {
	return {
		id: matchIdForLocation(routeId, deps),
		routeId,
		location,
		deps,
		status: "pending",
		isFetching: false,
		updatedAt: 0,
		fetchCount: 0,
		abortController,
		cause,
		preload,
		invalid: false
	};
}
function createMatchStore() {
	const active = /* @__PURE__ */ new Map();
	const pending = /* @__PURE__ */ new Map();
	const cached = /* @__PURE__ */ new Map();
	const listeners = /* @__PURE__ */ new Set();
	const matchListeners = /* @__PURE__ */ new Map();
	let location = locationForPath("/");
	let resolvedLocation = null;
	let status = "idle";
	let activeSnapshot = [];
	let pendingSnapshot = [];
	let cachedSnapshot = [];
	let transactionDepth = 0;
	let dirty = false;
	const changedMatchIds = /* @__PURE__ */ new Set();
	const readState = () => ({
		location,
		resolvedLocation,
		status,
		matches: activeSnapshot,
		pendingMatches: pendingSnapshot,
		cachedMatches: cachedSnapshot
	});
	const refreshSnapshots = () => {
		activeSnapshot = [...active.values()];
		pendingSnapshot = [...pending.values()];
		cachedSnapshot = [...cached.values()];
	};
	const notify = (matchId) => {
		dirty = true;
		if (matchId) changedMatchIds.add(matchId);
		if (transactionDepth > 0) return;
		const next = readState();
		const ids = [...changedMatchIds];
		changedMatchIds.clear();
		dirty = false;
		for (const listener of listeners) listener(next);
		for (const id of ids) {
			const match = active.get(id) ?? pending.get(id) ?? cached.get(id);
			for (const listener of matchListeners.get(id) ?? []) listener(match);
		}
	};
	const batch = (operation) => {
		transactionDepth += 1;
		try {
			operation();
		} finally {
			transactionDepth -= 1;
			if (transactionDepth === 0 && dirty) notify();
		}
	};
	const removeFromOtherPools = (id, keep) => {
		for (const pool of [
			active,
			pending,
			cached
		]) if (pool !== keep && pool.delete(id)) changedMatchIds.add(id);
	};
	const setPool = (pool, matches) => {
		let changed = false;
		const nextIds = new Set(matches.map((match) => match.id));
		for (const id of pool.keys()) if (!nextIds.has(id)) {
			pool.delete(id);
			changedMatchIds.add(id);
			changed = true;
		}
		for (const match of matches) {
			const previous = pool.get(match.id);
			removeFromOtherPools(match.id, pool);
			if (previous !== match) {
				pool.set(match.id, match);
				changedMatchIds.add(match.id);
				changed = true;
			}
		}
		if (changed) {
			refreshSnapshots();
			notify();
		}
	};
	const getMatch = (matchId) => active.get(matchId) ?? pending.get(matchId) ?? cached.get(matchId);
	return {
		batch,
		getState: readState,
		getMatch,
		getCachedMatch: (matchId) => cached.get(matchId),
		getActiveMatch: () => active.values().next().value,
		setLocation(nextLocation, nextResolvedLocation) {
			if (location.pathname === nextLocation.pathname && location.search === nextLocation.search && location.hash === nextLocation.hash && resolvedLocation?.pathname === nextResolvedLocation?.pathname && resolvedLocation?.search === nextResolvedLocation?.search && resolvedLocation?.hash === nextResolvedLocation?.hash) return;
			location = nextLocation;
			resolvedLocation = nextResolvedLocation;
			notify();
		},
		setStatus(nextStatus) {
			if (status === nextStatus) return;
			status = nextStatus;
			notify();
		},
		setActive(matches) {
			batch(() => setPool(active, matches));
		},
		setPending(matches) {
			batch(() => setPool(pending, matches));
		},
		setCached(matches) {
			batch(() => setPool(cached, matches));
		},
		removeCached(matchId) {
			if (!cached.delete(matchId)) return;
			refreshSnapshots();
			notify(matchId);
		},
		updateMatch(matchId, update) {
			const pool = [
				active,
				pending,
				cached
			].find((candidate) => candidate.has(matchId));
			const current = pool?.get(matchId);
			if (!pool || !current) return false;
			const next = update(current);
			if (next !== current) {
				pool.set(matchId, next);
				refreshSnapshots();
				notify(matchId);
			}
			return true;
		},
		invalidate(routeId) {
			batch(() => {
				for (const pool of [
					active,
					pending,
					cached
				]) for (const [id, match] of pool) if (routeId === void 0 || match.routeId === routeId) {
					pool.set(id, {
						...match,
						invalid: true,
						...match.status === "error" || match.status === "notFound" ? {
							status: "pending",
							error: void 0
						} : {}
					});
					notify(id);
				}
				refreshSnapshots();
			});
		},
		clear() {
			batch(() => {
				for (const pool of [
					active,
					pending,
					cached
				]) {
					for (const id of pool.keys()) changedMatchIds.add(id);
					pool.clear();
				}
				refreshSnapshots();
				location = locationForPath("/");
				resolvedLocation = null;
				status = "idle";
				notify();
			});
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		subscribeSelector(selector, listener, equal = Object.is) {
			let previous = selector(readState());
			const selectedListener = (state) => {
				const next = selector(state);
				if (equal(previous, next)) return;
				previous = next;
				listener(next);
			};
			listeners.add(selectedListener);
			return () => listeners.delete(selectedListener);
		},
		subscribeMatch(matchId, listener) {
			const current = matchListeners.get(matchId) ?? /* @__PURE__ */ new Set();
			current.add(listener);
			matchListeners.set(matchId, current);
			return () => {
				current.delete(listener);
				if (current.size === 0) matchListeners.delete(matchId);
				return true;
			};
		}
	};
}
function normalizeRouteBasePath(basePath) {
	const value = basePath.trim();
	if (!value || value === "/") return "";
	const withSlash = value.startsWith("/") ? value : `/${value}`;
	return withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}
function normalizeRoutePath(path) {
	const value = path.trim();
	if (!value) return "/";
	const withSlash = value.startsWith("/") ? value : `/${value}`;
	return withSlash.length > 1 && withSlash.endsWith("/") ? withSlash.slice(0, -1) : withSlash;
}
function pathKey(path) {
	const normalized = normalizeRoutePath(path).toLowerCase();
	if (normalized.endsWith("/index.html")) return normalizeRoutePath(normalized.slice(0, -11));
	return normalized;
}
function normalizeLocation(location) {
	return {
		pathname: normalizeRoutePath(location.pathname),
		search: location.search,
		hash: location.hash
	};
}
function pathnameWithoutBase(pathname, basePath) {
	const base = normalizeRouteBasePath(basePath);
	const path = normalizeRoutePath(pathname);
	if (path === base) return "/";
	return base && path.startsWith(`${base}/`) ? path.slice(base.length) : path;
}
function compileRoutes(routes) {
	const byId = /* @__PURE__ */ new Map();
	const byPath = /* @__PURE__ */ new Map();
	for (const route of routes) {
		if (byId.has(route.id)) throw new Error(`Duplicate route id "${route.id}".`);
		const normalizedRoute = {
			...route,
			path: normalizeRoutePath(route.path)
		};
		byId.set(route.id, normalizedRoute);
		for (const candidate of [normalizedRoute.path, ...route.aliases ?? []]) {
			const key = pathKey(candidate);
			const existing = byPath.get(key);
			if (existing && existing !== route.id) throw new Error(`Duplicate route path "${candidate}".`);
			byPath.set(key, route.id);
		}
	}
	return {
		byId,
		byPath,
		pathForRoute(routeId, basePath = "") {
			const route = byId.get(routeId);
			if (!route) throw new Error(`Unknown route id "${routeId}".`);
			const base = normalizeRouteBasePath(basePath);
			return base ? `${base}${route.path}` : route.path;
		},
		routeIdFromPath(pathname, basePath = "") {
			const key = pathKey(pathnameWithoutBase(pathname, basePath));
			return byPath.get(key) ?? null;
		}
	};
}
function locationForPath(path) {
	const hashIndex = path.indexOf("#");
	const searchIndex = path.indexOf("?");
	const queryStart = searchIndex < 0 ? hashIndex : hashIndex < 0 ? searchIndex : Math.min(searchIndex, hashIndex);
	const hashStart = hashIndex < 0 ? path.length : hashIndex;
	const pathnameEnd = queryStart < 0 ? path.length : queryStart;
	const searchEnd = hashIndex < 0 ? path.length : hashIndex;
	return {
		pathname: normalizeRoutePath(path.slice(0, pathnameEnd)),
		search: queryStart >= 0 && queryStart < hashStart ? path.slice(queryStart, searchEnd) : "",
		hash: hashStart < path.length ? path.slice(hashStart) : ""
	};
}
//#endregion
//#region src/router.ts
const DEFAULT_STALE_TIME = 0;
const DEFAULT_STALE_RELOAD_MODE = "background";
const DEFAULT_PRELOAD_STALE_TIME = 3e4;
const DEFAULT_GC_TIME = 30 * 6e4;
function isCurrentRun(current, run) {
	return current === run && !run.controller.signal.aborted;
}
function cancelRun(run) {
	run?.controller.abort();
}
function canCacheMatch(match) {
	return match.status === "success";
}
function isRouteNotFound(error) {
	return typeof error === "object" && error !== null && "type" in error && error.type === "notFound";
}
function isRouteRedirect(error) {
	return typeof error === "object" && error !== null && "type" in error && error.type === "redirect" && "location" in error && isRouteLocation(error.location);
}
function isRouteLocation(value) {
	return typeof value === "object" && value !== null && "pathname" in value && typeof value.pathname === "string" && "search" in value && typeof value.search === "string" && "hash" in value && typeof value.hash === "string";
}
function createRouter(options) {
	const compiled = compileRoutes(options.routes);
	const matches = createMatchStore();
	const loading = createRouteLoading({
		staleTime: options.staleTime ?? DEFAULT_STALE_TIME,
		staleReloadMode: options.defaultStaleReloadMode ?? DEFAULT_STALE_RELOAD_MODE,
		preloadStaleTime: options.preloadStaleTime ?? DEFAULT_PRELOAD_STALE_TIME,
		preloadGcTime: options.preloadGcTime ?? DEFAULT_GC_TIME,
		gcTime: options.gcTime ?? DEFAULT_GC_TIME
	}, matches);
	let history;
	let basePath = "";
	let stopHistory;
	let currentRun = null;
	let lastContext = { hasContext: false };
	const runHook = async (match, hook, context, hookOptions) => {
		if (!match || !hookOptions.shouldRun()) return;
		await compiled.byId.get(match.routeId)?.[hook]?.(context, match.data, {
			...hookOptions,
			location: match.location,
			deps: match.deps
		});
	};
	const navigate = async (routeId, context, navigationOptions = {}, requestedLocation = locationForPath(compiled.pathForRoute(routeId, basePath))) => {
		const route = compiled.byId.get(routeId);
		if (!route) throw new Error(`Unknown route id "${routeId}".`);
		lastContext = {
			hasContext: true,
			value: context
		};
		const location = normalizeLocation(requestedLocation);
		const previous = matches.getActiveMatch();
		const deps = route.loaderDeps?.(context, location) ?? "";
		const sameRoute = previous?.routeId === routeId;
		const matchId = matchIdForLocation(routeId, deps);
		const sameMatch = previous?.id === matchId;
		const revalidating = navigationOptions.revalidate === true && previous?.routeId === routeId;
		const cached = matches.getCachedMatch(matchId);
		const cachedReady = !sameMatch && cached?.status === "success" && cached.module !== void 0 && !cached.invalid;
		const cachedFresh = cachedReady && loading.isFresh(cached, route, "navigation");
		const backgroundReload = sameMatch && revalidating && previous?.status === "success" && previous.module !== void 0 ? true : cachedReady && !cachedFresh && loading.shouldReloadInBackground(route);
		if (history && navigationOptions.history && navigationOptions.history !== "none") history[navigationOptions.history](location);
		const ongoing = currentRun;
		if (ongoing?.matchId === matchId && ongoing.promise && !ongoing.controller.signal.aborted) {
			matches.updateMatch(matchId, (current) => ({
				...current,
				location
			}));
			matches.setLocation(location, matches.getState().resolvedLocation);
			ongoing.location = location;
			return ongoing.promise;
		}
		if (sameMatch && previous?.status === "success" && !previous.invalid && !revalidating) {
			cancelRun(currentRun);
			currentRun = null;
			matches.batch(() => {
				matches.updateMatch(previous.id, (current) => ({
					...current,
					location
				}));
				matches.setPending([]);
				matches.setLocation(location, location);
				matches.setStatus("success");
			});
			return;
		}
		cancelRun(currentRun);
		const controller = new AbortController();
		const cause = revalidating ? "revalidate" : "navigation";
		const match = sameMatch && previous ? {
			...previous,
			location,
			abortController: controller,
			cause,
			error: void 0,
			invalid: true,
			isFetching: "loader",
			preload: false
		} : cached ? {
			...cached,
			location,
			abortController: controller,
			cause,
			error: void 0,
			invalid: cached.invalid,
			isFetching: false,
			preload: false
		} : { ...createRouteMatch(routeId, location, deps, cause, controller) };
		const activatedCachedMatch = cachedReady && (cachedFresh || backgroundReload) ? {
			...match,
			isFetching: backgroundReload ? "loader" : false,
			preload: cachedFresh && !backgroundReload
		} : void 0;
		let targetPublished = Boolean(activatedCachedMatch);
		const run = {
			controller,
			matchId,
			location
		};
		currentRun = run;
		const hookOptions = {
			signal: controller.signal,
			shouldRun: () => isCurrentRun(currentRun, run),
			revalidating,
			location,
			deps,
			cause
		};
		const previousLocation = matches.getState().resolvedLocation;
		if (activatedCachedMatch) matches.batch(() => {
			if (previous && canCacheMatch(previous)) {
				matches.setCached([...matches.getState().cachedMatches.filter((candidate) => candidate.id !== previous.id), previous]);
				const previousRoute = compiled.byId.get(previous.routeId);
				if (previousRoute) loading.scheduleGc(previous, previousRoute);
			}
			matches.setActive([activatedCachedMatch]);
			matches.setPending([]);
			matches.setLocation(location, location);
			matches.setStatus("success");
		});
		else if (sameMatch) matches.updateMatch(match.id, () => match);
		else matches.setPending([match]);
		if (!activatedCachedMatch) {
			matches.setLocation(location, previousLocation);
			matches.setStatus(backgroundReload ? "success" : "loading");
		}
		const navigation = (async () => {
			let result;
			try {
				result = await loading.loadRoute(match, route, context, hookOptions, revalidating || Boolean(cached?.invalid), (module) => {
					if (!hookOptions.shouldRun() || matches.getActiveMatch()?.id === match.id) return;
					const loadedMatch = matches.getMatch(match.id);
					if (!loadedMatch) return;
					targetPublished = true;
					matches.batch(() => {
						if (previous && canCacheMatch(previous)) {
							matches.setCached([...matches.getState().cachedMatches.filter((candidate) => candidate.id !== previous.id), previous]);
							const previousRoute = compiled.byId.get(previous.routeId);
							if (previousRoute) loading.scheduleGc(previous, previousRoute);
						}
						matches.setActive([{
							...loadedMatch,
							module
						}]);
						matches.setPending([]);
						matches.setLocation(location, location);
					});
				});
			} catch (error) {
				if (!hookOptions.shouldRun()) return;
				if (isRouteRedirect(error)) {
					matches.updateMatch(match.id, (current) => ({
						...current,
						status: "redirected",
						isFetching: false,
						error,
						updatedAt: Date.now()
					}));
					matches.setStatus("redirected");
					currentRun = null;
					if (hookOptions.cause !== "preload") await handleLocation(error.location, context, false, "replace");
					return;
				}
				const status = isRouteNotFound(error) ? "notFound" : "error";
				const failedMatch = matches.getMatch(match.id);
				if (failedMatch) {
					const currentActive = targetPublished ? previous : matches.getActiveMatch();
					matches.batch(() => {
						if (!targetPublished && !sameMatch && currentActive && canCacheMatch(currentActive)) {
							matches.setCached([...matches.getState().cachedMatches, currentActive]);
							const currentRoute = compiled.byId.get(currentActive.routeId);
							if (currentRoute) loading.scheduleGc(currentActive, currentRoute);
						}
						matches.updateMatch(match.id, (current) => ({
							...current,
							status,
							isFetching: false,
							error,
							updatedAt: Date.now()
						}));
						if (!targetPublished) matches.setActive([matches.getMatch(match.id) ?? failedMatch]);
						matches.setPending([]);
						matches.setLocation(location, location);
						matches.setStatus(status);
					});
				} else matches.setStatus(status);
				if (isCurrentRun(currentRun, run)) currentRun = null;
				throw error;
			}
			if (!hookOptions.shouldRun()) return;
			const resolvedMatch = {
				...matches.getMatch(match.id) ?? {
					...match,
					data: result.data,
					module: result.module,
					status: "success",
					isFetching: false,
					error: void 0,
					invalid: false,
					updatedAt: Date.now()
				},
				preload: false
			};
			const currentActive = targetPublished ? previous : matches.getActiveMatch();
			matches.batch(() => {
				if (!targetPublished && !sameMatch && currentActive && canCacheMatch(currentActive)) {
					matches.setCached([...matches.getState().cachedMatches, currentActive]);
					const currentRoute = compiled.byId.get(currentActive.routeId);
					if (currentRoute) loading.scheduleGc(currentActive, currentRoute);
				}
				matches.setActive([resolvedMatch]);
				matches.setPending([]);
				matches.setLocation(run.location, run.location);
				matches.setStatus("success");
			});
			const lifecycleErrors = [];
			if (!sameRoute) {
				try {
					await runHook(currentActive, "onLeave", context, {
						...hookOptions,
						revalidating: false
					});
				} catch (error) {
					lifecycleErrors.push(error);
				}
				try {
					await runHook(resolvedMatch, "onEnter", context, hookOptions);
				} catch (error) {
					lifecycleErrors.push(error);
				}
			}
			if (lifecycleErrors.length > 0) {
				const error = lifecycleErrors[0];
				matches.updateMatch(resolvedMatch.id, (current) => ({
					...current,
					status: "error",
					error
				}));
				matches.setStatus("error");
				if (isCurrentRun(currentRun, run)) currentRun = null;
				throw error;
			}
			if (isCurrentRun(currentRun, run)) currentRun = null;
		})();
		run.promise = navigation;
		if (backgroundReload && !revalidating) {
			navigation.catch(() => void 0);
			return;
		}
		await navigation;
	};
	const handleLocation = async (location, context, revalidate = false, historyMode = "none") => {
		const normalized = normalizeLocation(location);
		const matched = compiled.routeIdFromPath(normalized.pathname, basePath);
		if (!matched) {
			cancelRun(currentRun);
			currentRun = null;
			matches.batch(() => {
				matches.setActive([]);
				matches.setPending([]);
				matches.setLocation(normalized, null);
				matches.setStatus("notFound");
			});
			return;
		}
		await navigate(matched, context, {
			history: historyMode,
			revalidate
		}, normalized);
	};
	const preloadAtLocation = (routeId, context, location) => {
		const route = compiled.byId.get(routeId);
		if (!route) return Promise.reject(/* @__PURE__ */ new Error(`Unknown route id "${routeId}".`));
		lastContext = {
			hasContext: true,
			value: context
		};
		const deps = route.loaderDeps?.(context, location) ?? "";
		const matchId = matchIdForLocation(routeId, deps);
		const existing = matches.getMatch(matchId);
		const cached = matches.getCachedMatch(matchId);
		const active = matches.getActiveMatch();
		if (active?.id === matchId && active.status === "success" && !active.invalid) return Promise.resolve();
		const match = existing ?? createRouteMatch(routeId, location, deps, "preload", new AbortController(), true);
		if (!existing) matches.setCached([...matches.getState().cachedMatches.filter((candidate) => candidate.id !== match.id), match]);
		const controller = match.abortController;
		const cause = existing && !cached ? match.cause : "preload";
		const hookOptions = {
			signal: controller.signal,
			shouldRun: () => !controller.signal.aborted,
			revalidating: false,
			location,
			deps,
			cause
		};
		return loading.loadRoute(match, route, context, hookOptions, false).then(() => void 0).catch((error) => {
			if (isRouteRedirect(error)) {
				matches.removeCached(match.id);
				return preloadLocation(error.location, context);
			}
			matches.removeCached(match.id);
		});
	};
	const preloadRoute = (routeId, context) => preloadAtLocation(routeId, context, locationForPath(compiled.pathForRoute(routeId, basePath)));
	const preloadLocation = (location, context) => {
		const normalized = normalizeLocation(location);
		const routeId = compiled.routeIdFromPath(normalized.pathname, basePath);
		return routeId ? preloadAtLocation(routeId, context, normalized) : Promise.resolve();
	};
	return {
		routes: [...compiled.byId.values()],
		getRoute: (routeId) => compiled.byId.get(routeId) ?? null,
		getMatch: matches.getMatch,
		preloadRoute,
		preloadLocation,
		invalidate(routeId) {
			matches.invalidate(routeId);
			const active = matches.getActiveMatch();
			if (!active || routeId !== void 0 && active.routeId !== routeId || !lastContext.hasContext) return Promise.resolve();
			return navigate(active.routeId, lastContext.value, {
				history: "none",
				revalidate: true
			}, active.location);
		},
		getState: matches.getState,
		subscribe: matches.subscribe,
		subscribeSelector: matches.subscribeSelector,
		subscribeMatch: matches.subscribeMatch,
		pathForRoute: compiled.pathForRoute,
		routeIdFromPath: compiled.routeIdFromPath,
		start(nextHistory, nextBasePath, context) {
			history = nextHistory;
			basePath = normalizeRouteBasePath(nextBasePath);
			stopHistory?.();
			stopHistory = history.listen((location) => {
				handleLocation(location, context).catch(() => void 0);
			});
			return handleLocation(history.location(), context, true);
		},
		navigate,
		navigateLocation(location, context) {
			const normalized = normalizeLocation(location);
			const matched = compiled.routeIdFromPath(normalized.pathname, basePath);
			if (!matched) {
				cancelRun(currentRun);
				currentRun = null;
				matches.batch(() => {
					matches.setActive([]);
					matches.setPending([]);
					matches.setLocation(normalized, null);
					matches.setStatus("notFound");
				});
				return Promise.resolve();
			}
			return navigate(matched, context, { history: "none" }, normalized);
		},
		revalidate(context, routeId = matches.getActiveMatch()?.routeId) {
			if (!routeId) return Promise.resolve();
			const target = matches.getActiveMatch()?.routeId === routeId ? matches.getActiveMatch()?.location : locationForPath(compiled.pathForRoute(routeId, basePath));
			return navigate(routeId, context, {
				history: "none",
				revalidate: true
			}, target);
		},
		stop() {
			stopHistory?.();
			stopHistory = void 0;
			cancelRun(currentRun);
			currentRun = null;
			history = void 0;
			lastContext = { hasContext: false };
			loading.clear();
			matches.clear();
		}
	};
}
//#endregion
//#region src/types.ts
function notFound(data) {
	return {
		type: "notFound",
		data
	};
}
function redirect(location) {
	return {
		type: "redirect",
		location
	};
}
function definePage(page) {
	return page;
}
//#endregion
export { createRouter, definePage, normalizeRouteBasePath, normalizeRoutePath, notFound, redirect };
