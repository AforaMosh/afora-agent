import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createOverflowFadeRef } from "../../lib/overflow-fade.ts";
import {
  createGateway,
  createSessions,
  createSessionsHarness,
  mountSidebar,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

async function mountWithRows(rows: GatewaySessionRow[]) {
  const harness = createSessionsHarness("main", [rows[0]?.key ?? "agent:main:only"]);
  const { sidebar } = await mountSidebar(
    createGateway({} as GatewayBrowserClient),
    harness.sessions,
  );
  harness.publishList({
    result: {
      ts: 2,
      path: "",
      count: rows.length,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: rows,
    } satisfies SessionsListResult,
  });
  await sidebar.updateComplete;
  return sidebar;
}

function rowFor(sidebar: Element, key: string): HTMLElement {
  const row = sidebar.querySelector<HTMLElement>(`[data-session-key="${key}"]`);
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

describe("AppSidebar session management reveal", () => {
  it("ends every row with the endcap so state keeps one trailing rail", async () => {
    const sidebar = await mountWithRows([
      {
        key: "agent:main:parent",
        kind: "direct",
        label: "Plan release",
        updatedAt: 2,
        childSessions: ["agent:main:child"],
      },
      { key: "agent:main:solo", kind: "direct", label: "Ship release", updatedAt: 1 },
    ]);

    // The endcap holds the trailing edge by being last, not by any rule that
    // pins it, so the disclosure button has to precede it. Rendered after, it
    // pushes a parent's state inboard while childless rows keep the real edge --
    // the two rails an operator reads as a misaligned spinner.
    for (const key of ["agent:main:parent", "agent:main:solo"]) {
      const order = [...rowFor(sidebar, key).children].map(
        (child) => child.className.split(" ")[0],
      );
      expect(order.indexOf("session-row-endcap")).toBe(order.length - 1);
      expect(order.indexOf("session-row-endcap")).toBeGreaterThan(
        order.indexOf("sidebar-recent-session__link"),
      );
    }
  });

  it("holds the management layer revealed while the row menu is open", async () => {
    const sidebar = await mountWithRows([
      { key: "agent:main:one", kind: "direct", label: "One", updatedAt: 2 },
      { key: "agent:main:two", kind: "direct", label: "Two", updatedAt: 1 },
    ]);
    const row = rowFor(sidebar, "agent:main:one");
    expect(row.classList.contains("session-row-host--menu-open")).toBe(false);

    row.querySelector<HTMLButtonElement>("[data-session-menu]")?.click();
    await sidebar.updateComplete;

    expect(rowFor(sidebar, "agent:main:one").classList).toContain("session-row-host--menu-open");
    expect(rowFor(sidebar, "agent:main:two").classList).not.toContain(
      "session-row-host--menu-open",
    );
  });

  it("marks clipped text without owning row-action geometry", () => {
    const name = document.createElement("span");
    name.className = "sidebar-recent-session__name";
    const content = document.createElement("span");
    content.className = "sidebar-recent-session__name-content";
    Object.defineProperty(name, "clientWidth", { configurable: true, value: 120 });
    Object.defineProperty(content, "scrollWidth", { configurable: true, value: 180 });
    name.append(content);
    document.body.append(name);
    try {
      createOverflowFadeRef()(name);
      expect(name.hasAttribute("data-overflow-fade")).toBe(true);
      expect(name.hasAttribute("data-overflow-reveal")).toBe(false);
    } finally {
      name.remove();
    }
  });

  it("marks top-level rows as manageable without pointer-driven measurement", async () => {
    const sidebar = await mountWithRows([
      { key: "agent:main:one", kind: "direct", label: "One", updatedAt: 2 },
    ]);
    const row = rowFor(sidebar, "agent:main:one");
    expect(row.dataset.sessionManageable).toBe("true");
    expect(row.querySelector(".sidebar-recent-session__name-content")).not.toBeNull();
    expect(row.querySelector(".session-row-endcap__management")).not.toBeNull();
  });

  it("gives catalog rows the same measured-reveal structure", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    sidebar.sessionData.sessionCatalogs = [
      {
        id: "codex",
        label: "Codex",
        capabilities: { continueSession: true, archive: true },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local Codex",
            kind: "gateway",
            connected: true,
            sessions: [
              {
                threadId: "idle-thread",
                name: "Idle session",
                cwd: "/work/openclaw",
                status: "idle",
                archived: false,
                canContinue: true,
                canArchive: true,
              },
            ],
          },
        ],
      },
    ];
    sidebar.sessionData.requestSessionDataUpdate();
    await sidebar.updateComplete;

    const row = sidebar.querySelector<HTMLElement>('[data-session-key*="idle-thread"]');
    expect(row?.querySelector(".session-row-actions")).not.toBeNull();
    expect(row?.dataset.sessionManageable).toBe("true");
    expect(row?.querySelector(".sidebar-recent-session__name-content")).not.toBeNull();
  });
});
