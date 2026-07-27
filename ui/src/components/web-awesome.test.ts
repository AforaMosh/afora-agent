/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeDropdownKeyboardDismissal,
  syncDropdownItemRadio,
  trackDropdownKeyboardDismissal,
} from "./web-awesome.ts";

type DropdownElement = HTMLElement & { readonly updateComplete: Promise<unknown> };

async function createDropdown(label?: string) {
  const dropdown = document.createElement("wa-dropdown") as DropdownElement;
  if (label) {
    dropdown.setAttribute("aria-label", label);
  }
  const trigger = document.createElement("button");
  trigger.slot = "trigger";
  trigger.textContent = "Actions";
  const item = document.createElement("wa-dropdown-item");
  item.textContent = "Open";
  dropdown.append(trigger, item);
  document.body.append(dropdown);
  await dropdown.updateComplete;
  dropdown.dispatchEvent(new CustomEvent("wa-show", { bubbles: true, composed: true }));
  return { dropdown, trigger };
}

afterEach(() => document.body.replaceChildren());

describe("Web Awesome adapters", () => {
  it("copies an explicit dropdown label to the menu", async () => {
    const { dropdown } = await createDropdown("Message actions");

    expect(dropdown.shadowRoot?.querySelector('[part="menu"]')?.getAttribute("aria-label")).toBe(
      "Message actions",
    );

    dropdown.setAttribute("aria-label", "Updated actions");
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(dropdown.shadowRoot?.querySelector('[part="menu"]')?.getAttribute("aria-label")).toBe(
      "Updated actions",
    );
  });

  it("labels a dropdown menu from its trigger", async () => {
    const { dropdown } = await createDropdown();

    expect(dropdown.shadowRoot?.querySelector('[part="menu"]')?.getAttribute("aria-label")).toBe(
      "Actions",
    );
  });

  it("restores a durable trigger only after keyboard dismissal", async () => {
    const { dropdown } = await createDropdown();
    dropdown.addEventListener("keydown", trackDropdownKeyboardDismissal);

    expect(consumeDropdownKeyboardDismissal(new CustomEvent("wa-after-hide"))).toBe(false);

    dropdown.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    let restoreFocus = false;
    dropdown.addEventListener("wa-after-hide", (event) => {
      restoreFocus = consumeDropdownKeyboardDismissal(event);
    });
    dropdown.dispatchEvent(new CustomEvent("wa-after-hide"));
    expect(restoreFocus).toBe(true);
  });

  it("consumes a keyboard dismissal exactly once", async () => {
    const { dropdown } = await createDropdown();
    dropdown.addEventListener("keydown", trackDropdownKeyboardDismissal);
    const restorations: boolean[] = [];
    dropdown.addEventListener("wa-after-hide", (event) => {
      restorations.push(consumeDropdownKeyboardDismissal(event));
    });

    dropdown.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    dropdown.dispatchEvent(new CustomEvent("wa-after-hide"));
    dropdown.dispatchEvent(new CustomEvent("wa-after-hide"));

    expect(restorations).toEqual([true, false]);
  });

  it("does not restore a durable trigger for ordinary keyboard navigation", async () => {
    const { dropdown } = await createDropdown();
    dropdown.addEventListener("keydown", trackDropdownKeyboardDismissal);
    const restoreFocus = vi.fn();
    dropdown.addEventListener("wa-after-hide", (event) => {
      if (consumeDropdownKeyboardDismissal(event)) {
        restoreFocus();
      }
    });

    dropdown.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    dropdown.dispatchEvent(new CustomEvent("wa-after-hide"));

    expect(restoreFocus).not.toHaveBeenCalled();
  });

  it("restores the durable trigger before native Tab navigation", async () => {
    const durableTrigger = document.createElement("button");
    document.body.append(durableTrigger);
    const { dropdown } = await createDropdown();
    dropdown.addEventListener("keydown", (event) =>
      trackDropdownKeyboardDismissal(event, () => durableTrigger.focus()),
    );

    dropdown.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));

    expect(document.activeElement).toBe(durableTrigger);
  });

  it("restores radio semantics after a dropdown item updates", async () => {
    const item = document.createElement("wa-dropdown-item") as DropdownElement;
    item.setAttribute("type", "normal");
    document.body.append(item);

    syncDropdownItemRadio(item, true);
    await item.updateComplete;
    await Promise.resolve();

    expect(item.getAttribute("role")).toBe("menuitemradio");
    expect(item.getAttribute("aria-checked")).toBe("true");
  });

  it("does not apply radio semantics to unrelated or disconnected elements", async () => {
    const unrelated = document.createElement("button");
    syncDropdownItemRadio(unrelated, true);

    const disconnected = document.createElement("wa-dropdown-item") as DropdownElement;
    document.body.append(disconnected);
    syncDropdownItemRadio(disconnected, true);
    disconnected.remove();
    await disconnected.updateComplete;
    await Promise.resolve();

    expect(unrelated.hasAttribute("aria-checked")).toBe(false);
    expect(disconnected.getAttribute("role")).not.toBe("menuitemradio");
  });
});
