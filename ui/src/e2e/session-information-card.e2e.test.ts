import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionRow,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const SESSION_KEY = "agent:main:hover-card";

suite.define(() => {
  it("reveals full session context after a deliberate hover", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    try {
      await page.addInitScript(() => {
        localStorage.setItem("openclaw:sidebar:sessions:collapsed-sections", "[]");
      });
      await installMockGateway(page, {
        methodResponses: {
          "sessions.list": sessionsListResponse([
            sessionRow(SESSION_KEY, "Reconcile the complete session title", 5, {
              worktree: {
                id: "wt-1",
                branch: "feature/sidebar-card",
                repoRoot: "/work/openclaw",
              },
            }),
          ]),
        },
        sessionKey: SESSION_KEY,
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, SESSION_KEY));
      await page.locator(`[data-session-key="${SESSION_KEY}"]`).hover();

      const card = page.locator(".session-hover-card:visible");
      await expect.poll(() => card.count(), { timeout: 3_000 }).toBe(1);
      expect(await card.locator(".session-hover-card__title").textContent()).toBe(
        "Reconcile the complete session title",
      );
      const rows = await card.locator(".session-hover-card__row").allTextContents();
      expect(rows.map((row) => row.replace(/\s+/gu, " ").trim())).toEqual([
        "Project openclaw",
        "Branch feature/sidebar-card",
      ]);
    } finally {
      await context.close();
    }
  });
});
