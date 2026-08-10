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
    const disabledConfig = {
      plugins: { entries: { codex: { config: { supervision: { enabled: false } } } } },
    };
    const enabledConfig = {
      plugins: { entries: { codex: { config: { supervision: { enabled: true } } } } },
    };
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "config.get",
        "config.patch",
        "config.schema",
        "config.schema.lookup",
        "sessions.catalog.list",
      ],
      methodResponses: {
        "config.get": {
          appliedConfigHash: "config-disabled",
          config: disabledConfig,
          configRevisionHash: "config-disabled",
          hash: "config-disabled",
          issues: [],
          raw: JSON.stringify(disabledConfig),
          valid: true,
        },
        "config.patch": {
          config: enabledConfig,
          hash: "config-enabled",
          ok: true,
        },
        "config.schema": {
          generatedAt: "2026-08-10T00:00:00.000Z",
          schema: { type: "object", properties: {} },
          uiHints: {},
          version: "e2e",
        },
        "config.schema.lookup": {
          path: "plugins.entries.codex.config.supervision.enabled",
          schema: { type: "boolean", default: false },
          reloadKind: "hot",
          hint: {
            label: "Enable Codex Supervision",
            help: "Enable continuation of local native Codex sessions in Chat.",
            advanced: true,
          },
          hintPath: "plugins.entries.codex.config.supervision.enabled",
          children: [],
        },
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
      expect(new URL(page.url()).searchParams.get("setting")).toBe(
        "plugins.entries.codex.config.supervision.enabled",
      );
      const supervisionToggle = page.locator("wa-switch.settings-toggle");
      await supervisionToggle.waitFor();
      await expect
        .poll(async () => (await gateway.getRequests("config.schema.lookup")).at(-1)?.params)
        .toEqual({ path: "plugins.entries.codex.config.supervision.enabled" });
      await expect
        .poll(() =>
          supervisionToggle.evaluate(
            (element) => (element as HTMLElement & { checked: boolean }).checked,
          ),
        )
        .toBe(false);
      await supervisionToggle.click();
      await expect
        .poll(async () => {
          const requests = await gateway.getRequests("config.patch");
          return requests.at(-1)?.params;
        })
        .toMatchObject({
          raw: JSON.stringify(enabledConfig),
        });
    } finally {
      await page.close();
    }
  });
});
