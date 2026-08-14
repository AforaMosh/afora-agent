/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadStoredCollapsedSessionSections,
  loadStoredHiddenSessionCatalogIds,
  loadStoredSidebarSessionStatusFilter,
  setStoredSessionCatalogHidden,
  storeSidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";

const COLLAPSED_SECTIONS_STORAGE_KEY = "openclaw:sidebar:sessions:collapsed-sections";

// getSafeLocalStorage only accepts an own value property under Vitest, so the
// jsdom getter-backed localStorage must be replaced with a plain mock.
let originalLocalStorage: PropertyDescriptor | undefined;

function createStorageMock(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

beforeEach(() => {
  originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: createStorageMock(),
  });
});

afterEach(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

describe("sidebar session status preference", () => {
  it("defaults unknown stored values to active", () => {
    expect(loadStoredSidebarSessionStatusFilter()).toBe("active");
    localStorage.setItem("openclaw:sidebar:sessions:status-filter", "unexpected");
    expect(loadStoredSidebarSessionStatusFilter()).toBe("active");
  });

  it("stores archived and all filters", () => {
    storeSidebarSessionStatusFilter("archived");
    expect(loadStoredSidebarSessionStatusFilter()).toBe("archived");
    storeSidebarSessionStatusFilter("all");
    expect(loadStoredSidebarSessionStatusFilter()).toBe("all");
  });
});

describe("collapsed sidebar section preference", () => {
  it("defaults fresh Channels closed without changing a legacy saved preference", () => {
    expect([...loadStoredCollapsedSessionSections()]).toEqual(["channels", "work"]);

    localStorage.setItem(
      COLLAPSED_SECTIONS_STORAGE_KEY,
      JSON.stringify(["category:Research", "work"]),
    );
    expect([...loadStoredCollapsedSessionSections()]).toEqual(["category:Research", "work"]);
  });
});

describe("hidden session catalog preference", () => {
  it("round-trips catalog ids and reverses one hide at a time", () => {
    setStoredSessionCatalogHidden("codex", true);
    setStoredSessionCatalogHidden("claude", true);
    expect([...loadStoredHiddenSessionCatalogIds()]).toEqual(["codex", "claude"]);

    setStoredSessionCatalogHidden("codex", false);
    expect([...loadStoredHiddenSessionCatalogIds()]).toEqual(["claude"]);
  });

  it.each(["not-json", JSON.stringify({ catalog: "codex" })])(
    "treats malformed storage as empty: %s",
    (stored) => {
      localStorage.setItem("openclaw:sidebar:sessions:hidden-catalogs", stored);
      expect(loadStoredHiddenSessionCatalogIds().size).toBe(0);
    },
  );
});
