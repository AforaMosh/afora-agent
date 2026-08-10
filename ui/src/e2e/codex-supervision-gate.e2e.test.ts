import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Codex supervision catalog gate",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it("keeps disabled sessions readable and routes continuation setup", async () => {
    const page = await suite.browser.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [
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
                      threadId: "thread-disabled",
                      name: "Readable native session",
                      status: "idle",
                      source: "cli",
                      archived: false,
                      canContinue: false,
                      continueDisabledReason:
                        "Codex supervision is disabled. Enable it to continue this session.",
                      continueSetupConfigPath: "plugins.entries.codex.config.supervision.enabled",
                      canArchive: true,
                    },
                  ],
                },
              ],
            },
          ],
        },
        "sessions.catalog.read": {
          hostId: "gateway:local",
          threadId: "thread-disabled",
          items: [{ id: "u1", type: "userMessage", text: "read-only history" }],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const codingToggle = page.locator(
        '[data-session-section="work"] .sidebar-session-group-toggle',
      );
      if (
        (await codingToggle.count()) > 0 &&
        (await codingToggle.getAttribute("aria-expanded")) === "false"
      ) {
        await codingToggle.click();
      }
      await page.getByText("Readable native session", { exact: true }).click();
      await page.getByText("read-only history", { exact: true }).waitFor();
      await page
        .getByText("Codex supervision is disabled. Enable it to continue this session.", {
          exact: true,
        })
        .waitFor();
      expect(await page.locator(".agent-chat__composer-combobox > textarea").isDisabled()).toBe(
        true,
      );
      expect(await gateway.getRequests("sessions.catalog.continue")).toEqual([]);

      await page.getByRole("button", { name: "Open settings" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/automation");
      expect(new URL(page.url()).searchParams.get("section")).toBe("plugins");
    } finally {
      await page.close();
    }
  });
});
