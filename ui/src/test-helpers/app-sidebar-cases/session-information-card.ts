import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { SESSION_CARD_COLD_DELAY_MS } from "../../components/session-row-hover-card.ts";
import { createGateway, createSessionsHarness, mountSidebar } from "../app-sidebar.ts";
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

describe("AppSidebar session information card", () => {
  it("wraps a session row in a deliberate right-side card", async () => {
    const sidebar = await mountWithRows([
      {
        key: "agent:main:work",
        kind: "direct",
        label: "Work",
        updatedAt: 2,
        worktree: { id: "wt-1", branch: "feature/sidebar", repoRoot: "/work/openclaw" },
      },
    ]);
    const host = sidebar
      .querySelector('[data-session-key="agent:main:work"]')
      ?.closest("openclaw-tooltip.session-hover-tooltip");

    expect(host?.getAttribute("delay")).toBe(String(SESSION_CARD_COLD_DELAY_MS));
    expect(host?.getAttribute("placement")).toBe("right");
    expect(host?.querySelector(".session-hover-card__title")?.textContent).toBe("Work");
  });
});
