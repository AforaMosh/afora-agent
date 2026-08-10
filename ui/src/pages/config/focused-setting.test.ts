/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  buildFocusedSettingPatch,
  focusedSettingValue,
  parseFocusedSettingLookup,
  renderFocusedSetting,
} from "./focused-setting.ts";

const path = "plugins.entries.codex.config.supervision.enabled";
const lookupResponse = {
  path,
  schema: { type: "boolean", default: false },
  reloadKind: "hot",
  hint: {
    label: "Enable Codex Supervision",
    help: "Enable continuation of local native Codex sessions in Chat.",
  },
  children: [],
};

describe("focused setting", () => {
  it("accepts an exact boolean schema lookup and rejects broader schemas", () => {
    expect(parseFocusedSettingLookup(lookupResponse, path)).toMatchObject({
      path,
      schema: { type: "boolean", default: false },
      reloadKind: "hot",
    });
    expect(
      parseFocusedSettingLookup({ ...lookupResponse, schema: { type: "object" } }, path),
    ).toBeNull();
    expect(parseFocusedSettingLookup(lookupResponse, `${path}.other`)).toBeNull();
  });

  it("reads the exact value and builds a leaf-only patch", () => {
    const config = {
      plugins: { entries: { codex: { config: { supervision: { enabled: false } } } } },
    };
    expect(focusedSettingValue(config, path)).toBe(false);
    expect(buildFocusedSettingPatch(path, true)).toEqual({
      plugins: { entries: { codex: { config: { supervision: { enabled: true } } } } },
    });
    expect(buildFocusedSettingPatch("plugins.__proto__.enabled", true)).toBeNull();
  });

  it("renders only the looked-up toggle and dispatches its boolean change", () => {
    const onChange = vi.fn();
    const container = document.createElement("div");
    render(
      renderFocusedSetting({
        path,
        state: { phase: "ready", lookup: parseFocusedSettingLookup(lookupResponse, path)! },
        config: {},
        pendingValue: null,
        saving: false,
        saved: false,
        saveError: null,
        canEdit: true,
        onChange,
      }),
      container,
    );

    expect(container.textContent).toContain("Enable Codex Supervision");
    expect(container.textContent).toContain("Changes apply without restarting the Gateway.");
    expect(container.querySelectorAll("wa-switch")).toHaveLength(1);
    const toggle = container.querySelector<HTMLElement & { checked: boolean }>("wa-switch")!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("renders the setting read-only without administrator access", () => {
    const container = document.createElement("div");
    render(
      renderFocusedSetting({
        path,
        state: { phase: "ready", lookup: parseFocusedSettingLookup(lookupResponse, path)! },
        config: {},
        pendingValue: null,
        saving: false,
        saved: false,
        saveError: null,
        canEdit: false,
        onChange: vi.fn(),
      }),
      container,
    );
    expect(container.querySelector("wa-switch")?.hasAttribute("disabled")).toBe(true);
    expect(container.textContent).toContain("Operator administrator access is required");
  });

  it("fails closed for unsupported focused schemas", () => {
    const container = document.createElement("div");
    render(
      renderFocusedSetting({
        path,
        state: { phase: "error", message: "Unsupported focused setting" },
        config: {},
        pendingValue: null,
        saving: false,
        saved: false,
        saveError: null,
        canEdit: false,
        onChange: vi.fn(),
      }),
      container,
    );
    expect(container.querySelector("wa-switch")).toBeNull();
    expect(container.textContent).toContain("Unsupported focused setting");
  });
});
