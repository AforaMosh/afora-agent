/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  applyServerUiPrefs,
  changedServerUiPrefs,
  flushServerUiPrefs,
  pushServerUiPrefs,
  resetServerUiPref,
  resetServerUiPrefsSync,
  resolveServerUiPrefState,
} from "./server-prefs.ts";
import { loadSettings, patchSettings, setSettingsChangeListener } from "./settings.ts";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
});

afterEach(() => {
  setSettingsChangeListener(null);
  resetServerUiPrefsSync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function configWithPrefs(prefs: Record<string, unknown>) {
  return { ui: { prefs } };
}

type RequestMock = ReturnType<typeof vi.fn<(method: string, params?: unknown) => Promise<unknown>>>;

function validationError(message = "invalid config") {
  return new GatewayRequestError({ code: "INVALID_REQUEST", message });
}

function createServerPrefsWriter(
  request: RequestMock,
  gatewayUrl = "ws://gw",
  connected = true,
  refresh: { ok: true } | { ok: false; error: string } = { ok: true },
): Parameters<typeof pushServerUiPrefs>[0] {
  const client = { request, gatewayUrl, connected } as unknown as GatewayBrowserClient;
  const writer = {
    state: { client, connected },
    runExternalMutation: async <T>(task: (client: GatewayBrowserClient) => Promise<T>) => {
      if (!writer.state.connected) {
        return {
          ok: false as const,
          reason: "unavailable" as const,
          error: "offline",
        };
      }
      try {
        return {
          ok: true as const,
          value: await task(client),
          refresh,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false as const,
          reason: message.includes("config changed since last load")
            ? ("conflict" as const)
            : error instanceof GatewayRequestError &&
                (error.gatewayCode === "INVALID_REQUEST" || error.gatewayCode === "FORBIDDEN")
              ? ("rejected" as const)
              : ("error" as const),
          error: message,
        };
      }
    },
  };
  return writer;
}

describe("pushServerUiPrefs", () => {
  const deferred = () => {
    let resolve!: (value: unknown) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, reject, resolve };
  };
  const pendingKey = (scope: string) => `openclaw.control.serverPrefs.pending.v1:${scope}`;
  const lastSeenKey = (scope: string) => `openclaw.control.serverPrefs.v1:${scope}`;
  const readPending = (scope: string) =>
    JSON.parse(localStorage.getItem(pendingKey(scope)) ?? "{}") as Record<string, unknown>;
  const createClient = createServerPrefsWriter;

  it("does not publish a server theme change shadowed by pending local intent", async () => {
    const scope = "ws://gw";
    const requestGate = deferred();
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      () => requestGate.promise,
    );
    const client = createClient(request, scope);
    const onApplied = vi.fn();
    const onThemeChanged = vi.fn();
    applyServerUiPrefs(configWithPrefs({ theme: "claw" }), {
      scope,
      onApplied,
      onThemeChanged,
    });
    onThemeChanged.mockClear();

    pushServerUiPrefs(client, { theme: "knot" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(
      applyServerUiPrefs(configWithPrefs({ theme: "knot" }), {
        scope,
        onApplied,
        onThemeChanged,
      }),
    ).toBe(false);
    expect(onThemeChanged).not.toHaveBeenCalled();

    requestGate.resolve({});
    await vi.waitFor(() => expect(localStorage.getItem(pendingKey(scope))).toBeNull());
  });

  it("retains an acknowledged theme baseline when storage cannot persist it", async () => {
    const scope = "ws://gw";
    const storage = createStorageMock();
    storage.setItem(lastSeenKey(scope), JSON.stringify({ theme: "claw" }));
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("storage read-only");
    });
    vi.stubGlobal("localStorage", storage);
    const request = vi.fn(async () => ({}));
    const afterCommit = vi.fn();

    pushServerUiPrefs(createClient(request, scope), { theme: "knot" }, { afterCommit });
    await vi.waitFor(() => expect(afterCommit).toHaveBeenCalledOnce());
    const onThemeChanged = vi.fn();
    expect(
      applyServerUiPrefs(configWithPrefs({ theme: "knot" }), {
        scope,
        onApplied: vi.fn(),
        onThemeChanged,
      }),
    ).toBe(false);
    expect(onThemeChanged).not.toHaveBeenCalled();
  });

  it("records an acknowledged reset as deletion instead of a literal null value", async () => {
    const scope = "ws://gw";
    localStorage.setItem(lastSeenKey(scope), JSON.stringify({ theme: "claw" }));
    const afterCommit = vi.fn();
    pushServerUiPrefs(
      createClient(
        vi.fn(async () => ({})),
        scope,
      ),
      { theme: null },
      {
        afterCommit,
      },
    );
    await vi.waitFor(() => expect(afterCommit).toHaveBeenCalledOnce());

    const onThemeChanged = vi.fn();
    expect(
      applyServerUiPrefs(configWithPrefs({}), {
        scope,
        onApplied: vi.fn(),
        onThemeChanged,
      }),
    ).toBe(false);
    expect(onThemeChanged).not.toHaveBeenCalled();
  });

  it("keeps a synced default reset as a pending offline null intent", () => {
    const scope = "ws://gw";
    const previous = loadSettings();
    const next = resetServerUiPref("theme");
    const prefs = changedServerUiPrefs(previous, next);
    expect(prefs).toEqual({ theme: null });

    pushServerUiPrefs(createClient(vi.fn(), scope, false), prefs ?? {});

    expect(readPending(scope)).toEqual({ theme: null });
    expect(resolveServerUiPrefState(configWithPrefs({ theme: "claw" }), "theme", scope)).toEqual({
      overridden: false,
      provenance: "pending",
      resetValue: "claw",
      value: "claw",
    });
  });

  it("marks an offline value as pending until the gateway acknowledges it", () => {
    const scope = "ws://gw";
    const beforeLocalEdit = loadSettings();
    const pending = patchSettings({ chatFollowUpMode: "steer" });
    const prefs = changedServerUiPrefs(beforeLocalEdit, pending);

    pushServerUiPrefs(createClient(vi.fn(), scope, false), prefs ?? {});

    expect(readPending(scope)).toEqual({ chatFollowUpMode: "steer" });
    expect(
      resolveServerUiPrefState(
        configWithPrefs({ chatFollowUpMode: "queue" }),
        "chatFollowUpMode",
        scope,
      ),
    ).toEqual({
      overridden: true,
      provenance: "pending",
      resetValue: undefined,
      value: "steer",
    });
  });

  it("retains rejected appearance edits as device-local state with local-only reset", async () => {
    const scope = "ws://gw";
    const config = configWithPrefs({
      theme: "claw",
      locale: "de",
      chatFollowUpMode: "queue",
    });
    applyServerUiPrefs(config, { scope, onApplied: vi.fn() });
    const beforeLocalEdit = loadSettings();
    const retained = patchSettings({
      theme: "knot",
      locale: "fr",
      chatFollowUpMode: "steer",
    });
    const prefs = changedServerUiPrefs(beforeLocalEdit, retained);
    const afterCommit = vi.fn();
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => {
      throw validationError();
    });

    pushServerUiPrefs(createClient(request, scope), prefs ?? {}, { afterCommit });

    await vi.waitFor(() =>
      expect(afterCommit).toHaveBeenCalledWith({
        needsRefresh: false,
        retainedLocal: true,
      }),
    );
    const themeState = resolveServerUiPrefState(config, "theme", scope);
    const localeState = resolveServerUiPrefState(config, "locale", scope);
    const followUpState = resolveServerUiPrefState(config, "chatFollowUpMode", scope);
    expect(themeState).toEqual({
      overridden: true,
      provenance: "device-local",
      resetValue: "claw",
      value: "knot",
    });
    expect(localeState).toEqual({
      overridden: true,
      provenance: "device-local",
      resetValue: "de",
      value: "fr",
    });
    expect(followUpState).toEqual({
      overridden: true,
      provenance: "device-local",
      resetValue: "queue",
      value: "steer",
    });

    const beforeThemeReset = loadSettings();
    const themeReset = resetServerUiPref("theme", themeState);
    expect(changedServerUiPrefs(beforeThemeReset, themeReset)).toBeNull();
    expect(themeReset.theme).toBe("claw");
    const beforeLocaleReset = loadSettings();
    const localeReset = resetServerUiPref("locale", localeState);
    expect(changedServerUiPrefs(beforeLocaleReset, localeReset)).toBeNull();
    expect(localeReset.locale).toBe("de");
    const beforeFollowUpReset = loadSettings();
    const followUpReset = resetServerUiPref("chatFollowUpMode", followUpState);
    expect(changedServerUiPrefs(beforeFollowUpReset, followUpReset)).toBeNull();
    expect(followUpReset.chatFollowUpMode).toBe("queue");
  });

  it("retains a rejected local edit until that server key actually changes", async () => {
    const scope = "ws://gw";
    const initialConfig = configWithPrefs({ theme: "claw", locale: "de" });
    const onApplied = vi.fn();
    applyServerUiPrefs(initialConfig, { scope, onApplied });
    const beforeLocalEdit = loadSettings();
    const retained = patchSettings({ theme: "knot" });
    const prefs = changedServerUiPrefs(beforeLocalEdit, retained);
    const afterCommit = vi.fn();
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => {
      throw validationError();
    });

    pushServerUiPrefs(createClient(request, scope), prefs ?? {}, { afterCommit });
    await vi.waitFor(() =>
      expect(afterCommit).toHaveBeenCalledWith({
        needsRefresh: false,
        retainedLocal: true,
      }),
    );

    expect(
      applyServerUiPrefs(configWithPrefs({ theme: "claw", locale: "de" }), { scope, onApplied }),
    ).toBe(false);
    expect(loadSettings().theme).toBe("knot");

    resetServerUiPrefsSync();
    expect(
      applyServerUiPrefs(configWithPrefs({ theme: "claw", locale: "de" }), { scope, onApplied }),
    ).toBe(false);
    expect(loadSettings().theme).toBe("knot");

    expect(
      applyServerUiPrefs(configWithPrefs({ theme: "claw", locale: "fr" }), { scope, onApplied }),
    ).toBe(true);
    expect(loadSettings()).toMatchObject({ theme: "knot", locale: "fr" });

    expect(
      applyServerUiPrefs(configWithPrefs({ theme: "dash", locale: "fr" }), { scope, onApplied }),
    ).toBe(true);
    expect(loadSettings().theme).toBe("dash");
  });

  it("sends one hash-free patch and acknowledges lastSeen plus pending", async () => {
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => ({}));
    const afterCommit = vi.fn();
    const client = createClient(request);

    pushServerUiPrefs(client, { themeMode: "dark" }, { afterCommit });
    await vi.waitFor(() => expect(afterCommit).toHaveBeenCalledOnce());
    expect(afterCommit).toHaveBeenCalledWith({ needsRefresh: false });

    expect(request).toHaveBeenCalledExactlyOnceWith("config.patch", {
      raw: JSON.stringify({ ui: { prefs: { themeMode: "dark" } } }),
      note: "control-ui prefs sync",
    });
    expect(request.mock.calls.some(([method]) => method === "config.get")).toBe(false);
    expect(localStorage.getItem(pendingKey("ws://gw"))).toBeNull();
    expect(JSON.parse(localStorage.getItem(lastSeenKey("ws://gw")) ?? "{}")).toEqual({
      themeMode: "dark",
    });
  });

  it("merges this tab's edit with sibling persisted pending keys", () => {
    const scope = "ws://gw";
    const flight = deferred();
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      () => flight.promise,
    );
    const client = createClient(request, scope);
    flushServerUiPrefs(client);
    localStorage.setItem(pendingKey(scope), JSON.stringify({ locale: "fr" }));

    pushServerUiPrefs(client, { theme: "knot" });

    expect(readPending(scope)).toEqual({ locale: "fr", theme: "knot" });
  });

  it("settles only this tab's acknowledged keys from sibling persisted pending", async () => {
    const scope = "ws://gw";
    const flight = deferred();
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      () => flight.promise,
    );
    const client = createClient(request, scope);
    flushServerUiPrefs(client);
    localStorage.setItem(pendingKey(scope), JSON.stringify({ locale: "fr" }));
    pushServerUiPrefs(client, { theme: "knot" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    flight.resolve({});

    await vi.waitFor(() => expect(readPending(scope)).toEqual({ locale: "fr" }));
  });

  it("drops only this tab's validation-rejected keys from persisted pending", async () => {
    const scope = "ws://gw";
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => {
      throw validationError();
    });
    const client = createClient(request, scope);
    flushServerUiPrefs(client);
    localStorage.setItem(pendingKey(scope), JSON.stringify({ locale: "fr" }));

    pushServerUiPrefs(client, { theme: "knot" });

    await vi.waitFor(() => expect(readPending(scope)).toEqual({ locale: "fr" }));
  });

  it("overwrites only a same-key sibling value when this tab persists later", () => {
    const scope = "ws://gw";
    const flight = deferred();
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      () => flight.promise,
    );
    const client = createClient(request, scope);
    flushServerUiPrefs(client);
    localStorage.setItem(pendingKey(scope), JSON.stringify({ locale: "fr", themeMode: "light" }));

    pushServerUiPrefs(client, { themeMode: "dark" });

    expect(readPending(scope)).toEqual({ locale: "fr", themeMode: "dark" });
  });

  it("preserves a newer same-key edit across the older batch ack", async () => {
    let resolveFirst: (() => void) | undefined;
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      () =>
        new Promise<unknown>((resolve) => {
          if (request.mock.calls.length === 1) {
            resolveFirst = () => resolve({});
          } else {
            resolve({});
          }
        }),
    );
    const client = createClient(request);

    pushServerUiPrefs(client, { themeMode: "dark" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    pushServerUiPrefs(client, { themeMode: "light" });
    resolveFirst?.();

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[1]).toEqual({
      raw: JSON.stringify({ ui: { prefs: { themeMode: "light" } } }),
      note: "control-ui prefs sync",
    });
  });

  it("retains a failed offline push and flushes it after reconnect", async () => {
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => {
      throw new Error("socket closed");
    });
    const client = createClient(request, "ws://gw", false);

    pushServerUiPrefs(client, { locale: "de" });
    expect(request).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(pendingKey("ws://gw")) ?? "{}")).toEqual({
      locale: "de",
    });

    (client.state as { connected: boolean }).connected = true;
    request.mockResolvedValue({});
    flushServerUiPrefs(client);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(localStorage.getItem(pendingKey("ws://gw"))).toBeNull());
  });

  it("retains a connected transient failure and retries it on flush", async () => {
    const request = vi
      .fn<(method: string, params?: unknown) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValueOnce({});
    const client = createClient(request);

    pushServerUiPrefs(client, { locale: "de" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(readPending("ws://gw")).toEqual({ locale: "de" });

    flushServerUiPrefs(client);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(localStorage.getItem(pendingKey("ws://gw"))).toBeNull());
  });

  it("supersedes a hung prior-connection request on same-client flush", async () => {
    let calls = 0;
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(() => {
      calls += 1;
      return calls === 1 ? new Promise<unknown>(() => {}) : Promise.resolve({});
    });
    const client = createClient(request);

    pushServerUiPrefs(client, { locale: "de" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    flushServerUiPrefs(client);

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(localStorage.getItem(pendingKey("ws://gw"))).toBeNull());
  });

  it("ignores a superseded request rejection while its replacement is pending", async () => {
    const first = deferred();
    const second = deferred();
    let calls = 0;
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(() => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    });
    const client = createClient(request);

    pushServerUiPrefs(client, { locale: "de" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    flushServerUiPrefs(client);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    first.reject(new Error("socket closed"));
    await Promise.resolve();

    expect(localStorage.getItem(pendingKey("ws://gw"))).not.toBeNull();
    second.resolve({});
    await vi.waitFor(() => expect(localStorage.getItem(pendingKey("ws://gw"))).toBeNull());
  });

  it("reconciles the refreshed snapshot again after clearing its pending shadow", async () => {
    const refreshedSnapshot = configWithPrefs({ themeMode: "light" });
    patchSettings({ themeMode: "dark" });
    const onApplied = vi.fn();
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => {
      applyServerUiPrefs(refreshedSnapshot, { scope: "ws://gw", onApplied });
      return {};
    });
    const client = createClient(request);

    pushServerUiPrefs(
      client,
      { themeMode: "dark" },
      {
        afterCommit: ({ needsRefresh }) => {
          expect(needsRefresh).toBe(false);
          applyServerUiPrefs(refreshedSnapshot, {
            scope: "ws://gw",
            onApplied,
          });
        },
      },
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(localStorage.getItem(pendingKey("ws://gw"))).toBeNull());

    expect(onApplied).toHaveBeenCalledWith({ themeMode: "light" });
    expect(loadSettings().themeMode).toBe("light");
  });

  it("requests a retry refresh when the post-mutation refresh failed", async () => {
    const afterCommit = vi.fn();
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => ({}));
    const client = createClient(request, "ws://gw", true, {
      ok: false,
      error: "config.get failed",
    });

    pushServerUiPrefs(client, { themeMode: "dark" }, { afterCommit });

    await vi.waitFor(() =>
      expect(afterCommit).toHaveBeenCalledWith({
        needsRefresh: true,
      }),
    );
  });

  it("lets pending local intent shadow only its own server key", async () => {
    let resolveRequest: (() => void) | undefined;
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      () =>
        new Promise<unknown>((resolve) => {
          resolveRequest = () => resolve({});
        }),
    );
    const client = createClient(request);
    patchSettings({ themeMode: "dark" });
    pushServerUiPrefs(client, { themeMode: "dark" });

    const onApplied = vi.fn();
    expect(
      applyServerUiPrefs(configWithPrefs({ themeMode: "light", locale: "de" }), {
        scope: "ws://gw",
        onApplied,
      }),
    ).toBe(true);
    expect(onApplied).toHaveBeenCalledWith({ locale: "de" });
    expect(loadSettings().themeMode).toBe("dark");
    resolveRequest?.();
  });

  it("does not let another scope's reconcile replace an active drain's pending state", async () => {
    let resolveRequest: (() => void) | undefined;
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      () =>
        new Promise<unknown>((resolve) => {
          resolveRequest = () => resolve({});
        }),
    );
    const client = createClient(request, "ws://a");
    localStorage.setItem(pendingKey("ws://b"), JSON.stringify({ locale: "de" }));

    pushServerUiPrefs(client, { themeMode: "dark" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    applyServerUiPrefs(configWithPrefs({ themeMode: "light", locale: "fr" }), {
      scope: "ws://b",
      onApplied: vi.fn(),
    });
    resolveRequest?.();

    await vi.waitFor(() => expect(localStorage.getItem(pendingKey("ws://a"))).toBeNull());
    expect(JSON.parse(localStorage.getItem(pendingKey("ws://b")) ?? "{}")).toEqual({
      locale: "de",
    });
  });

  it("retries one conflict then retains pending, but drops validation failures", async () => {
    vi.useFakeTimers();
    const conflictRequest = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      async () => {
        throw new Error("config changed since last load; re-run config.get and retry");
      },
    );
    pushServerUiPrefs(createClient(conflictRequest), { locale: "de" });
    await vi.advanceTimersByTimeAsync(250);
    expect(conflictRequest).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(pendingKey("ws://gw"))).not.toBeNull();

    resetServerUiPrefsSync();
    localStorage.clear();
    const validationRequest = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      async () => {
        throw validationError();
      },
    );
    pushServerUiPrefs(createClient(validationRequest), { locale: "de" });
    await vi.waitFor(() => expect(validationRequest).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(localStorage.getItem(pendingKey("ws://gw"))).toBeNull());
  });

  it("re-drains pending intent after a twice-conflicting batch", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => {
      calls += 1;
      if (calls <= 2) {
        throw new Error("config changed since last load; re-run config.get and retry");
      }
      return {};
    });

    pushServerUiPrefs(createClient(request), { locale: "de" });
    await vi.advanceTimersByTimeAsync(250);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(request).toHaveBeenCalledTimes(3);
    expect(localStorage.getItem(pendingKey("ws://gw"))).toBeNull();
  });

  it("cancels a conflict re-drain when flush or reset supersedes its epoch", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => {
      calls += 1;
      if (calls <= 2) {
        throw new Error("config changed since last load; re-run config.get and retry");
      }
      return {};
    });
    const client = createClient(request);

    pushServerUiPrefs(client, { locale: "de" });
    await vi.advanceTimersByTimeAsync(250);
    flushServerUiPrefs(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(3);

    resetServerUiPrefsSync();
    localStorage.clear();
    const conflicting = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => {
      throw new Error("config changed since last load; re-run config.get and retry");
    });
    pushServerUiPrefs(createClient(conflicting), { locale: "fr" });
    await vi.advanceTimersByTimeAsync(250);
    expect(conflicting).toHaveBeenCalledTimes(2);
    resetServerUiPrefsSync();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(conflicting).toHaveBeenCalledTimes(2);
  });

  it("caps conflict-triggered re-drains at five", async () => {
    vi.useFakeTimers();
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => {
      throw new Error("config changed since last load; re-run config.get and retry");
    });

    pushServerUiPrefs(createClient(request), { locale: "de" });
    for (let round = 0; round <= 5; round += 1) {
      await vi.advanceTimersByTimeAsync(250);
      expect(request).toHaveBeenCalledTimes((round + 1) * 2);
      if (round < 5) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
    }
    await vi.advanceTimersByTimeAsync(5_000);

    expect(request).toHaveBeenCalledTimes(12);
    expect(localStorage.getItem(pendingKey("ws://gw"))).not.toBeNull();
  });

  it("marks sidebar arrays for replacement", async () => {
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => ({}));
    const sidebarEntries = ["route:usage"];

    pushServerUiPrefs(createClient(request), { sidebarEntries });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    expect(request).toHaveBeenCalledWith("config.patch", {
      raw: JSON.stringify({ ui: { prefs: { sidebarEntries } } }),
      replacePaths: ["ui.prefs.sidebarEntries"],
      note: "control-ui prefs sync",
    });
  });

  it("persists pending per scope and reloads only the adopted scope", async () => {
    const offlineRequest = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      async () => {
        throw new Error("offline");
      },
    );
    pushServerUiPrefs(createClient(offlineRequest, "ws://a", false), { themeMode: "dark" });
    expect(offlineRequest).not.toHaveBeenCalled();
    pushServerUiPrefs(createClient(offlineRequest, "ws://b", false), { locale: "de" });
    expect(offlineRequest).not.toHaveBeenCalled();

    expect(JSON.parse(localStorage.getItem(pendingKey("ws://a")) ?? "{}")).toEqual({
      themeMode: "dark",
    });
    expect(JSON.parse(localStorage.getItem(pendingKey("ws://b")) ?? "{}")).toEqual({
      locale: "de",
    });

    resetServerUiPrefsSync();
    const replayRequest = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(
      async () => ({}),
    );
    flushServerUiPrefs(createClient(replayRequest, "ws://b"));
    await vi.waitFor(() => expect(replayRequest).toHaveBeenCalledOnce());
    expect(replayRequest.mock.calls[0]?.[1]).toMatchObject({
      raw: JSON.stringify({ ui: { prefs: { locale: "de" } } }),
    });
    expect(localStorage.getItem(pendingKey("ws://a"))).not.toBeNull();
  });

  it("retains pending intent per scope when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage blocked");
      },
      removeItem: () => {
        throw new Error("storage blocked");
      },
      setItem: () => {
        throw new Error("storage blocked");
      },
    });
    const writerA = createClient(vi.fn(), "ws://gateway.test?tenant=a", false);
    const writerB = createClient(vi.fn(), "ws://gateway.test?tenant=b", false);
    pushServerUiPrefs(writerA, { theme: "knot" });
    pushServerUiPrefs(writerB, { theme: "dash" });

    expect(
      resolveServerUiPrefState(
        configWithPrefs({ theme: "claw" }),
        "theme",
        "ws://gateway.test?tenant=a",
      ),
    ).toMatchObject({ provenance: "pending", value: "knot" });
    expect(
      resolveServerUiPrefState(
        configWithPrefs({ theme: "claw" }),
        "theme",
        "ws://gateway.test?tenant=b",
      ),
    ).toMatchObject({ provenance: "pending", value: "dash" });

    const onThemeChanged = vi.fn();
    applyServerUiPrefs(configWithPrefs({ theme: "claw" }), {
      scope: "ws://gateway.test?tenant=a",
      onApplied: vi.fn(),
      onThemeChanged,
    });
    expect(onThemeChanged).not.toHaveBeenCalled();
  });

  it("re-adopts scope when a stable writer gains or changes its gateway client", async () => {
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => ({}));
    const writer = createClient(request, "", false);
    (writer.state as { client: GatewayBrowserClient | null }).client = null;

    pushServerUiPrefs(writer, { locale: "de" });
    expect(JSON.parse(localStorage.getItem(pendingKey("")) ?? "{}")).toEqual({ locale: "de" });

    const firstClient = {
      request,
      gatewayUrl: "ws://first",
      connected: true,
    } as unknown as GatewayBrowserClient;
    (writer.state as { client: GatewayBrowserClient | null; connected: boolean }).client =
      firstClient;
    (writer.state as { connected: boolean }).connected = true;
    flushServerUiPrefs(writer);
    await vi.waitFor(() => expect(localStorage.getItem(pendingKey("ws://first"))).toBeNull());
    expect(localStorage.getItem(pendingKey(""))).toBeNull();

    localStorage.setItem(pendingKey("ws://second"), JSON.stringify({ themeMode: "dark" }));
    const secondClient = {
      request,
      gatewayUrl: "ws://second",
      connected: true,
    } as unknown as GatewayBrowserClient;
    (writer.state as { client: GatewayBrowserClient | null }).client = secondClient;
    flushServerUiPrefs(writer);

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      raw: JSON.stringify({ ui: { prefs: { themeMode: "dark" } } }),
    });
  });

  it("recovers persisted pre-connection intent when the first gateway is adopted", async () => {
    localStorage.setItem(pendingKey(""), JSON.stringify({ locale: "de" }));
    const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => ({}));

    flushServerUiPrefs(createClient(request, "ws://first"));

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      raw: JSON.stringify({ ui: { prefs: { locale: "de" } } }),
    });
    await vi.waitFor(() => expect(localStorage.getItem(pendingKey("ws://first"))).toBeNull());
    expect(localStorage.getItem(pendingKey(""))).toBeNull();
  });
});
