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
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("preserves authored provenance when a server value equals the product default", () => {
    const config = configWithPrefs({
      theme: "claw",
      themeMode: "system",
      chatSendShortcut: "enter",
    });

    expect(resolveServerUiPrefState(config, "theme")).toEqual({
      overridden: true,
      provenance: "synced",
      resetValue: "claw",
      value: "claw",
    });
    expect(resolveServerUiPrefState(config, "themeMode")).toEqual({
      overridden: true,
      provenance: "synced",
      resetValue: "system",
      value: "system",
    });
    expect(resolveServerUiPrefState(config, "chatSendShortcut")).toEqual({
      overridden: true,
      provenance: "synced",
      resetValue: "enter",
      value: "enter",
    });
  });

  it("preserves a server custom-theme override when this device lacks its palette", () => {
    const state = resolveServerUiPrefState(configWithPrefs({ theme: "custom" }), "theme");

    expect(state).toEqual({
      overridden: true,
      provenance: "synced",
      resetValue: "claw",
      value: "claw",
    });

    const beforeReset = loadSettings();
    const afterReset = resetServerUiPref("theme", state);
    expect(changedServerUiPrefs(beforeReset, afterReset)).toEqual({ theme: null });
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

  it("does not reapply a retained pre-commit snapshot after an ack moves lastSeen", async () => {
    const scope = "ws://gw";
    const oldSnapshot = configWithPrefs({ themeMode: "light" });
    const onApplied = vi.fn();
    applyServerUiPrefs(oldSnapshot, { scope, onApplied });
    patchSettings({ themeMode: "dark" });
    const request = vi.fn(async () => ({}));
    const client = createServerPrefsWriter(request, scope);

    pushServerUiPrefs(client, { themeMode: "dark" });
    await vi.waitFor(() =>
      expect(localStorage.getItem(`openclaw.control.serverPrefs.pending.v1:${scope}`)).toBeNull(),
    );

    expect(applyServerUiPrefs(oldSnapshot, { scope, onApplied })).toBe(false);
    expect(loadSettings().themeMode).toBe("dark");
  });

  it("treats a new object with old content after ack as a genuine LWW restore", async () => {
    const scope = "ws://gw";
    const oldSnapshot = configWithPrefs({ themeMode: "light" });
    const onApplied = vi.fn();
    applyServerUiPrefs(oldSnapshot, { scope, onApplied });
    patchSettings({ themeMode: "dark" });
    const request = vi.fn(async () => ({}));
    const client = createServerPrefsWriter(request, scope);
    pushServerUiPrefs(client, { themeMode: "dark" });
    await vi.waitFor(() =>
      expect(localStorage.getItem(`openclaw.control.serverPrefs.pending.v1:${scope}`)).toBeNull(),
    );

    // A new post-bump snapshot object represents a genuine foreign restore and is LWW-correct.
    expect(applyServerUiPrefs(configWithPrefs({ themeMode: "light" }), { scope, onApplied })).toBe(
      true,
    );
    expect(loadSettings().themeMode).toBe("light");
  });

  it("clears the retained-object memo on reset", () => {
    const scope = "ws://memo";
    const snapshot = configWithPrefs({ themeMode: "dark" });
    const onApplied = vi.fn();
    expect(applyServerUiPrefs(snapshot, { scope, onApplied })).toBe(true);
    patchSettings({ themeMode: "light" });
    localStorage.setItem(
      `openclaw.control.serverPrefs.v1:${scope}`,
      JSON.stringify({ themeMode: "light" }),
    );
    expect(applyServerUiPrefs(snapshot, { scope, onApplied })).toBe(false);

    resetServerUiPrefsSync();

    expect(applyServerUiPrefs(snapshot, { scope, onApplied })).toBe(true);
    expect(loadSettings().themeMode).toBe("dark");
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

  it("ignores a server custom theme until this browser imported one", () => {
    const onApplied = vi.fn();
    const onThemeChanged = vi.fn();
    expect(
      applyServerUiPrefs(configWithPrefs({ theme: "custom" }), { onApplied, onThemeChanged }),
    ).toBe(false);
    expect(loadSettings().theme).toBe("claw");
    expect(onThemeChanged).toHaveBeenLastCalledWith("custom");

    expect(
      applyServerUiPrefs(configWithPrefs({ theme: "claw" }), { onApplied, onThemeChanged }),
    ).toBe(false);
    expect(onThemeChanged).toHaveBeenLastCalledWith("claw");
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("does not republish an equal theme when preference storage is unavailable", () => {
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
    const onApplied = vi.fn();
    const onThemeChanged = vi.fn();

    applyServerUiPrefs(configWithPrefs({ theme: "custom" }), { onApplied, onThemeChanged });
    applyServerUiPrefs(configWithPrefs({ theme: "custom" }), { onApplied, onThemeChanged });

    expect(onThemeChanged).toHaveBeenCalledExactlyOnceWith("custom");
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("prefers the process baseline when storage stays readable but cannot be updated", () => {
    const storage = createStorageMock();
    storage.setItem("openclaw.control.serverPrefs.v1:ws://gw", JSON.stringify({ theme: "claw" }));
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("storage read-only");
    });
    vi.stubGlobal("localStorage", storage);
    const onApplied = vi.fn();
    const onThemeChanged = vi.fn();

    applyServerUiPrefs(configWithPrefs({ theme: "custom" }), {
      scope: "ws://gw",
      onApplied,
      onThemeChanged,
    });
    applyServerUiPrefs(configWithPrefs({ theme: "custom" }), {
      scope: "ws://gw",
      onApplied,
      onThemeChanged,
    });

    expect(onThemeChanged).toHaveBeenCalledExactlyOnceWith("custom");
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("treats equivalent Gateway URL spellings as one preference scope", () => {
    const onApplied = vi.fn();
    const onThemeChanged = vi.fn();
    applyServerUiPrefs(configWithPrefs({ theme: "custom" }), {
      scope: "ws://gw",
      onApplied,
      onThemeChanged,
    });
    onThemeChanged.mockClear();

    applyServerUiPrefs(configWithPrefs({ theme: "custom" }), {
      scope: "ws://gw/",
      onApplied,
      onThemeChanged,
    });

    expect(onThemeChanged).not.toHaveBeenCalled();
  });

  it("keeps query-routed Gateways in distinct preference scopes", () => {
    const onThemeChanged = vi.fn();
    applyServerUiPrefs(configWithPrefs({ theme: "custom" }), {
      scope: "ws://gw?tenant=a",
      onApplied: vi.fn(),
      onThemeChanged,
    });
    onThemeChanged.mockClear();

    applyServerUiPrefs(configWithPrefs({ theme: "custom" }), {
      scope: "ws://gw?tenant=b",
      onApplied: vi.fn(),
      onThemeChanged,
    });

    expect(onThemeChanged).toHaveBeenCalledExactlyOnceWith("custom");
  });

  it("migrates raw legacy scope keys before reconciliation", () => {
    const legacyScope = "WS://GW:80/a/../";
    localStorage.setItem(
      `openclaw.control.serverPrefs.pending.v1:${legacyScope}`,
      JSON.stringify({ theme: "knot" }),
    );
    localStorage.setItem(
      `openclaw.control.serverPrefs.v1:${legacyScope}`,
      JSON.stringify({ theme: "claw" }),
    );

    expect(
      resolveServerUiPrefState(configWithPrefs({ theme: "claw" }), "theme", "ws://gw"),
    ).toMatchObject({ provenance: "pending", value: "knot" });
    expect(localStorage.getItem("openclaw.control.serverPrefs.pending.v1:ws://gw")).toBe(
      JSON.stringify({ theme: "knot" }),
    );
    expect(localStorage.getItem("openclaw.control.serverPrefs.v1:ws://gw")).toBe(
      JSON.stringify({ theme: "claw" }),
    );
    expect(
      localStorage.getItem(`openclaw.control.serverPrefs.pending.v1:${legacyScope}`),
    ).toBeNull();
    expect(localStorage.getItem(`openclaw.control.serverPrefs.v1:${legacyScope}`)).toBeNull();
  });

  it("retains migrated pending intent when canonical storage writes fail", () => {
    const storage = createStorageMock();
    storage.setItem(
      "openclaw.control.serverPrefs.pending.v1:ws://readonly/",
      JSON.stringify({ theme: "dash" }),
    );
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("storage read-only");
    });
    vi.stubGlobal("localStorage", storage);

    expect(
      resolveServerUiPrefState(configWithPrefs({ theme: "claw" }), "theme", "ws://readonly"),
    ).toMatchObject({ provenance: "pending", value: "dash" });
    expect(
      sessionStorage.getItem("openclaw.control.serverPrefs.pending-migrated.v1:ws://readonly/"),
    ).toBeNull();

    resetServerUiPrefsSync();
    expect(
      resolveServerUiPrefState(configWithPrefs({ theme: "claw" }), "theme", "ws://readonly"),
    ).toMatchObject({ provenance: "pending", value: "dash" });
  });

  it("does not resurrect a read-only legacy pending record after acknowledgement", async () => {
    const storage = createStorageMock();
    storage.setItem(
      "openclaw.control.serverPrefs.pending.v1:ws://readonly-ack/",
      JSON.stringify({ theme: "knot" }),
    );
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("storage read-only");
    });
    vi.stubGlobal("localStorage", storage);
    expect(
      resolveServerUiPrefState(configWithPrefs({ theme: "claw" }), "theme", "ws://readonly-ack"),
    ).toMatchObject({ provenance: "pending", value: "knot" });
    const afterCommit = vi.fn();
    flushServerUiPrefs(
      createServerPrefsWriter(
        vi.fn(async () => ({})),
        "ws://readonly-ack",
      ),
      { afterCommit },
    );
    await vi.waitFor(() => expect(afterCommit).toHaveBeenCalledOnce());
    resetServerUiPrefsSync({ preserveScopedFallback: true });

    expect(
      resolveServerUiPrefState(configWithPrefs({ theme: "claw" }), "theme", "ws://readonly-ack")
        .provenance,
    ).not.toBe("pending");
  });
});

describe("changedServerUiPrefs", () => {
  it("returns only the synced keys that changed", () => {
    const previous = loadSettings();
    const next = { ...previous, themeMode: "dark" as const, navCollapsed: !previous.navCollapsed };
    expect(changedServerUiPrefs(previous, next)).toEqual({ themeMode: "dark" });
    expect(changedServerUiPrefs(previous, { ...previous })).toBeNull();
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

  it("does not sync browser-local presentation preferences", () => {
    const previous = loadSettings();
    expect(
      changedServerUiPrefs(previous, {
        ...previous,
        textScale: 125,
        sidebarLiveActivity: false,
        chatMessageMaxWidth: "82%",
        showAdvancedSettings: true,
      }),
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

  it("pushes an explicit locale removal when returning to System", () => {
    const previous = loadSettings();
    const explicit = { ...previous, locale: "de" };

    expect(changedServerUiPrefs(previous, explicit)).toEqual({ locale: "de" });
    expect(changedServerUiPrefs(explicit, { ...explicit, locale: undefined })).toEqual({
      locale: null,
    });
  });

  it("pushes null when resetting authored synced values already equal to defaults", () => {
    const previous = loadSettings();

    const theme = resetServerUiPref("theme");
    expect(changedServerUiPrefs(previous, theme)).toEqual({ theme: null });
    const themeMode = resetServerUiPref("themeMode");
    expect(changedServerUiPrefs(theme, themeMode)).toEqual({ themeMode: null });
    const shortcut = resetServerUiPref("chatSendShortcut");
    expect(changedServerUiPrefs(themeMode, shortcut)).toEqual({
      chatSendShortcut: null,
    });
  });

  it("syncs an authored default-valued reset through the settings listener", async () => {
    const scope = "ws://gw";
    const request = vi.fn(async () => ({}));
    const writer = createServerPrefsWriter(request, scope);
    setSettingsChangeListener((previous, next) => {
      const prefs = changedServerUiPrefs(previous, next);
      if (prefs) {
        pushServerUiPrefs(writer, prefs);
      }
    });

    const state = resolveServerUiPrefState(configWithPrefs({ theme: "claw" }), "theme", scope);
    resetServerUiPref("theme", state);

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "config.patch",
        expect.objectContaining({
          raw: JSON.stringify({ ui: { prefs: { theme: null } } }),
        }),
      ),
    );
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

  it("clears the local locale override when the server removes it", () => {
    const onApplied = vi.fn();
    applyServerUiPrefs(configWithPrefs({ locale: "de" }), { onApplied });
    expect(loadSettings().locale).toBe("de");

    expect(applyServerUiPrefs(configWithPrefs({}), { onApplied })).toBe(true);
    expect(loadSettings().locale).toBeUndefined();
    expect(onApplied).toHaveBeenLastCalledWith({ locale: undefined });
  });

  it("restores product defaults when authored synced values are removed", () => {
    const onApplied = vi.fn();
    applyServerUiPrefs(
      configWithPrefs({
        theme: "knot",
        themeMode: "dark",
        chatSendShortcut: "modifier-enter",
      }),
      { onApplied },
    );

    expect(applyServerUiPrefs(configWithPrefs({}), { onApplied })).toBe(true);
    const reset = loadSettings();
    expect(reset).toMatchObject({
      theme: "claw",
      themeMode: "system",
    });
    expect(reset.chatSendShortcut).toBe("enter");
    const persisted = JSON.parse(
      localStorage.getItem(`openclaw.control.settings.v1:${reset.gatewayUrl}`) ?? "{}",
    ) as Record<string, unknown>;
    expect(Object.hasOwn(persisted, "chatSendShortcut")).toBe(false);
  });
});
