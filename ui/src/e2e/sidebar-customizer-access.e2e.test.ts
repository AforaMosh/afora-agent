import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionRow, sessionsListResponse } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI sidebar customizer access mocked Gateway E2E",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("disables server-backed customizer controls for read-only operators", async () => {
    await suite.withPage(
      {
        hasTouch: true,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const pinnedKey = "agent:main:read-only-pinned";
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.read"],
          methodResponses: {
            "sessions.list": sessionsListResponse([
              sessionRow(pinnedKey, "Read-only pinned", Date.now(), { pinned: true }),
            ]),
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const sidebar = page.locator("openclaw-app-sidebar");
        await sidebar.locator(".sidebar-nav__more").click();
        await sidebar
          .locator("wa-dropdown.sidebar-more-menu")
          .getByRole("menuitem", { name: "Customize sidebar" })
          .click();
        const customizer = sidebar.locator(".sidebar-customizer");
        const coding = customizer.locator('[data-sidebar-customizer-id="work"]');
        const pinned = customizer.locator(`[data-sidebar-customizer-id="session:${pinnedKey}"]`);

        await expect.poll(() => coding.getAttribute("draggable")).toBe("false");
        expect(await coding.getByRole("button", { name: "Move Coding down" }).isDisabled()).toBe(
          true,
        );
        expect(
          await pinned
            .getByRole("button", { name: "Unpin session: Read-only pinned" })
            .isDisabled(),
        ).toBe(true);
        expect(await gateway.getRequests("sessions.groups.put")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      },
    );
  });
});
