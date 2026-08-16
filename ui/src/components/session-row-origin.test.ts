import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { renderSessionLeadingIdentity } from "./session-row-origin.ts";

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
        draft: false,
      }),
    );

    expect(container.querySelector("[data-owner]")).not.toBeNull();
    expect(container.querySelector(".session-row-state-badge--incognito")).not.toBeNull();
  });

  it("uses incognito as the leading identity when no creator exists", () => {
    const container = mount(
      renderSessionLeadingIdentity({ owner: nothing, incognito: true, draft: false }),
    );

    expect(container.querySelector(".session-row-state-avatar--incognito")).not.toBeNull();
    expect(container.querySelector(".session-row-state-badge--incognito")).toBeNull();
  });

  it("overlays draft on a creator and uses it as the fallback identity", () => {
    const withOwner = mount(
      renderSessionLeadingIdentity({
        owner: html`<span data-owner>M</span>`,
        incognito: false,
        draft: true,
      }),
    );
    const withoutOwner = mount(
      renderSessionLeadingIdentity({ owner: nothing, incognito: false, draft: true }),
    );

    expect(withOwner.querySelector(".session-row-state-badge--draft")).not.toBeNull();
    expect(withoutOwner.querySelector(".session-row-state-avatar--draft")).not.toBeNull();
  });

  it("keeps both state glyphs when an identity-less row is incognito and draft", () => {
    const container = mount(
      renderSessionLeadingIdentity({ owner: nothing, incognito: true, draft: true }),
    );

    expect(container.querySelector(".session-row-state-avatar--incognito")).not.toBeNull();
    expect(container.querySelector(".session-row-state-badge--draft")).not.toBeNull();
  });
});
