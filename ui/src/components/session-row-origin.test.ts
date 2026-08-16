import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { renderSessionLeadingIdentity, renderSessionRowMarkers } from "./session-row-origin.ts";

afterEach(() => {
  document.body.replaceChildren();
});

function mount(value: ReturnType<typeof renderSessionLeadingIdentity>) {
  const container = document.createElement("div");
  document.body.append(container);
  render(value, container);
  return container;
}

describe("session row identity state", () => {
  it("overlays incognito on a creator without repeating it in the title", () => {
    const container = mount(
      renderSessionLeadingIdentity({
        owner: html`<span data-owner>M</span>`,
        incognito: true,
      }),
    );

    expect(container.querySelector("[data-owner]")).not.toBeNull();
    expect(container.querySelector(".session-row-state-badge--incognito")).not.toBeNull();
    expect(renderSessionRowMarkers({ draft: false })).toBe(nothing);
  });

  it("uses incognito as the leading identity when no creator exists", () => {
    const container = mount(renderSessionLeadingIdentity({ owner: nothing, incognito: true }));

    expect(container.querySelector(".session-row-state-avatar--incognito")).not.toBeNull();
    expect(container.querySelector(".session-row-state-badge--incognito")).toBeNull();
  });
});
