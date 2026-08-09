// Browser tests cover server context.list profiles plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import "./server-context.chrome-test-harness.js";
import * as chromeModule from "./chrome.js";
import { createBrowserRouteContext } from "./server-context.js";
import { beginProfileTransition } from "./server-context.lifecycle.js";
import { makeBrowserProfile, makeBrowserServerState } from "./server-context.test-harness.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("browser server-context listProfiles", () => {
  it("cancels one profile operation without interrupting a shared transition", async () => {
    const state = makeBrowserServerState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const profile = ctx.forProfile("openclaw");
    const runtime = state.profiles.get("openclaw");
    if (!runtime) {
      throw new Error("expected profile runtime");
    }

    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let transitionCompleted = false;
    const transition = beginProfileTransition({
      state,
      runtime,
      reason: "profile refresh requested",
      closeSharedAdapters: false,
      afterCleanup: async () => {
        await cleanupGate;
        transitionCompleted = true;
      },
    });
    const isChromeCdpReady = vi.mocked(chromeModule.isChromeCdpReady);
    isChromeCdpReady.mockResolvedValue(true);

    const controller = new AbortController();
    const aborted = profile.isReachable(undefined, { signal: controller.signal });
    const surviving = profile.isReachable();
    let survivingCompleted = false;
    void surviving.then(() => {
      survivingCompleted = true;
    });

    const reason = new Error("profile request cancelled during transition");
    controller.abort(reason);

    try {
      const outcome = await Promise.race([
        aborted.then(
          () => ({ state: "resolved" as const }),
          (error: unknown) => ({ state: "rejected" as const, error }),
        ),
        new Promise<{ state: "pending" }>((resolve) => {
          setTimeout(() => resolve({ state: "pending" }), 50);
        }),
      ]);

      expect(outcome).toEqual({ state: "rejected", error: reason });
      expect(transitionCompleted).toBe(false);
      expect(survivingCompleted).toBe(false);
      expect(isChromeCdpReady).not.toHaveBeenCalled();
    } finally {
      releaseCleanup();
      await transition;
    }

    await expect(surviving).resolves.toBe(true);
    expect(survivingCompleted).toBe(true);
    await expect(profile.isReachable()).resolves.toBe(true);
    expect(isChromeCdpReady).toHaveBeenCalledTimes(2);
  });

  it("reads running state only after an in-flight profile transition settles", async () => {
    const state = makeBrowserServerState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    ctx.forProfile("openclaw");
    const runtime = state.profiles.get("openclaw");
    if (!runtime) {
      throw new Error("expected profile runtime");
    }
    runtime.running = {
      pid: 123,
      exe: { kind: "chromium", path: "/usr/bin/chromium" },
      userDataDir: "/tmp/openclaw-profile",
      cdpPort: 18800,
      startedAt: Date.now(),
      proc: {} as never,
    };
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const transition = beginProfileTransition({
      state,
      runtime,
      reason: "stop requested",
      closeSharedAdapters: false,
      afterCleanup: async () => {
        await cleanupGate;
        runtime.running = null;
      },
    });
    vi.mocked(chromeModule.isChromeReachable).mockResolvedValue(false);

    const listing = ctx.listProfiles();
    await Promise.resolve();
    releaseCleanup();
    await transition;
    const profiles = await listing;

    expect(profiles[0]?.running).toBe(false);
  });

  it("bypasses SSRF gating when probing managed loopback profiles", async () => {
    const state = makeBrowserServerState({
      resolvedOverrides: {
        ssrfPolicy: {},
      },
    });
    const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);
    isChromeReachable.mockResolvedValue(true);

    const ctx = createBrowserRouteContext({ getState: () => state });
    const profiles = await ctx.listProfiles();

    expect(isChromeReachable).toHaveBeenCalledWith("http://127.0.0.1:18800", 200, undefined);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.name).toBe("openclaw");
    expect(profiles[0]?.running).toBe(true);
  });

  it("uses remote-class probes for attachOnly loopback CDP profiles", async () => {
    const state = makeBrowserServerState({
      profile: {
        name: "manual-cdp",
        cdpUrl: "http://127.0.0.1:9222",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        cdpPort: 9222,
        color: "#00AA00",
        driver: "openclaw",
        headless: false,
        attachOnly: true,
      },
      resolvedOverrides: {
        defaultProfile: "manual-cdp",
        ssrfPolicy: {},
      },
    });
    const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);
    isChromeReachable.mockResolvedValue(true);

    const ctx = createBrowserRouteContext({ getState: () => state });
    const profiles = await ctx.listProfiles();

    expect(isChromeReachable).toHaveBeenCalledWith(
      "http://127.0.0.1:9222",
      state.resolved.remoteCdpTimeoutMs,
      undefined,
    );
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.name).toBe("manual-cdp");
    expect(profiles[0]?.running).toBe(true);
  });

  it("redacts CDP URL credentials from profile status", async () => {
    const state = makeBrowserServerState({
      profile: {
        name: "manual-cdp",
        cdpUrl: "http://openclaw:relay-token@127.0.0.1:9222",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        cdpPort: 9222,
        color: "#00AA00",
        driver: "openclaw",
        headless: false,
        attachOnly: true,
      },
      resolvedOverrides: {
        defaultProfile: "manual-cdp",
        ssrfPolicy: {},
      },
    });
    const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);
    isChromeReachable.mockResolvedValue(true);

    const ctx = createBrowserRouteContext({ getState: () => state });
    const profiles = await ctx.listProfiles();

    expect(isChromeReachable).toHaveBeenCalledWith(
      "http://openclaw:relay-token@127.0.0.1:9222",
      state.resolved.remoteCdpTimeoutMs,
      undefined,
    );
    expect(profiles[0]?.cdpUrl).toBe("http://127.0.0.1:9222");
  });

  it.each(["constructor", "prototype"] as const)(
    "marks runtime-only %s profiles as missing from config",
    async (profileName) => {
      const profile = makeBrowserProfile({ name: profileName });
      const state = makeBrowserServerState({
        profile,
        resolvedOverrides: { profiles: {} },
      });
      state.profiles.set(profileName, {
        profile,
        running: { pid: 123 } as never,
        lastTargetId: null,
      });

      const ctx = createBrowserRouteContext({ getState: () => state });
      const profiles = await ctx.listProfiles();

      expect(profiles).toHaveLength(1);
      expect(profiles[0]).toMatchObject({ name: profileName, missingFromConfig: true });
    },
  );
});
