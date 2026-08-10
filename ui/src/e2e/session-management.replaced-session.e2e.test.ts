// Control UI E2E: a rotated session identity is invisible, a vanished row is named once.
import type { BrowserContext, Page } from "playwright";
import { expect, it } from "vitest";
import type { MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import {
  activateMenuItem,
  captureUiProof,
  createSessionManagementE2eSuite,
  installMockGateway,
  openSessionMenuSubmenu,
  requireRecord,
  sessionRow,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

/** Drives one "move this session into a new group" attempt up to the pending patch. */
async function startNewGroupMove(colorScheme: "dark" | "light"): Promise<{
  context: BrowserContext;
  gateway: MockGatewayControls;
  page: Page;
}> {
  const context = await suite.browser.newContext({
    colorScheme,
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  });
  const page = await context.newPage();
  const gateway = await installMockGateway(page, {
    deferredMethods: ["sessions.patch"],
    featureMethods: [
      "chat.metadata",
      "chat.startup",
      "sessions.groups.list",
      "sessions.groups.put",
      "sessions.patch",
    ],
    methodResponses: {
      "sessions.list": sessionsListResponse([
        {
          ...sessionRow("agent:main:move-me", "Work chat", Date.parse("2026-07-01T16:00:00.000Z")),
          sessionId: "sess-before-rotation",
        },
      ]),
    },
    sessionKey: "agent:main:move-me",
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  const row = page.locator('.sidebar-recent-session[data-session-key="agent:main:move-me"]');
  await row.waitFor({ state: "visible", timeout: 10_000 });
  await row.hover();
  await row.getByRole("button", { name: "Open session menu" }).click();
  await openSessionMenuSubmenu(page, "Move to group");
  await activateMenuItem(page.getByRole("menuitem", { name: "New group…" }));
  const field = page.locator("openclaw-modal-dialog input");
  await field.waitFor({ state: "visible" });
  await field.fill("Client work");
  await field.press("Enter");
  return { context, gateway, page };
}

suite.define(() => {
  it("moves the session when its identity rotated, with nothing on screen", async () => {
    const { context, gateway, page } = await startNewGroupMove("dark");

    try {
      // Compaction rotated the identity under the row while the dialog was open.
      const first = await gateway.waitForRequest("sessions.patch");
      expect(requireRecord(first.params)).toMatchObject({
        expectedSessionId: "sess-before-rotation",
        key: "agent:main:move-me",
      });
      await gateway.rejectDeferred("sessions.patch", {
        code: "INVALID_REQUEST",
        details: { code: "SESSION_CHANGED", currentSessionId: "sess-after-rotation" },
        message: "Session agent:main:move-me changed before patch. Retry.",
      });

      // The operator picked the row, so the move follows it to the surviving
      // session by itself: one re-aimed request, no dialog, no notice anywhere.
      await expect
        .poll(async () => (await gateway.getRequests("sessions.patch")).length, { timeout: 10_000 })
        .toBe(2);
      const retry = (await gateway.getRequests("sessions.patch")).at(-1);
      expect(requireRecord(retry?.params)).toMatchObject({
        category: "Client work",
        expectedSessionId: "sess-after-rotation",
      });
      await expect.poll(() => page.locator("openclaw-modal-dialog").count()).toBe(0);
      expect(await page.locator(".app-toast").count()).toBe(0);
      expect(await page.locator("[data-sidebar-session-error]").count()).toBe(0);
      await captureUiProof(page, "session-rotated-silent-dark.png");
    } finally {
      await context.close();
    }
  });

  for (const colorScheme of ["dark", "light"] as const) {
    it(`names the group and the session that could not join it (${colorScheme})`, async () => {
      const { context, gateway, page } = await startNewGroupMove(colorScheme);

      try {
        await gateway.waitForRequest("sessions.patch");
        // No surviving identity: the row is gone, and patching the key would make a
        // new session rather than move the one the operator meant.
        await gateway.rejectDeferred("sessions.patch", {
          code: "INVALID_REQUEST",
          details: { code: "SESSION_CHANGED" },
          message: "Session agent:main:move-me changed before patch. Retry.",
        });

        // The group still landed, so this closes like a success and accounts for the
        // member in one quiet line that names both objects.
        const toast = page.locator(".app-toast__message");
        await toast.waitFor({ state: "visible", timeout: 10_000 });
        await expect
          .poll(() => toast.textContent())
          .toBe("“Client work” created. “Work chat” wasn’t added — it no longer exists.");
        expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
        expect(await page.locator("[data-sidebar-session-error]").count()).toBe(0);
        await captureUiProof(page, `session-gone-toast-${colorScheme}.png`);
      } finally {
        await context.close();
      }
    });
  }
});
