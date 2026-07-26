/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import "./app-host.ts";
import {
  createRuntimeConfigCapability,
  type RuntimeConfigCapability,
} from "../lib/config/index.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  applyServerUiPrefs,
  changedServerUiPrefs,
  pushServerUiPrefs,
  resetServerUiPrefsSync,
} from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function configWithPrefs(prefs: Record<string, unknown>) {
  return { ui: { prefs } };
}

function createPrefsGateway(request: GatewayBrowserClient["request"]) {
  const client = { request } as GatewayBrowserClient;
  let snapshot: {
    client: GatewayBrowserClient;
    phase: "connected" | "reconnecting";
    sessionKey: string;
  } = { client, phase: "connected", sessionKey: "main" };
  const listeners = new Set<(next: typeof snapshot) => void>();
  const runtimeConfig = createRuntimeConfigCapability({
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return {
    runtimeConfig,
    publish(connected: boolean) {
      snapshot = {
        client,
        phase: connected ? "connected" : "reconnecting",
        sessionKey: "main",
      };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

function createPrefsRuntime(request: GatewayBrowserClient["request"]) {
  return createPrefsGateway(request).runtimeConfig;
}

function observePrefsSnapshots(
  runtimeConfig: RuntimeConfigCapability,
  scope: string,
  onApplied: Parameters<typeof applyServerUiPrefs>[1]["onApplied"],
  observedHashes?: string[],
) {
  return runtimeConfig.subscribe((state) => {
    const snapshot = state.configSnapshot;
    if (!snapshot) {
      return;
    }
    if (snapshot.hash) {
      observedHashes?.push(snapshot.hash);
    }
    applyServerUiPrefs(snapshot.sourceConfig ?? snapshot.config, {
      scope,
      snapshotHash: snapshot.hash ?? undefined,
      runtimeConfig,
      onApplied,
    });
  });
}

function settlePrefsQueue(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createPrefsSignal() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("server pref extraction", () => {
  it("applies only valid, known pref values", () => {
    const onApplied = vi.fn();
    expect(
      applyServerUiPrefs(
        configWithPrefs({
          theme: "knot",
          themeMode: "dark",
          locale: "de",
          chatShowThinking: false,
          chatSendShortcut: "modifier-enter",
          textScale: 125,
          sidebarLiveActivity: false,
          chatMessageMaxWidth: "82%",
          showAdvancedSettings: true,
          sidebarEntries: ["route:usage", "session:agent:main:test", "route:usage", 7],
          bogus: true,
        }),
        { onApplied },
      ),
    ).toBe(true);
    expect(onApplied).toHaveBeenCalledWith({
      theme: "knot",
      themeMode: "dark",
      locale: "de",
      chatShowThinking: false,
      chatSendShortcut: "modifier-enter",
      showAdvancedSettings: true,
      sidebarEntries: ["route:usage", "session:agent:main:test"],
    });
  });

  it("ignores invalid values and configs without prefs", () => {
    const onApplied = vi.fn();
    expect(
      applyServerUiPrefs(configWithPrefs({ theme: "neon", locale: "xx-YY" }), {
        onApplied,
      }),
    ).toBe(false);
    resetServerUiPrefsSync();
    expect(applyServerUiPrefs({}, { onApplied })).toBe(false);
    resetServerUiPrefsSync();
    expect(applyServerUiPrefs(null, { onApplied })).toBe(false);
    expect(applyServerUiPrefs(configWithPrefs({ theme: "custom" }), { onApplied })).toBe(false);
    expect(loadSettings().theme).toBe("claw");
    expect(onApplied).not.toHaveBeenCalled();
  });
});

describe("applyServerUiPrefs", () => {
  it("applies a server delta to the local mirror once", () => {
    const onApplied = vi.fn();
    const config = configWithPrefs({ themeMode: "dark" });

    expect(applyServerUiPrefs(config, { onApplied })).toBe(true);
    expect(loadSettings().themeMode).toBe("dark");
    expect(onApplied).toHaveBeenCalledWith({ themeMode: "dark" });

    // The same server value never re-applies, so a later local edit sticks.
    patchSettings({ themeMode: "light" });
    expect(applyServerUiPrefs(config, { onApplied })).toBe(false);
    expect(loadSettings().themeMode).toBe("light");
  });

  it("keeps an unpushed local edit across a sync reset (reload/reconnect)", () => {
    const onApplied = vi.fn();
    const config = configWithPrefs({ themeMode: "dark" });
    applyServerUiPrefs(config, { scope: "ws://gw", onApplied });
    patchSettings({ themeMode: "light" });

    // The last-seen server value persists per gateway scope, so the same old
    // server snapshot after a reload is not treated as a fresh change.
    resetServerUiPrefsSync();
    expect(applyServerUiPrefs(config, { scope: "ws://gw", onApplied })).toBe(false);
    expect(loadSettings().themeMode).toBe("light");
  });

  it("applies again when the server value actually changes", () => {
    const onApplied = vi.fn();
    applyServerUiPrefs(configWithPrefs({ themeMode: "dark" }), { onApplied });
    patchSettings({ themeMode: "light" });

    expect(applyServerUiPrefs(configWithPrefs({ themeMode: "system" }), { onApplied })).toBe(true);
    expect(loadSettings().themeMode).toBe("system");
  });

  it("applies only the fields the server actually changed", () => {
    const onApplied = vi.fn();
    applyServerUiPrefs(configWithPrefs({ themeMode: "dark", locale: "de" }), { onApplied });
    // Unpushable local edit on one field...
    patchSettings({ themeMode: "light" });

    // ...survives a server change to a *different* field.
    expect(
      applyServerUiPrefs(configWithPrefs({ themeMode: "dark", locale: "fr" }), { onApplied }),
    ).toBe(true);
    expect(loadSettings().locale).toBe("fr");
    expect(loadSettings().themeMode).toBe("light");
  });

  it("preserves a local sidebar edit when only another server preference changes", () => {
    const onApplied = vi.fn();
    const sidebarEntries = ["route:usage", "session:agent:main:test"];
    applyServerUiPrefs(configWithPrefs({ sidebarEntries, themeMode: "dark" }), { onApplied });
    patchSettings({ sidebarEntries: ["route:usage"] });

    expect(
      applyServerUiPrefs(
        configWithPrefs({ sidebarEntries: [...sidebarEntries], themeMode: "light" }),
        { onApplied },
      ),
    ).toBe(true);
    expect(loadSettings().sidebarEntries).toEqual(["route:usage"]);
    expect(loadSettings().themeMode).toBe("light");
    expect(onApplied).toHaveBeenLastCalledWith({ themeMode: "light" });
  });
});

describe("changedServerUiPrefs", () => {
  it("returns only changed shareable preferences", () => {
    const previous = loadSettings();
    const next = { ...previous, themeMode: "dark" as const, navCollapsed: !previous.navCollapsed };
    expect(changedServerUiPrefs(previous, next)).toEqual({ themeMode: "dark" });
    expect(changedServerUiPrefs(previous, { ...previous })).toBeNull();
    expect(
      changedServerUiPrefs(previous, {
        ...previous,
        textScale: 125,
        sidebarLiveActivity: false,
        chatMessageMaxWidth: "82%",
      }),
    ).toBeNull();
    expect(changedServerUiPrefs(previous, { ...previous, showAdvancedSettings: true })).toEqual({
      showAdvancedSettings: true,
    });
  });

  it("syncs canonical sidebar entries without treating equal arrays as changes", () => {
    const previous = loadSettings();
    const sidebarEntries = ["route:usage", "session:agent:main:test"];
    expect(changedServerUiPrefs(previous, { ...previous, sidebarEntries })).toEqual({
      sidebarEntries,
    });
    expect(
      changedServerUiPrefs(
        { ...previous, sidebarEntries },
        { ...previous, sidebarEntries: [...sidebarEntries] },
      ),
    ).toBeNull();
  });

  it("syncs chat behavior prefs and pushes clearable resets as null", () => {
    const previous = loadSettings();
    const withOverrides = {
      ...previous,
      chatPersistCommentary: false,
      chatFollowUpMode: "queue" as const,
    };
    expect(changedServerUiPrefs(previous, withOverrides)).toEqual({
      chatPersistCommentary: false,
      chatFollowUpMode: "queue",
    });

    // Clearing the follow-up override must propagate as an explicit removal.
    expect(
      changedServerUiPrefs(withOverrides, { ...withOverrides, chatFollowUpMode: undefined }),
    ).toEqual({ chatFollowUpMode: null });
  });
});

describe("clearable pref removal from the server", () => {
  it("clears the local follow-up override when the server removes it", () => {
    const onApplied = vi.fn();
    applyServerUiPrefs(configWithPrefs({ chatFollowUpMode: "queue" }), { onApplied });
    expect(loadSettings().chatFollowUpMode).toBe("queue");

    expect(applyServerUiPrefs(configWithPrefs({}), { onApplied })).toBe(true);
    expect(loadSettings().chatFollowUpMode).toBeUndefined();
  });
});

describe("pushServerUiPrefs", () => {
  it.each(
    (["replaced", "committed"] as const).flatMap((marker) =>
      (["new gateway runtime", "same-client reconnect"] as const).flatMap((transition) =>
        (
          [
            "snapshot before push",
            "push before first snapshot",
            "snapshot before owner adoption",
          ] as const
        ).map((arrival) => ({
          marker,
          transition,
          arrival,
        })),
      ),
    ),
  )(
    "never carries a $marker hash across $transition with $arrival",
    async ({ marker, transition, arrival }) => {
      const sharedHash = "shared-independent-gateway-hash";
      let owner: "previous" | "current" = "previous";
      let previousGets = 0;
      let currentGets = 0;
      let currentHash = sharedHash;
      let currentPrefs: Record<string, unknown> = {
        sidebarEntries: ["session:agent:current:private"],
        locale: "fr",
        themeMode: "light",
      };
      const submissions: Array<{ owner: string; raw: string }> = [];
      const previousSnapshot = createPrefsSignal();
      const currentSnapshot = createPrefsSignal();
      const request = vi.fn(async (method: string, params?: unknown) => {
        const requestOwner = owner;
        if (method === "config.get") {
          if (requestOwner === "previous") {
            if (++previousGets === 2) {
              await previousSnapshot.promise;
            }
            const prefs = { sidebarEntries: ["session:agent:previous:private"], locale: "de" };
            const config = configWithPrefs(prefs);
            return {
              hash: marker === "replaced" ? sharedHash : "previous-base",
              config,
              sourceConfig: structuredClone(config),
            };
          }
          if (++currentGets === 1) {
            await currentSnapshot.promise;
          }
          const config = configWithPrefs(currentPrefs);
          return { hash: currentHash, config, sourceConfig: structuredClone(config) };
        }
        if (method !== "config.patch") {
          return {};
        }
        const { raw } = params as { raw: string };
        submissions.push({ owner: requestOwner, raw });
        if (requestOwner === "previous") {
          return { hash: marker === "committed" ? sharedHash : "previous-committed" };
        }
        currentPrefs = {
          ...currentPrefs,
          ...(JSON.parse(raw) as { ui: { prefs: Record<string, unknown> } }).ui.prefs,
        };
        currentHash = "current-committed";
        return { hash: currentHash };
      });
      const previous = createPrefsGateway(request as GatewayBrowserClient["request"]);
      const scope = "ws://same-gateway-url.test";
      const onApplied = vi.fn();
      let unsubscribe = () => {};
      let current = previous;
      try {
        await previous.runtimeConfig.ensureLoaded();
        const previousConfigSnapshot = previous.runtimeConfig.state.configSnapshot;
        const previousConnectionEpoch = previous.runtimeConfig.connectionEpoch;
        applyServerUiPrefs(
          configWithPrefs({ sidebarEntries: ["session:agent:previous:private"] }),
          {
            scope,
            snapshotHash: marker === "replaced" ? sharedHash : "previous-base",
            runtimeConfig: previous.runtimeConfig,
            onApplied,
          },
        );
        onApplied.mockClear();
        pushServerUiPrefs(previous.runtimeConfig, { themeMode: "dark" });
        pushServerUiPrefs(previous.runtimeConfig, {
          sidebarEntries: ["session:agent:previous:private"],
        });
        await vi.waitFor(() => expect(previousGets).toBe(2));

        if (transition === "same-client reconnect") {
          previous.publish(false);
        }
        owner = "current";
        if (transition === "new gateway runtime") {
          current = createPrefsGateway(request as GatewayBrowserClient["request"]);
        }
        if (arrival !== "snapshot before owner adoption") {
          unsubscribe = observePrefsSnapshots(current.runtimeConfig, scope, onApplied);
        }
        if (transition === "same-client reconnect") {
          current.publish(true);
        }
        if (arrival === "push before first snapshot") {
          pushServerUiPrefs(current.runtimeConfig, { themeMode: "system" });
        } else {
          void current.runtimeConfig.ensureLoaded();
        }
        if (arrival === "snapshot before owner adoption") {
          currentSnapshot.release();
          await current.runtimeConfig.ensureLoaded();
          const authoritativeSnapshot = current.runtimeConfig.state.configSnapshot;
          if (!authoritativeSnapshot) {
            throw new Error("Current Gateway snapshot was not loaded");
          }
          applyServerUiPrefs(authoritativeSnapshot.sourceConfig ?? authoritativeSnapshot.config, {
            scope,
            snapshotHash: authoritativeSnapshot.hash ?? undefined,
            runtimeConfig: current.runtimeConfig,
            onApplied,
          });
          unsubscribe = observePrefsSnapshots(current.runtimeConfig, scope, onApplied);
          pushServerUiPrefs(current.runtimeConfig, { themeMode: "system" });
        }
        const navigation = { update: vi.fn() };
        const shell = document.createElement("openclaw-app-shell") as unknown as {
          runtime: unknown;
          reconcileServerUiPrefs: (
            runtimeConfig: RuntimeConfigCapability,
            snapshot?: unknown,
            connectionEpoch?: number,
          ) => void;
        };
        shell.runtime = {
          context: {
            runtimeConfig: current.runtimeConfig,
            gateway: { connection: { gatewayUrl: scope } },
            navigation,
            theme: { refresh: vi.fn() },
          },
        };
        pushServerUiPrefs(current.runtimeConfig, { locale: "fr" });
        for (let callback = 0; callback < 10; callback += 1) {
          shell.reconcileServerUiPrefs(
            previous.runtimeConfig,
            previousConfigSnapshot,
            previousConnectionEpoch,
          );
        }
        currentSnapshot.release();

        await vi.waitFor(() =>
          expect(onApplied).toHaveBeenCalledWith({
            sidebarEntries: ["session:agent:current:private"],
            locale: "fr",
            themeMode: "light",
          }),
        );
        expect(loadSettings().sidebarEntries).toEqual(["session:agent:current:private"]);
        expect(loadSettings().locale).toBe("fr");
        expect(
          submissions
            .filter((submission) => submission.owner === "current")
            .some((submission) => submission.raw.includes("session:agent:previous:private")),
        ).toBe(false);
        expect(navigation.update).not.toHaveBeenCalledWith({
          sidebarEntries: ["session:agent:previous:private"],
        });
        await vi.waitFor(() =>
          expect(
            submissions
              .filter((submission) => submission.owner === "current")
              .map((submission) => submission.raw),
          ).toEqual(
            expect.arrayContaining([
              expect.stringContaining('"fr"'),
              ...(arrival === "snapshot before owner adoption"
                ? [expect.stringContaining('"system"')]
                : []),
            ]),
          ),
        );
      } finally {
        previousSnapshot.release();
        currentSnapshot.release();
        unsubscribe();
        if (current !== previous) {
          current.runtimeConfig.dispose();
        }
        previous.runtimeConfig.dispose();
      }
    },
  );

  it.each([
    { acknowledgement: "hashed", omitAckHash: false },
    { acknowledgement: "hashless", omitAckHash: true },
  ])(
    "accepts a genuinely restored predecessor hash after observing its own $acknowledgement commit",
    async ({ acknowledgement, omitAckHash }) => {
      let revision = 1;
      let serverThemeMode = "light";
      const { promise: committedSnapshot, release: releaseCommittedSnapshot } = createPrefsSignal();
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "config.get") {
          if (revision === 2) {
            await committedSnapshot;
          }
          const config = configWithPrefs({ themeMode: serverThemeMode });
          return { hash: `hash-${revision}`, config, sourceConfig: structuredClone(config) };
        }
        if (method !== "config.patch") {
          return {};
        }
        const submission = params as { baseHash: string; raw: string };
        if (submission.baseHash !== `hash-${revision}`) {
          throw new Error("config changed since last load; re-run config.get and retry");
        }
        serverThemeMode = (JSON.parse(submission.raw) as { ui: { prefs: { themeMode: string } } })
          .ui.prefs.themeMode;
        revision += 1;
        return omitAckHash ? {} : { hash: `hash-${revision}` };
      });
      const runtimeConfig = createPrefsRuntime(request as GatewayBrowserClient["request"]);
      await runtimeConfig.ensureLoaded();
      const onApplied = vi.fn();
      const scope = `ws://restored-${acknowledgement}-predecessor.test`;
      applyServerUiPrefs(configWithPrefs({ themeMode: "light" }), {
        scope,
        snapshotHash: "hash-1",
        onApplied,
      });
      onApplied.mockClear();
      const unsubscribe = observePrefsSnapshots(runtimeConfig, scope, onApplied);

      patchSettings({ themeMode: "dark" });
      pushServerUiPrefs(runtimeConfig, { themeMode: "dark" });
      await vi.waitFor(() =>
        expect(request.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(2),
      );
      expect(
        applyServerUiPrefs(configWithPrefs({ themeMode: "light" }), {
          scope,
          snapshotHash: "hash-1",
          onApplied,
        }),
      ).toBe(false);
      releaseCommittedSnapshot();
      await vi.waitFor(() => expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-2"));

      expect(loadSettings().themeMode).toBe("dark");
      expect(onApplied).not.toHaveBeenCalledWith({ themeMode: "dark" });
      expect(
        applyServerUiPrefs(configWithPrefs({ themeMode: "light" }), {
          scope,
          snapshotHash: "hash-1",
          onApplied,
        }),
      ).toBe(true);
      expect(loadSettings().themeMode).toBe("light");
      expect(onApplied).toHaveBeenCalledWith({ themeMode: "light" });

      unsubscribe();
      runtimeConfig.dispose();
    },
  );

  it.each(
    (
      [
        { acknowledgement: "hashed", omitAckHash: false },
        { acknowledgement: "hashless", omitAckHash: true },
      ] as const
    ).flatMap((acknowledgement) =>
      [
        {
          preference: "theme mode",
          initialPrefs: { themeMode: "light" },
          committedPrefs: { themeMode: "dark" as const },
          restoredPrefs: { themeMode: "light" },
          expectedPatch: { themeMode: "light" },
        },
        {
          preference: "clearable removal",
          initialPrefs: {},
          committedPrefs: { chatFollowUpMode: "queue" as const },
          restoredPrefs: {},
          expectedPatch: { chatFollowUpMode: undefined },
        },
      ].flatMap((preference) =>
        (
          [
            { restoration: "a distinct hash", restoreOriginalHash: false },
            { restoration: "the original hash", restoreOriginalHash: true },
          ] as const
        ).map((restoration) => Object.assign({}, acknowledgement, preference, restoration)),
      ),
    ),
  )(
    "applies a foreign $preference restoration to $restoration before its $acknowledgement commit is observed",
    async ({
      acknowledgement,
      omitAckHash,
      initialPrefs,
      committedPrefs,
      restoredPrefs,
      expectedPatch,
      restoreOriginalHash,
    }) => {
      let revision = 1;
      let getCalls = 0;
      let persistedPrefs: Record<string, unknown> = { ...initialPrefs };
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "config.get") {
          getCalls += 1;
          if (getCalls === 2) {
            revision = restoreOriginalHash ? 1 : 3;
            persistedPrefs = { ...restoredPrefs };
          }
          const config = {
            ...configWithPrefs(persistedPrefs),
            foreignRevision: revision,
          };
          return { hash: `hash-${revision}`, config, sourceConfig: structuredClone(config) };
        }
        if (method !== "config.patch") {
          return {};
        }
        const submission = params as { baseHash: string; raw: string };
        if (submission.baseHash !== `hash-${revision}`) {
          throw new Error("config changed since last load; re-run config.get and retry");
        }
        persistedPrefs = {
          ...persistedPrefs,
          ...(JSON.parse(submission.raw) as { ui: { prefs: Record<string, unknown> } }).ui.prefs,
        };
        revision = 2;
        return omitAckHash ? {} : { hash: "hash-2" };
      });
      const runtimeConfig = createPrefsRuntime(request as GatewayBrowserClient["request"]);
      await runtimeConfig.ensureLoaded();
      const onApplied = vi.fn();
      const scope = `ws://foreign-${acknowledgement}-${Object.keys(committedPrefs)[0]}.test`;
      applyServerUiPrefs(configWithPrefs(initialPrefs), {
        scope,
        snapshotHash: "hash-1",
        onApplied,
      });
      onApplied.mockClear();
      const unsubscribe = observePrefsSnapshots(runtimeConfig, scope, onApplied);

      patchSettings(committedPrefs);
      pushServerUiPrefs(runtimeConfig, committedPrefs);
      await vi.waitFor(() => expect(getCalls).toBe(2));
      expect(runtimeConfig.state.configSnapshot?.hash).toBe(
        restoreOriginalHash ? "hash-1" : "hash-3",
      );
      await vi.waitFor(() => expect(onApplied).toHaveBeenCalledWith(expectedPatch));
      expect(loadSettings()).toMatchObject(expectedPatch);

      unsubscribe();
      runtimeConfig.dispose();
    },
  );

  it("marks sidebar arrays for replacement when pinned entries are removed", async () => {
    let hash = 0;
    let storedEntries: string[] = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        const config = configWithPrefs({ sidebarEntries: storedEntries });
        return { hash: `hash-${hash}`, config, sourceConfig: config };
      }
      const patch = JSON.parse((params as { raw: string }).raw) as {
        ui: { prefs: { sidebarEntries: string[] } };
      };
      storedEntries = patch.ui.prefs.sidebarEntries;
      hash += 1;
      return { hash: `hash-${hash}` };
    });
    const runtimeConfig = createPrefsRuntime(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();
    const sidebarEntries = ["route:usage", "session:agent:main:test"];

    pushServerUiPrefs(runtimeConfig, { sidebarEntries });
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("config.patch", {
        baseHash: "hash-0",
        raw: JSON.stringify({ ui: { prefs: { sidebarEntries } } }),
        replacePaths: ["ui.prefs.sidebarEntries"],
        sessionKey: "main",
        note: "control-ui prefs sync",
      });
      expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-1");
    });

    const remainingEntries = ["route:usage"];
    pushServerUiPrefs(runtimeConfig, { sidebarEntries: remainingEntries });
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("config.patch", {
        baseHash: "hash-1",
        raw: JSON.stringify({ ui: { prefs: { sidebarEntries: remainingEntries } } }),
        replacePaths: ["ui.prefs.sidebarEntries"],
        sessionKey: "main",
        note: "control-ui prefs sync",
      });
    });
    runtimeConfig.dispose();
  });

  it("keeps a newer local preference when its queued follow-up write fails", async () => {
    let revision = 1;
    let serverThemeMode = "light";
    let patchCalls = 0;
    const { promise: firstPatch, release: releaseFirstPatch } = createPrefsSignal();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        const config = configWithPrefs({ themeMode: serverThemeMode });
        return { hash: `hash-${revision}`, config, sourceConfig: config };
      }
      if (method !== "config.patch") {
        return {};
      }
      patchCalls += 1;
      if (patchCalls > 1) {
        throw new Error("queued preference temporarily unavailable");
      }
      await firstPatch;
      const parsed = JSON.parse((params as { raw: string }).raw) as {
        ui: { prefs: { themeMode: string } };
      };
      serverThemeMode = parsed.ui.prefs.themeMode;
      revision += 1;
      return { hash: `hash-${revision}` };
    });
    const runtimeConfig = createPrefsRuntime(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();
    const onApplied = vi.fn();
    const scope = "ws://queued-preference.test";
    applyServerUiPrefs(configWithPrefs({ themeMode: serverThemeMode }), {
      scope,
      snapshotHash: `hash-${revision}`,
      onApplied,
    });
    const unsubscribe = observePrefsSnapshots(runtimeConfig, scope, onApplied);

    patchSettings({ themeMode: "dark" });
    pushServerUiPrefs(runtimeConfig, { themeMode: "dark" });
    await vi.waitFor(() => expect(patchCalls).toBe(1));
    patchSettings({ themeMode: "light" });
    pushServerUiPrefs(runtimeConfig, { themeMode: "light" });
    releaseFirstPatch();
    await vi.waitFor(() => expect(patchCalls).toBe(2));

    expect(serverThemeMode).toBe("dark");
    expect(loadSettings().themeMode).toBe("light");
    expect(onApplied).not.toHaveBeenCalledWith({ themeMode: "dark" });
    unsubscribe();
    runtimeConfig.dispose();
  });

  it("retains acknowledged preference protection after its authoritative reload fails", async () => {
    let revision = 1;
    let serverThemeMode = "light";
    let getCalls = 0;
    let patchCalls = 0;
    const observedHashes: string[] = [];
    const { promise: recoveryPatch, release: releaseRecoveryPatch } = createPrefsSignal();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        getCalls += 1;
        if (getCalls === 2) {
          throw new Error("authoritative preference snapshot temporarily unavailable");
        }
        const config = configWithPrefs({ themeMode: serverThemeMode });
        return { hash: `hash-${revision}`, config, sourceConfig: structuredClone(config) };
      }
      if (method !== "config.patch") {
        return {};
      }
      patchCalls += 1;
      const submission = params as { baseHash: string; raw: string };
      if (submission.baseHash !== `hash-${revision}`) {
        throw new Error("config changed since last load; re-run config.get and retry");
      }
      if (patchCalls === 2) {
        await recoveryPatch;
      }
      serverThemeMode = (JSON.parse(submission.raw) as { ui: { prefs: { themeMode: string } } }).ui
        .prefs.themeMode;
      revision += 1;
      return { hash: `hash-${revision}` };
    });
    const runtimeConfig = createPrefsRuntime(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();
    const onApplied = vi.fn();
    const scope = "ws://failed-acknowledged-preference-reload.test";
    applyServerUiPrefs(configWithPrefs({ themeMode: serverThemeMode }), {
      scope,
      snapshotHash: "hash-1",
      onApplied,
    });
    onApplied.mockClear();
    const unsubscribe = observePrefsSnapshots(runtimeConfig, scope, onApplied, observedHashes);

    patchSettings({ themeMode: "dark" });
    pushServerUiPrefs(runtimeConfig, { themeMode: "dark" });
    await vi.waitFor(() => expect(getCalls).toBe(2));
    await settlePrefsQueue();

    patchSettings({ themeMode: "light" });
    pushServerUiPrefs(runtimeConfig, { themeMode: "light" });
    await vi.waitFor(() => expect(patchCalls).toBe(2));
    await runtimeConfig.refresh();
    const themeAfterRecovery = loadSettings().themeMode;
    releaseRecoveryPatch();
    await vi.waitFor(() => expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-3"));

    expect(observedHashes).toContain("hash-2");
    expect(serverThemeMode).toBe("light");
    expect(themeAfterRecovery).toBe("light");
    expect(loadSettings().themeMode).toBe("light");
    expect(onApplied).not.toHaveBeenCalledWith({ themeMode: "dark" });
    unsubscribe();
    runtimeConfig.dispose();
  });

  it.each([
    { acknowledgement: "hashed", omitAckHash: false },
    { acknowledgement: "hashless", omitAckHash: true },
  ])(
    "releases a queued preference after a committed $acknowledgement reload fails",
    async ({ acknowledgement, omitAckHash }) => {
      let revision = 1;
      let serverThemeMode = "light";
      let getCalls = 0;
      let patchCalls = 0;
      const submittedBaseHashes: string[] = [];
      const { promise: firstPatch, release: releaseFirstPatch } = createPrefsSignal();
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "config.get") {
          getCalls += 1;
          if (getCalls === 2) {
            throw new Error("authoritative preference snapshot temporarily unavailable");
          }
          const config = {
            ...configWithPrefs({ themeMode: serverThemeMode }),
            agents: { list: [{ id: "main", default: true }, { id: "worker" }] },
            env: { vars: { OPENCLAW_SYNTHETIC_TEST_ONLY: "synthetic-source-value" } },
          };
          return { hash: `hash-${revision}`, config, sourceConfig: structuredClone(config) };
        }
        if (method !== "config.patch") {
          return {};
        }
        patchCalls += 1;
        const submission = params as { baseHash: string; raw: string };
        submittedBaseHashes.push(submission.baseHash);
        if (submission.baseHash !== `hash-${revision}`) {
          throw new Error("config changed since last load; re-run config.get and retry");
        }
        if (patchCalls === 1) {
          await firstPatch;
        }
        serverThemeMode = (JSON.parse(submission.raw) as { ui: { prefs: { themeMode: string } } })
          .ui.prefs.themeMode;
        revision += 1;
        return patchCalls === 1 && omitAckHash
          ? { config: { agents: "__OPENCLAW_REDACTED__" } }
          : { hash: `hash-${revision}`, config: { agents: "__OPENCLAW_REDACTED__" } };
      });
      const runtimeConfig = createPrefsRuntime(request as GatewayBrowserClient["request"]);
      await runtimeConfig.ensureLoaded();
      const onApplied = vi.fn();
      const scope = `ws://${acknowledgement}-acknowledged-preference.test`;
      applyServerUiPrefs(configWithPrefs({ themeMode: serverThemeMode }), {
        scope,
        snapshotHash: "hash-1",
        onApplied,
      });
      onApplied.mockClear();
      const unsubscribe = observePrefsSnapshots(runtimeConfig, scope, onApplied);

      patchSettings({ themeMode: "dark" });
      pushServerUiPrefs(runtimeConfig, { themeMode: "dark" });
      await vi.waitFor(() => expect(patchCalls).toBe(1));
      patchSettings({ themeMode: "light" });
      pushServerUiPrefs(runtimeConfig, { themeMode: "light" });
      releaseFirstPatch();

      await vi.waitFor(() => expect(patchCalls).toBe(2));
      await vi.waitFor(() => expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-3"));
      expect(submittedBaseHashes).toEqual(["hash-1", "hash-2"]);
      expect(getCalls).toBe(4);
      expect(serverThemeMode).toBe("light");
      expect(loadSettings().themeMode).toBe("light");
      expect(onApplied).not.toHaveBeenCalledWith({ themeMode: "dark" });
      expect(runtimeConfig.state.configSnapshot?.sourceConfig).toEqual({
        ...configWithPrefs({ themeMode: "light" }),
        agents: { list: [{ id: "main", default: true }, { id: "worker" }] },
        env: { vars: { OPENCLAW_SYNTHETIC_TEST_ONLY: "synthetic-source-value" } },
      });
      unsubscribe();
      runtimeConfig.dispose();
    },
  );

  it("protects intent queued after the acknowledgement and before its snapshot publishes", async () => {
    let revision = 1;
    let themeMode = "light";
    let getCalls = 0;
    let patchCalls = 0;
    const { promise: committedSnapshot, release: releaseCommittedSnapshot } = createPrefsSignal();
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        getCalls += 1;
        if (getCalls === 2) {
          await committedSnapshot;
        }
        const config = configWithPrefs({ themeMode });
        return { hash: `hash-${revision}`, config, sourceConfig: config };
      }
      if (method !== "config.patch") {
        return {};
      }
      patchCalls += 1;
      if (patchCalls > 1) {
        throw new Error("queued preference temporarily unavailable");
      }
      const patch = JSON.parse((params as { raw: string }).raw) as {
        ui: { prefs: { themeMode: string } };
      };
      themeMode = patch.ui.prefs.themeMode;
      revision += 1;
      return { hash: `hash-${revision}` };
    });
    const runtimeConfig = createPrefsRuntime(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();
    const onApplied = vi.fn();
    const scope = "ws://ack-before-reload.test";
    applyServerUiPrefs(configWithPrefs({ themeMode }), {
      scope,
      snapshotHash: "hash-1",
      onApplied,
    });
    onApplied.mockClear();
    const unsubscribe = observePrefsSnapshots(runtimeConfig, scope, onApplied);

    patchSettings({ themeMode: "dark" });
    pushServerUiPrefs(runtimeConfig, { themeMode: "dark" });
    await vi.waitFor(() => {
      expect(patchCalls).toBe(1);
      expect(getCalls).toBe(2);
    });

    patchSettings({ themeMode: "light" });
    pushServerUiPrefs(runtimeConfig, { themeMode: "light" });
    releaseCommittedSnapshot();
    await vi.waitFor(() => expect(patchCalls).toBe(2));

    expect(themeMode).toBe("dark");
    expect(loadSettings().themeMode).toBe("light");
    expect(onApplied).not.toHaveBeenCalledWith({ themeMode: "dark" });
    unsubscribe();
    runtimeConfig.dispose();
  });

  it("waits for the connected runtime's initial authoritative config snapshot", async () => {
    const { promise: initialSnapshot, release: releaseInitialSnapshot } = createPrefsSignal();
    let revision = 1;
    let themeMode = "light";
    let getCalls = 0;
    let patchCalls = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        getCalls += 1;
        if (getCalls === 1) {
          await initialSnapshot;
        }
        const config = configWithPrefs({ themeMode });
        return { hash: `hash-${revision}`, config, sourceConfig: config };
      }
      if (method !== "config.patch") {
        return {};
      }
      patchCalls += 1;
      const submission = params as { raw: string; baseHash: string };
      if (submission.baseHash !== `hash-${revision}`) {
        throw new Error("config changed since last load; re-run config.get and retry");
      }
      themeMode = (JSON.parse(submission.raw) as { ui: { prefs: { themeMode: string } } }).ui.prefs
        .themeMode;
      revision += 1;
      return { hash: `hash-${revision}` };
    });
    const runtimeConfig = createPrefsRuntime(request as GatewayBrowserClient["request"]);
    const initialLoad = runtimeConfig.ensureLoaded();
    await vi.waitFor(() => expect(getCalls).toBe(1));
    expect(runtimeConfig.state.configSnapshot).toBeNull();

    pushServerUiPrefs(runtimeConfig, { themeMode: "dark" });
    expect(patchCalls).toBe(0);
    releaseInitialSnapshot();
    await initialLoad;
    await vi.waitFor(() => expect(patchCalls).toBe(1));

    expect(themeMode).toBe("dark");
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-2");
    runtimeConfig.dispose();
  });

  it("coalesces serial preference patches across a foreign CAS conflict", async () => {
    let hash = 1;
    const patched: unknown[] = [];
    const baseHashes: string[] = [];
    let storedPrefs: Record<string, unknown> = { themeMode: "light", locale: "en" };
    let agents = [{ id: "main" }, { id: "worker" }];
    const env = { vars: { OPENCLAW_SYNTHETIC_TEST_ONLY: "synthetic-source-value" } };
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        const config = { ...configWithPrefs(storedPrefs), agents: { list: agents }, env };
        return { hash: `hash-${hash}`, config, sourceConfig: structuredClone(config) };
      }
      if (method !== "config.patch") {
        return {};
      }
      const submission = params as { raw: string; baseHash: string };
      baseHashes.push(submission.baseHash);
      if (baseHashes.length === 1) {
        storedPrefs = { ...storedPrefs, locale: "fr" };
        agents = [...agents, { id: "foreign" }];
        hash += 1;
      }
      if (submission.baseHash !== `hash-${hash}`) {
        throw new Error("config changed since last load; re-run config.get and retry");
      }
      const parsed = JSON.parse(submission.raw) as {
        ui: { prefs: Record<string, unknown> };
      };
      storedPrefs = { ...storedPrefs, ...parsed.ui.prefs };
      hash += 1;
      patched.push(submission.raw);
      return { hash: `hash-${hash}` };
    });
    const runtimeConfig = createPrefsRuntime(request as GatewayBrowserClient["request"]);
    await runtimeConfig.ensureLoaded();
    const onApplied = vi.fn();
    const scope = "ws://coalesced-foreign-preference-owner.test";
    applyServerUiPrefs(configWithPrefs(storedPrefs), {
      scope,
      snapshotHash: "hash-1",
      onApplied,
    });
    const unsubscribe = observePrefsSnapshots(runtimeConfig, scope, onApplied);

    patchSettings({ themeMode: "dark" });
    pushServerUiPrefs(runtimeConfig, { themeMode: "dark" });
    patchSettings({ locale: "de", themeMode: "light" });
    pushServerUiPrefs(runtimeConfig, { locale: "de" });
    pushServerUiPrefs(runtimeConfig, { themeMode: "light" });

    await vi.waitFor(() => expect(patched).toHaveLength(2));
    // The first patch carries the first delta; the rest coalesce into one.
    expect(patched[0]).toBe(JSON.stringify({ ui: { prefs: { themeMode: "dark" } } }));
    expect(patched[1]).toBe(
      JSON.stringify({ ui: { prefs: { locale: "de", themeMode: "light" } } }),
    );
    expect(baseHashes).toEqual(["hash-1", "hash-2", "hash-3"]);
    expect(loadSettings()).toMatchObject({ themeMode: "light", locale: "de" });
    expect(runtimeConfig.state.configSnapshot?.sourceConfig).toEqual({
      ...configWithPrefs(storedPrefs),
      agents: { list: agents },
      env,
    });
    expect(agents).toContainEqual({ id: "foreign" });
    unsubscribe();
    runtimeConfig.dispose();
  });
});
