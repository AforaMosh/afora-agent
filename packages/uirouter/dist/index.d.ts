//#region src/types.d.ts
type MaybePromise<T> = T | Promise<T>;
type RouteLocation = {
  pathname: string;
  search: string;
  hash: string;
};
type RouterHistory = {
  location: () => RouteLocation;
  push: (location: RouteLocation) => void;
  replace: (location: RouteLocation) => void;
  listen: (listener: (location: RouteLocation) => void) => () => void;
};
type RouteLoadCause = "navigation" | "preload" | "revalidate";
type RouteStaleReloadMode = "background" | "blocking";
type RouteMatchStatus = "pending" | "success" | "error" | "notFound" | "redirected";
type RouteMatchFetching = false | "loader";
type RouteNotFound = {
  type: "notFound";
  data?: unknown;
};
type RouteRedirect = {
  type: "redirect";
  location: RouteLocation;
};
declare function notFound(data?: unknown): RouteNotFound;
declare function redirect(location: RouteLocation): RouteRedirect;
type RouteHookOptions = {
  signal: AbortSignal;
  shouldRun: () => boolean;
  revalidating: boolean;
  location: RouteLocation;
  deps: string;
  cause: RouteLoadCause;
};
type RouteLoaderOptions = RouteHookOptions;
type RouteLoaderResult<TData> = TData | RouteNotFound | RouteRedirect;
type RouterNavigationOptions = {
  history?: "none" | "push" | "replace";
  revalidate?: boolean;
};
type PageDefinition<TRouteId extends string = string, TLoadContext = unknown, TModule = unknown, TData = unknown> = {
  id: TRouteId;
  path: string;
  aliases?: readonly string[];
  component: () => MaybePromise<TModule>;
  loaderDeps?: (context: TLoadContext, location: RouteLocation) => string;
  loader?: (context: TLoadContext, options: RouteLoaderOptions) => MaybePromise<RouteLoaderResult<TData>>;
  staleTime?: number;
  staleReloadMode?: RouteStaleReloadMode;
  preloadStaleTime?: number;
  preloadGcTime?: number;
  gcTime?: number;
  onEnter?: (context: TLoadContext, data: TData | undefined, options: RouteHookOptions) => MaybePromise<void>;
  onLeave?: (context: TLoadContext, data: TData | undefined, options: RouteHookOptions) => MaybePromise<void>;
};
type RouteMatch<TRouteId extends string = string, TModule = unknown, TData = unknown> = {
  id: string;
  routeId: TRouteId;
  location: RouteLocation;
  deps: string;
  status: RouteMatchStatus;
  isFetching: RouteMatchFetching;
  data?: TData;
  module?: TModule;
  error?: unknown;
  updatedAt: number;
  fetchCount: number;
  abortController: AbortController;
  cause: RouteLoadCause;
  preload: boolean;
  invalid: boolean;
};
type RouterState<TRouteId extends string = string, TModule = unknown, TData = unknown> = {
  location: RouteLocation;
  resolvedLocation: RouteLocation | null;
  status: "idle" | "loading" | "success" | "error" | "notFound" | "redirected";
  matches: readonly RouteMatch<TRouteId, TModule, TData>[];
  pendingMatches: readonly RouteMatch<TRouteId, TModule, TData>[];
  cachedMatches: readonly RouteMatch<TRouteId, TModule, TData>[];
};
type RouterStateSelector<TState, TSelected> = (state: TState) => TSelected;
type RouterOptions<TRouteId extends string, TLoadContext, TModule, TData> = {
  routes: readonly PageDefinition<TRouteId, TLoadContext, TModule, TData>[];
  staleTime?: number;
  defaultStaleReloadMode?: RouteStaleReloadMode;
  preloadStaleTime?: number;
  preloadGcTime?: number;
  gcTime?: number;
};
type Router<TRouteId extends string, TLoadContext, TModule, TData> = {
  routes: readonly PageDefinition<TRouteId, TLoadContext, TModule, TData>[];
  getRoute: (routeId: TRouteId) => PageDefinition<TRouteId, TLoadContext, TModule, TData> | null;
  getMatch: (matchId: string) => RouteMatch<TRouteId, TModule, TData> | undefined;
  preloadRoute: (routeId: TRouteId, context: TLoadContext) => Promise<void>;
  preloadLocation: (location: RouteLocation, context: TLoadContext) => Promise<void>;
  invalidate: (routeId?: TRouteId) => Promise<void>;
  getState: () => RouterState<TRouteId, TModule, TData>;
  subscribe: (listener: (next: RouterState<TRouteId, TModule, TData>) => void) => () => boolean;
  subscribeSelector: <TSelected>(selector: RouterStateSelector<RouterState<TRouteId, TModule, TData>, TSelected>, listener: (next: TSelected) => void, equal?: (previous: TSelected, next: TSelected) => boolean) => () => boolean;
  subscribeMatch: (matchId: string, listener: (next: RouteMatch<TRouteId, TModule, TData> | undefined) => void) => () => boolean;
  pathForRoute: (routeId: TRouteId, basePath?: string) => string;
  routeIdFromPath: (pathname: string, basePath?: string) => TRouteId | null;
  start: (history: RouterHistory, basePath: string, context: TLoadContext) => Promise<void>;
  navigate: (routeId: TRouteId, context: TLoadContext, options?: RouterNavigationOptions, requestedLocation?: RouteLocation) => Promise<void>;
  navigateLocation: (location: RouteLocation, context: TLoadContext) => Promise<void>;
  revalidate: (context: TLoadContext, routeId?: TRouteId) => Promise<void>;
  stop: () => void;
};
declare function definePage<const TRouteId extends string, TLoadContext = unknown, TModule = unknown, TData = unknown>(page: PageDefinition<TRouteId, TLoadContext, TModule, TData>): PageDefinition<TRouteId, TLoadContext, TModule, TData>;
//#endregion
//#region src/router.d.ts
declare function createRouter<TRouteId extends string, TLoadContext = unknown, TModule = unknown, TData = unknown>(options: RouterOptions<TRouteId, TLoadContext, TModule, TData>): Router<TRouteId, TLoadContext, TModule, TData>;
//#endregion
//#region src/matches.d.ts
declare function normalizeRouteBasePath(basePath: string): string;
declare function normalizeRoutePath(path: string): string;
//#endregion
export { type MaybePromise, type PageDefinition, type RouteHookOptions, type RouteLoadCause, type RouteLoaderOptions, type RouteLoaderResult, type RouteLocation, type RouteMatch, type RouteMatchFetching, type RouteMatchStatus, type RouteNotFound, type RouteRedirect, type Router, type RouterHistory, type RouterNavigationOptions, type RouterOptions, type RouterState, type RouterStateSelector, createRouter, definePage, normalizeRouteBasePath, normalizeRoutePath, notFound, redirect };