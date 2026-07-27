import type { RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { RouteId } from "../app-routes.ts";
import { sessionRefFromPath } from "../app-session-route-paths.ts";
import { startModelSetupFirstRunRedirectAfterLocation } from "../pages/model-setup/first-run.ts";
import {
  normalizeInitialApplicationLocation,
  resolveInitialApplicationLocation,
} from "./bootstrap-location.ts";
import { bootstrapApplication } from "./bootstrap.ts";
import type { ApplicationContext } from "./context.ts";
import { loadSettings, saveSettings } from "./settings.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function successfulRouteState(
  state: ReturnType<ReturnType<typeof bootstrapApplication>["router"]["getState"]>,
  routeId: RouteId,
  location: RouteLocation,
): typeof state {
  return {
    ...state,
    status: "success",
    location,
    resolvedLocation: location,
    matches: [
      {
        id: `${routeId}\u0000${location.pathname}${location.search}`,
        routeId,
        location,
        deps: location.search,
        status: "success",
        isFetching: false,
        updatedAt: 0,
        fetchCount: 0,
        abortController: new AbortController(),
        cause: "navigation",
        preload: false,
        invalid: false,
      },
    ],
    pendingMatches: [],
  };
}

describe("normalizeInitialApplicationLocation", () => {
  it("routes an opaque persisted key without aborting bootstrap", () => {
    expect(
      normalizeInitialApplicationLocation(
        { pathname: "/", search: "", hash: "" },
        "",
        "telegram:12345",
        "main",
      ),
    ).toEqual({ pathname: "/chat/main/telegram/12345", search: "", hash: "" });
  });

  it("leaves the initial location unchanged when a malformed key has no path", () => {
    const location = { pathname: "/", search: "?draft=hello", hash: "" };
    expect(normalizeInitialApplicationLocation(location, "", "agent::broken", "main")).toBe(
      location,
    );
  });

  it("waits for the configured default agent before normalizing a persisted alias", async () => {
    type GatewayListener = Parameters<ApplicationContext<RouteId>["gateway"]["subscribe"]>[0];
    let listener: GatewayListener | null = null;
    let snapshot = {
      phase: "connecting",
      client: null,
      hello: null,
    } as unknown as ApplicationContext<RouteId>["gateway"]["snapshot"];
    const gateway = {
      get snapshot() {
        return snapshot;
      },
      subscribe: (next: GatewayListener) => {
        listener = next;
        return () => undefined;
      },
    };
    const pending = resolveInitialApplicationLocation({
      location: { pathname: "/", search: "", hash: "" },
      basePath: "",
      sessionKey: "main",
      gateway,
      agentsList: () => null,
      signal: new AbortController().signal,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    snapshot = {
      phase: "connected",
      client: {},
      hello: {
        snapshot: {
          sessionDefaults: { defaultAgentId: "research", mainKey: "workspace" },
        },
      },
    } as unknown as ApplicationContext<RouteId>["gateway"]["snapshot"];
    const connectedListener = listener as GatewayListener | null;
    if (!connectedListener) {
      throw new Error("expected gateway readiness subscription");
    }
    connectedListener(snapshot);

    await expect(pending).resolves.toEqual({ pathname: "/chat/research", search: "", hash: "" });
  });

  it("does not wait for gateway defaults on an explicit startup route", async () => {
    const subscribe = vi.fn(() => () => undefined);
    const location = { pathname: "/settings/general", search: "", hash: "" };

    await expect(
      resolveInitialApplicationLocation({
        location,
        basePath: "",
        sessionKey: "main",
        gateway: {
          snapshot: { phase: "connecting", client: null, hello: null },
          subscribe,
        } as unknown as ApplicationContext<RouteId>["gateway"],
        agentsList: () => null,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(location);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("canonicalizes a scoped persisted main key when defaults are already known", async () => {
    const subscribe = vi.fn(() => () => undefined);

    await expect(
      resolveInitialApplicationLocation({
        location: { pathname: "/", search: "", hash: "" },
        basePath: "",
        sessionKey: "agent:research:workspace",
        gateway: {
          snapshot: {
            phase: "connected",
            client: {},
            hello: { snapshot: { sessionDefaults: { mainKey: "workspace" } } },
          },
          subscribe,
        } as unknown as ApplicationContext<RouteId>["gateway"],
        agentsList: () => null,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ pathname: "/chat/research", search: "", hash: "" });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it.each([
    {
      location: {
        pathname: "/chat",
        search: "?session=agent%3Aresearch%3Atelegram%3A12345",
        hash: "",
      },
      expected: { pathname: "/chat/research/telegram/12345", search: "", hash: "" },
      namespace: "chat",
      sessionKey: "agent:research:telegram:12345",
    },
    {
      location: {
        pathname: "/chat",
        search: "?session=agent%3Aresearch%3Atelegram%3A12345&face=dashboard",
        hash: "",
      },
      expected: { pathname: "/dashboard/research/telegram/12345", search: "", hash: "" },
      namespace: "dashboard",
      sessionKey: "agent:research:telegram:12345",
    },
    {
      location: {
        pathname: "/chat",
        search: "?session=agent%3Aresearch%3Arelease-deadbeef",
        hash: "",
      },
      expected: { pathname: "/chat/research/~key/release-deadbeef", search: "", hash: "" },
      namespace: "chat",
      sessionKey: "agent:research:release-deadbeef",
    },
  ] as const)("rewrites released query links to $expected.pathname", async (testCase) => {
    const subscribe = vi.fn(() => () => undefined);
    const resolved = await resolveInitialApplicationLocation({
      location: testCase.location,
      basePath: "",
      sessionKey: "agent:main:main",
      gateway: {
        snapshot: { phase: "connecting", client: null, hello: null },
        subscribe,
      } as unknown as ApplicationContext<RouteId>["gateway"],
      agentsList: () => ({ defaultId: "main", mainKey: "main", agents: [] }),
      signal: new AbortController().signal,
    });

    expect(resolved).toEqual(testCase.expected);
    expect(sessionRefFromPath(resolved.pathname, "", "main")).toMatchObject({
      namespace: testCase.namespace,
      kind: "literal",
      sessionKey: testCase.sessionKey,
    });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("does not consume Sessions list row-expansion state", async () => {
    const location = { pathname: "/sessions", search: "?session=agent%3Amain%3Amain", hash: "" };
    const subscribe = vi.fn(() => () => undefined);
    await expect(
      resolveInitialApplicationLocation({
        location,
        basePath: "",
        sessionKey: "agent:main:main",
        gateway: {
          snapshot: { phase: "connecting", client: null, hello: null },
          subscribe,
        } as unknown as ApplicationContext<RouteId>["gateway"],
        agentsList: () => null,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(location);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("waits for cold custom-main defaults before rewriting a released query link", async () => {
    type GatewayListener = Parameters<ApplicationContext<RouteId>["gateway"]["subscribe"]>[0];
    let listener: GatewayListener | null = null;
    let snapshot = {
      phase: "connecting",
      client: null,
      hello: null,
    } as unknown as ApplicationContext<RouteId>["gateway"]["snapshot"];
    const pending = resolveInitialApplicationLocation({
      location: {
        pathname: "/chat",
        search: "?session=agent%3Aresearch%3Aworkspace",
        hash: "",
      },
      basePath: "",
      sessionKey: "agent:main:main",
      gateway: {
        get snapshot() {
          return snapshot;
        },
        subscribe: (next: GatewayListener) => {
          listener = next;
          return () => undefined;
        },
      },
      agentsList: () => null,
      signal: new AbortController().signal,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    snapshot = {
      phase: "connected",
      client: {},
      hello: { snapshot: { sessionDefaults: { mainKey: "workspace" } } },
    } as unknown as ApplicationContext<RouteId>["gateway"]["snapshot"];
    const connectedListener = listener as GatewayListener | null;
    if (!connectedListener) {
      throw new Error("expected gateway readiness subscription");
    }
    connectedListener(snapshot);

    await expect(pending).resolves.toEqual({
      pathname: "/chat/research",
      search: "",
      hash: "",
    });
  });

  it("replaces a released dashboard query bookmark before router start", async () => {
    const initialLocation = {
      pathname: "/chat",
      search: "?session=agent%3Aresearch%3Arelease-deadbeef&face=dashboard&draft=ship",
      hash: "",
    };
    const gateway = {
      snapshot: {
        phase: "connected",
        client: {},
        hello: { snapshot: { sessionDefaults: { mainKey: "main" } } },
      },
      subscribe: vi.fn(() => () => undefined),
    } as unknown as ApplicationContext<RouteId>["gateway"];
    const canonicalLocation = await resolveInitialApplicationLocation({
      location: initialLocation,
      basePath: "",
      sessionKey: "agent:main:main",
      gateway,
      agentsList: () => ({ defaultId: "main", mainKey: "main", agents: [] }),
      signal: new AbortController().signal,
    });
    let currentLocation: RouteLocation = initialLocation;
    const replace = vi.fn((location: RouteLocation) => {
      currentLocation = location;
    });

    await startModelSetupFirstRunRedirectAfterLocation({
      context: { gateway } as unknown as ApplicationContext<RouteId>,
      enabled: false,
      history: { location: () => currentLocation, replace },
      initialLocationReady: Promise.resolve(canonicalLocation),
    });

    expect(replace).toHaveBeenCalledWith({
      pathname: "/dashboard/research/~key/release-deadbeef",
      search: "?draft=ship",
      hash: "",
    });
  });

  it("starts the first-run redirect after installing the persisted session location", async () => {
    const canonicalLocation = normalizeInitialApplicationLocation(
      { pathname: "/", search: "", hash: "" },
      "",
      "agent:main:main",
      "main",
    );
    expect(canonicalLocation).toEqual({ pathname: "/chat/main", search: "", hash: "" });

    let resolveInitialLocation: (location: RouteLocation) => void = () => undefined;
    const initialLocationReady = new Promise<RouteLocation>((resolve) => {
      resolveInitialLocation = resolve;
    });
    let currentLocation: RouteLocation = { pathname: "/", search: "", hash: "" };
    const replaceLocation = vi.fn((location: RouteLocation) => {
      currentLocation = location;
    });
    const request = vi.fn().mockResolvedValue({
      candidates: [],
      manualProviders: [],
      workspace: "/tmp/workspace",
      setupComplete: false,
    });
    const client = { request } as unknown as GatewayBrowserClient;
    type GatewayListener = Parameters<ApplicationContext<RouteId>["gateway"]["subscribe"]>[0];
    let listener: GatewayListener | null = null;
    const subscribe = vi.fn((next: GatewayListener) => {
      listener = next;
      return () => undefined;
    });
    const replaceRoute = vi.fn();
    const context = {
      gateway: {
        snapshot: { phase: "connecting", client: null, hello: null },
        subscribe,
      },
      replace: replaceRoute,
    } as unknown as ApplicationContext<RouteId>;

    const redirectReady = startModelSetupFirstRunRedirectAfterLocation({
      context,
      enabled: true,
      history: { location: () => currentLocation, replace: replaceLocation },
      initialLocationReady,
    });
    expect(subscribe).not.toHaveBeenCalled();

    resolveInitialLocation(canonicalLocation);
    await redirectReady;
    expect(replaceLocation).toHaveBeenCalledWith(canonicalLocation);
    expect(subscribe).toHaveBeenCalledOnce();

    const connectedListener = listener as GatewayListener | null;
    if (!connectedListener) {
      throw new Error("expected first-run gateway listener");
    }
    connectedListener({
      phase: "connected",
      client,
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["openclaw.setup.detect"] },
      },
    } as Parameters<GatewayListener>[0]);
    await vi.waitFor(() => expect(replaceRoute).toHaveBeenCalledOnce());
    expect(replaceRoute).toHaveBeenCalledWith("model-setup", { search: "?firstRun=1" });
  });

  it("does not restart routing after stop wins the session-path loader race", async () => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    saveSettings({
      ...previousSettings,
      sessionKey: "agent:main:main",
      lastActiveSessionKey: "agent:main:main",
    });
    window.history.replaceState({}, "", "/");
    const sessionPathBuilder = deferred<void>();
    const runtime = bootstrapApplication({ sessionPathBuilderReady: sessionPathBuilder.promise });
    const routerStart = vi.spyOn(runtime.router, "start");
    const redirectSubscription = vi.spyOn(runtime.context.gateway, "subscribe");

    try {
      const start = runtime.start();
      let settled = false;
      void start.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      runtime.stop();
      sessionPathBuilder.resolve();
      await start;

      expect(routerStart).not.toHaveBeenCalled();
      expect(redirectSubscription).not.toHaveBeenCalled();
    } finally {
      runtime.stop();
      saveSettings(previousSettings);
      window.history.replaceState({}, "", previousUrl);
    }
  });

  it("consumes an unscoped initial-location abort after stop wins the loader race", async () => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    saveSettings({
      ...previousSettings,
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
    window.history.replaceState({}, "", "/");
    const sessionPathBuilder = deferred<void>();
    const runtime = bootstrapApplication({ sessionPathBuilderReady: sessionPathBuilder.promise });
    const unhandledRejection = vi.fn((event: PromiseRejectionEvent) => event.preventDefault());
    window.addEventListener("unhandledrejection", unhandledRejection);

    try {
      const start = runtime.start();
      runtime.stop();
      sessionPathBuilder.resolve();
      await expect(start).resolves.toBeUndefined();
      await Promise.resolve();

      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", unhandledRejection);
      runtime.stop();
      saveSettings(previousSettings);
      window.history.replaceState({}, "", previousUrl);
    }
  });

  it("stops a cold released-link startup without leaking its late subscription", async () => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    saveSettings({
      ...previousSettings,
      sessionKey: "agent:main:main",
      lastActiveSessionKey: "agent:main:main",
    });
    window.history.replaceState({}, "", "/chat?session=agent%3Aresearch%3Aworkspace");
    const runtime = bootstrapApplication({ sessionPathBuilderReady: Promise.resolve() });
    type GatewayListener = Parameters<ApplicationContext<RouteId>["gateway"]["subscribe"]>[0];
    const gateway = runtime.context.gateway as ApplicationContext<RouteId>["gateway"] & {
      subscribe: (listener: GatewayListener) => () => void;
    };
    const originalSubscribe = gateway.subscribe.bind(gateway);
    const activeSubscriptions = new Set<GatewayListener>();
    gateway.subscribe = (listener) => {
      activeSubscriptions.add(listener);
      const unsubscribe = originalSubscribe(listener);
      return () => {
        activeSubscriptions.delete(listener);
        unsubscribe();
      };
    };
    const routerStart = vi.spyOn(runtime.router, "start");
    const configRefresh = vi.spyOn(runtime.context.config, "refresh");

    try {
      const start = runtime.start();
      await vi.waitFor(() => expect(activeSubscriptions.size).toBe(1));
      runtime.stop();
      await start;

      expect(activeSubscriptions.size).toBe(0);
      expect(configRefresh).not.toHaveBeenCalled();
      expect(routerStart).not.toHaveBeenCalled();
    } finally {
      runtime.stop();
      saveSettings(previousSettings);
      window.history.replaceState({}, "", previousUrl);
    }
  });

  it("stops the router immediately and again after an in-flight start settles", async () => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    saveSettings({
      ...previousSettings,
      sessionKey: "main",
      lastActiveSessionKey: "main",
    });
    window.history.replaceState({}, "", "/");
    const runtime = bootstrapApplication({ sessionPathBuilderReady: Promise.resolve() });
    const routerStarted = deferred<void>();
    const routerStart = vi.spyOn(runtime.router, "start").mockReturnValue(routerStarted.promise);
    const routerStop = vi.spyOn(runtime.router, "stop");

    try {
      const start = runtime.start();
      await vi.waitFor(() => expect(routerStart).toHaveBeenCalledOnce());
      runtime.stop();
      expect(routerStop).toHaveBeenCalledOnce();

      routerStarted.resolve();
      await start;
      expect(routerStop).toHaveBeenCalledTimes(2);
    } finally {
      runtime.stop();
      saveSettings(previousSettings);
      window.history.replaceState({}, "", previousUrl);
    }
  });
});

describe("explicit application route navigation", () => {
  it("lets a newer replacement return to the previous route while a push is pending", async () => {
    const runtime = bootstrapApplication({ sessionPathBuilderReady: Promise.resolve() });
    let state = successfulRouteState(runtime.router.getState(), "chat", {
      pathname: "/chat",
      search: "",
      hash: "",
    });
    const releaseNavigation = deferred<void>();
    vi.spyOn(runtime.router, "getState").mockImplementation(() => state);
    const navigate = vi
      .spyOn(runtime.router, "navigate")
      .mockImplementation(async (routeId, _context, _options, location) => {
        if (!location) {
          throw new Error("expected an explicit route location");
        }
        if (routeId === "new-session") {
          await releaseNavigation.promise;
          return;
        }
        state = successfulRouteState(state, routeId, location);
      });

    try {
      runtime.context.navigate("new-session", { search: "?agent=main" });
      runtime.context.replace("chat", { pathname: "/chat/main" });

      expect(navigate).toHaveBeenNthCalledWith(
        1,
        "new-session",
        runtime.context,
        { history: "push" },
        { pathname: "/new", search: "?agent=main", hash: "" },
      );
      expect(navigate).toHaveBeenNthCalledWith(
        2,
        "chat",
        runtime.context,
        { history: "replace" },
        { pathname: "/chat/main", search: "", hash: "" },
      );

      releaseNavigation.resolve();
      await Promise.resolve();
      await vi.waitFor(() => {
        expect(runtime.router.getState().matches[0]?.routeId).toBe("chat");
      });
      expect(navigate).toHaveBeenCalledTimes(2);
    } finally {
      releaseNavigation.resolve();
      runtime.stop();
    }
  });

  it("lets a replacement return after a cached route has already committed", async () => {
    const runtime = bootstrapApplication({ sessionPathBuilderReady: Promise.resolve() });
    let state = successfulRouteState(runtime.router.getState(), "chat", {
      pathname: "/chat",
      search: "",
      hash: "",
    });
    vi.spyOn(runtime.router, "getState").mockImplementation(() => state);
    const navigate = vi
      .spyOn(runtime.router, "navigate")
      .mockImplementation(async (routeId, _context, _options, location) => {
        if (!location) {
          throw new Error("expected an explicit route location");
        }
        state = successfulRouteState(state, routeId, location);
      });

    try {
      runtime.context.navigate("new-session");
      await Promise.resolve();
      await Promise.resolve();

      expect(runtime.router.getState().matches[0]?.routeId).toBe("new-session");
      runtime.context.replace("chat", { pathname: "/chat/main" });

      expect(navigate).toHaveBeenCalledTimes(2);
      expect(runtime.router.getState().matches[0]?.routeId).toBe("chat");
    } finally {
      runtime.stop();
    }
  });

  it("retries a silently superseded explicit route once without another history push", async () => {
    const runtime = bootstrapApplication({ sessionPathBuilderReady: Promise.resolve() });
    const previousUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    let state = runtime.router.getState();
    const releaseNavigation = deferred<void>();
    vi.spyOn(runtime.router, "getState").mockImplementation(() => state);
    const navigate = vi
      .spyOn(runtime.router, "navigate")
      .mockImplementation(async (routeId, _context, _options, location) => {
        if (!location) {
          throw new Error("expected an explicit route location");
        }
        if (navigate.mock.calls.length === 1) {
          await releaseNavigation.promise;
          return;
        }
        state = successfulRouteState(state, routeId, location);
      });

    try {
      runtime.context.navigate("new-session", { search: "?agent=research" });
      window.history.replaceState({}, "", "/new?agent=research");
      state = successfulRouteState(state, "chat", {
        pathname: "/chat/main",
        search: "",
        hash: "",
      });
      releaseNavigation.resolve();

      await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(2));
      expect(navigate).toHaveBeenNthCalledWith(
        2,
        "new-session",
        runtime.context,
        { history: "replace" },
        { pathname: "/new", search: "?agent=research", hash: "" },
      );
      expect(runtime.router.getState().matches[0]?.routeId).toBe("new-session");
    } finally {
      releaseNavigation.resolve();
      runtime.stop();
      window.history.replaceState({}, "", previousUrl);
    }
  });

  it("does not treat a cached match as committed while a newer match is pending", async () => {
    const runtime = bootstrapApplication({ sessionPathBuilderReady: Promise.resolve() });
    const previousUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    let state = successfulRouteState(runtime.router.getState(), "chat", {
      pathname: "/chat",
      search: "",
      hash: "",
    });
    const releaseNavigation = deferred<void>();
    vi.spyOn(runtime.router, "getState").mockImplementation(() => state);
    const navigate = vi
      .spyOn(runtime.router, "navigate")
      .mockImplementation(async (routeId, _context, _options, location) => {
        if (!location) {
          throw new Error("expected an explicit route location");
        }
        if (navigate.mock.calls.length === 1) {
          await releaseNavigation.promise;
          return;
        }
        state = successfulRouteState(state, routeId, location);
      });

    try {
      runtime.context.navigate("new-session");
      window.history.replaceState({}, "", "/new");
      const location = { pathname: "/new", search: "", hash: "" };
      const pendingUsage = successfulRouteState(state, "usage", {
        pathname: "/usage",
        search: "",
        hash: "",
      }).matches[0];
      if (!pendingUsage) {
        throw new Error("expected a pending usage match");
      }
      state = {
        ...successfulRouteState(state, "new-session", location),
        pendingMatches: [pendingUsage],
      };
      releaseNavigation.resolve();

      await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(2));
      expect(navigate).toHaveBeenNthCalledWith(
        2,
        "new-session",
        runtime.context,
        { history: "replace" },
        location,
      );
      expect(runtime.router.getState().pendingMatches).toEqual([]);
    } finally {
      releaseNavigation.resolve();
      runtime.stop();
      window.history.replaceState({}, "", previousUrl);
    }
  });

  it("does not reclaim a browser Back or Forward navigation", async () => {
    const runtime = bootstrapApplication({ sessionPathBuilderReady: Promise.resolve() });
    const previousUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    let state = successfulRouteState(runtime.router.getState(), "chat", {
      pathname: "/chat",
      search: "",
      hash: "",
    });
    const releaseNavigation = deferred<void>();
    vi.spyOn(runtime.router, "getState").mockImplementation(() => state);
    const navigate = vi
      .spyOn(runtime.router, "navigate")
      .mockImplementation(async (_routeId, _context, _options, location) => {
        if (!location) {
          throw new Error("expected an explicit route location");
        }
        await releaseNavigation.promise;
      });

    try {
      runtime.context.navigate("new-session");
      window.history.replaceState({}, "", "/usage");
      state = successfulRouteState(state, "usage", {
        pathname: "/usage",
        search: "",
        hash: "",
      });
      releaseNavigation.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(navigate).toHaveBeenCalledOnce();
      expect(runtime.router.getState().matches[0]?.routeId).toBe("usage");
      expect(window.location.pathname).toBe("/usage");
    } finally {
      releaseNavigation.resolve();
      runtime.stop();
      window.history.replaceState({}, "", previousUrl);
    }
  });

  it("lets the latest explicit destination supersede an older route", async () => {
    const runtime = bootstrapApplication({ sessionPathBuilderReady: Promise.resolve() });
    let state = runtime.router.getState();
    const releaseNavigation = deferred<void>();
    vi.spyOn(runtime.router, "getState").mockImplementation(() => state);
    const navigate = vi
      .spyOn(runtime.router, "navigate")
      .mockImplementation(async (routeId, _context, _options, location) => {
        if (!location) {
          throw new Error("expected an explicit route location");
        }
        if (routeId === "new-session") {
          await releaseNavigation.promise;
          return;
        }
        state = successfulRouteState(state, routeId, location);
      });

    try {
      runtime.context.navigate("new-session");
      runtime.context.navigate("usage");
      releaseNavigation.resolve();

      await vi.waitFor(() => {
        expect(runtime.router.getState().matches[0]?.routeId).toBe("usage");
      });
      await Promise.resolve();
      expect(navigate).toHaveBeenCalledTimes(2);
    } finally {
      releaseNavigation.resolve();
      runtime.stop();
    }
  });

  it("lets a newer cross-route replacement supersede a pending explicit navigation", async () => {
    const runtime = bootstrapApplication({ sessionPathBuilderReady: Promise.resolve() });
    let state = successfulRouteState(runtime.router.getState(), "chat", {
      pathname: "/chat",
      search: "",
      hash: "",
    });
    const releaseNavigation = deferred<void>();
    vi.spyOn(runtime.router, "getState").mockImplementation(() => state);
    const navigate = vi
      .spyOn(runtime.router, "navigate")
      .mockImplementation(async (routeId, _context, _options, location) => {
        if (!location) {
          throw new Error("expected an explicit route location");
        }
        if (routeId === "new-session") {
          await releaseNavigation.promise;
          return;
        }
        state = successfulRouteState(state, routeId, location);
      });

    try {
      runtime.context.navigate("new-session");
      runtime.context.replace("usage");
      releaseNavigation.resolve();

      await vi.waitFor(() => {
        expect(runtime.router.getState().matches[0]?.routeId).toBe("usage");
      });
      expect(navigate).toHaveBeenNthCalledWith(
        2,
        "usage",
        runtime.context,
        { history: "replace" },
        { pathname: "/usage", search: "", hash: "" },
      );
      expect(navigate).toHaveBeenCalledTimes(2);
    } finally {
      releaseNavigation.resolve();
      runtime.stop();
    }
  });

  it("reports a genuine route-loader failure without retrying it", async () => {
    const runtime = bootstrapApplication({ sessionPathBuilderReady: Promise.resolve() });
    const failure = new Error("new-session loader failed");
    const navigate = vi.spyOn(runtime.router, "navigate").mockRejectedValue(failure);
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      runtime.context.navigate("new-session");

      await vi.waitFor(() => {
        expect(logError).toHaveBeenCalledWith("[openclaw] route navigation failed", failure);
      });
      expect(navigate).toHaveBeenCalledOnce();
    } finally {
      logError.mockRestore();
      runtime.stop();
    }
  });
});
