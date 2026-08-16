import type { Locator } from "playwright";
import { expect, it } from "vitest";
import type { CronJob, CronJobsListResult, ModelAuthStatusResult } from "../api/types.ts";
import type { ControlUiMockGatewayScenario } from "../test-helpers/control-ui-e2e.ts";
import {
  captureUnionProof,
  createSidebarFooterProofSuite,
  openSidebarFooterProofPage,
  setSidebarProofTheme,
} from "./sidebar-footer-proof.test-support.ts";

const NOW = Date.now();
const FUTURE = NOW + 24 * 60 * 60_000;

function cronJob(
  id: string,
  state: CronJob["state"] = { lastRunStatus: "ok", nextRunAtMs: FUTURE },
): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: NOW - 60_000,
    updatedAtMs: NOW,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Run fixture" },
    state,
  };
}

function cronList(jobs: CronJob[]): CronJobsListResult {
  return {
    jobs,
    snapshotRevision: "sidebar-issues-e2e",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

function authStatus(providers: ModelAuthStatusResult["providers"] = []): ModelAuthStatusResult {
  return { ts: NOW, providers };
}

function repeatedJob(id: string) {
  return cronJob(id, {
    lastRunStatus: "error",
    consecutiveErrors: 2,
    lastFailureAlertAtMs: NOW - 1_000,
    nextRunAtMs: FUTURE,
  });
}

function failedOnceJob(id: string) {
  return cronJob(id, {
    lastRunStatus: "error",
    consecutiveErrors: 1,
    nextRunAtMs: FUTURE,
  });
}

function overdueJob(id: string) {
  return cronJob(id, {
    lastRunStatus: "ok",
    nextRunAtMs: NOW - 600_000,
  });
}

const BLOCKING_AUTH = authStatus([
  {
    provider: "google",
    displayName: "Gemini",
    status: "expired",
    profiles: [{ profileId: "google:default", type: "oauth", status: "expired" }],
  },
]);

const suite = createSidebarFooterProofSuite("Control UI sidebar Issues E2E");

async function openState(
  theme: "dark" | "light",
  cronJobs: CronJob[],
  modelAuthStatus: ModelAuthStatusResult = authStatus(),
  extras: ControlUiMockGatewayScenario = {},
) {
  const opened = await openSidebarFooterProofPage(suite, {
    ...extras,
    methodResponses: {
      ...extras.methodResponses,
      "cron.list": cronList(cronJobs),
      "models.authStatus": modelAuthStatus,
    },
  });
  await setSidebarProofTheme(opened.page, theme);
  await opened.page.mouse.move(0, 0);
  return opened;
}

async function openIssuesPanel(sidebar: Locator) {
  const bell = sidebar.locator(".sidebar-issues-button");
  await bell.waitFor();
  await bell.click();
  const panel = sidebar.locator(".sidebar-issues-panel");
  await panel.waitFor();
  await expect
    .poll(async () => {
      const bellBox = await bell.boundingBox();
      const panelBox = await panel.boundingBox();
      return bellBox && panelBox
        ? {
            bellSize: [bellBox.width, bellBox.height],
            panelWidth: panelBox.width,
            bottomGap: Math.round(bellBox.y - (panelBox.y + panelBox.height)),
            leftGap: Math.round(panelBox.x - bellBox.x),
          }
        : null;
    })
    .toEqual({ bellSize: [40, 40], panelWidth: 304, bottomGap: 6, leftGap: 0 });
  const headingStyle = await panel.locator(".sidebar-issues-panel__heading").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      text: element.textContent,
      textTransform: style.textTransform,
      letterSpacing: style.letterSpacing,
    };
  });
  expect(headingStyle).toMatchObject({ text: "Issues", textTransform: "uppercase" });
  expect(Number.parseFloat(headingStyle.letterSpacing)).toBeGreaterThan(0);
  return { bell, panel };
}

async function assertCanonicalParity(bell: Locator, panel: Locator, count: number) {
  expect(await bell.getAttribute("aria-label")).toMatch(new RegExp(`^${count} issues?[, ]`));
  expect(await panel.locator(".sidebar-issues-panel__row").count()).toBe(count);
}

async function unpinAutomations(sidebar: Locator) {
  const moreButton = sidebar.locator(".sidebar-nav__more");
  await moreButton.click();
  const moreMenu = sidebar.locator("wa-dropdown.sidebar-more-menu");
  await moreMenu.getByRole("menuitem", { name: "Customize sidebar" }).click();
  const editor = sidebar.locator(".sidebar-customizer");
  const automations = editor.locator('[data-sidebar-customizer-id="route:cron"]');
  await automations.getByRole("button", { name: "Hide Automations from sidebar" }).click();
  await editor.locator(".sidebar-customizer__done").click();
  await expect.poll(() => sidebar.locator('[data-sidebar-entry="route:cron"]').count()).toBe(0);
  await moreButton.click();
  const unpinnedMenu = sidebar.locator("wa-dropdown.sidebar-more-menu");
  await unpinnedMenu.waitFor();
  return unpinnedMenu;
}

suite.define(() => {
  it("keeps active Issues canonical and visually quiet", async () => {
    const theme = "light";
    const healthy = await openState(theme, [cronJob("healthy")], authStatus(), {
      methodResponses: {
        "sessions.list": {
          count: 1,
          defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
          path: "",
          sessions: [
            {
              displayName: "Active unread session",
              hasActiveRun: true,
              key: "agent:main:main",
              kind: "direct",
              label: "Active unread session",
              status: "running",
              unread: true,
              updatedAt: Date.now(),
            },
          ],
          ts: Date.now(),
        },
      },
      sessionInfo: { activeRunIds: ["run-1"], hasActiveRun: true },
    });
    try {
      const footer = healthy.sidebar.locator(".sidebar-footer-bar");
      expect(await healthy.sidebar.locator(".sidebar-issues-button").count()).toBe(0);
      expect(await healthy.sidebar.locator(".sidebar-issues-panel").count()).toBe(0);
      await captureUnionProof(healthy.page, "sidebar-issues", `${theme}-healthy-quiet.png`, [
        footer,
      ]);
    } finally {
      await suite.closeBrowserContext(healthy.context);
    }

    const failedOnce = await openState(theme, [failedOnceJob("Nightly export")]);
    try {
      const footer = failedOnce.sidebar.locator(".sidebar-footer-bar");
      const automationRow = failedOnce.sidebar.locator('[data-sidebar-entry="route:cron"]');
      const badge = automationRow.locator(".sidebar-nav-health-indicator");
      await badge.waitFor();
      expect((await badge.textContent())?.trim()).toBe("");
      expect(await badge.getAttribute("aria-label")).toBe("1 automation needs attention");
      expect(
        await badge.evaluate((element) => {
          const style = getComputedStyle(element);
          const dot = getComputedStyle(element, "::before");
          return {
            role: element.getAttribute("role"),
            slot: [style.width, style.height],
            dot: [dot.width, dot.height],
          };
        }),
      ).toEqual({ role: "status", slot: ["20px", "20px"], dot: ["7px", "7px"] });
      expect(await failedOnce.sidebar.locator(".sidebar-issues-button").count()).toBe(0);
      await captureUnionProof(
        failedOnce.page,
        "sidebar-issues",
        `${theme}-failed-once-automations-direct.png`,
        [automationRow, footer],
      );

      const moreMenu = await unpinAutomations(failedOnce.sidebar);
      const menuSurface = moreMenu.locator('[part="menu"]');
      const menuBadge = moreMenu
        .locator('wa-dropdown-item[value="cron"]')
        .locator(".sidebar-nav-health-indicator");
      await menuBadge.waitFor();
      expect((await menuBadge.textContent())?.trim()).toBe("");
      expect(await menuBadge.getAttribute("aria-label")).toBe("1 automation needs attention");
      await captureUnionProof(
        failedOnce.page,
        "sidebar-issues",
        `${theme}-failed-once-automations-more.png`,
        [menuSurface, footer],
      );
    } finally {
      await suite.closeBrowserContext(failedOnce.context);
    }

    for (const scenario of [
      { name: "repeated-failure", jobs: [repeatedJob("Nightly export")] },
      { name: "overdue", jobs: [overdueJob("Daily digest")] },
    ] as const) {
      const opened = await openState(theme, [...scenario.jobs]);
      try {
        const footer = opened.sidebar.locator(".sidebar-footer-bar");
        const { bell, panel } = await openIssuesPanel(opened.sidebar);
        await assertCanonicalParity(bell, panel, 1);
        if (scenario.name === "overdue") {
          expect(await panel.locator(".sidebar-issues-panel__state").textContent()).toBe(
            "Missed schedule",
          );
        }
        await captureUnionProof(opened.page, "sidebar-issues", `${theme}-${scenario.name}.png`, [
          panel,
          footer,
        ]);

        await opened.page.keyboard.press("Escape");
        await expect.poll(() => panel.count()).toBe(0);
        await expect
          .poll(() => bell.evaluate((element) => element === document.activeElement))
          .toBe(true);
        await bell.click();
        await panel.waitFor();
        await opened.sidebar.locator('[data-sidebar-entry="route:cron"]').click();
        await expect.poll(() => panel.count()).toBe(0);
      } finally {
        await suite.closeBrowserContext(opened.context);
      }
    }

    const blocking = await openState(theme, [], BLOCKING_AUTH);
    try {
      const footer = blocking.sidebar.locator(".sidebar-footer-bar");
      const { bell, panel } = await openIssuesPanel(blocking.sidebar);
      await assertCanonicalParity(bell, panel, 1);
      const reconnectRow = panel.locator(".sidebar-issues-panel__row", {
        hasText: "Reconnect",
      });
      const reconnect = reconnectRow.getByText("Reconnect", { exact: true });
      expect(await reconnectRow.locator(".sidebar-issues-panel__state").textContent()).toBe(
        "Authentication expired",
      );
      expect(await reconnectRow.locator(".sidebar-issues-panel__chevron").count()).toBe(0);
      expect(
        await reconnect.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            backgroundColor: style.backgroundColor,
            borderRadius: style.borderRadius,
            color: style.color,
          };
        }),
      ).toEqual({
        backgroundColor: expect.not.stringMatching(/^rgba\(0, 0, 0, 0\)$/u),
        borderRadius: expect.any(String),
        color: expect.any(String),
      });
      expect(await bell.evaluate((element) => Boolean(element.closest("openclaw-tooltip")))).toBe(
        false,
      );
      await bell.hover();
      await blocking.page.waitForTimeout(250);
      expect(await bell.getAttribute("aria-describedby")).toBeNull();
      await captureUnionProof(blocking.page, "sidebar-issues", `${theme}-blocking.png`, [
        panel,
        footer,
      ]);

      await reconnect.hover();
      await captureUnionProof(blocking.page, "sidebar-issues", `${theme}-reconnect-hover.png`, [
        panel,
        footer,
      ]);
      await blocking.page.mouse.move(0, 0);
      await reconnectRow.focus();
      await blocking.page.keyboard.press("Tab");
      await expect
        .poll(() => reconnectRow.evaluate((node) => node.matches(":focus-visible")))
        .toBe(true);
      await captureUnionProof(blocking.page, "sidebar-issues", `${theme}-reconnect-focus.png`, [
        panel,
        footer,
      ]);
    } finally {
      await suite.closeBrowserContext(blocking.context);
    }

    const mixed = await openState(
      theme,
      [repeatedJob("Nightly export"), overdueJob("Daily digest")],
      BLOCKING_AUTH,
    );
    try {
      await mixed.gateway.emitGatewayEvent("update.available", {
        updateAvailable: {
          currentVersion: "1.0.0",
          latestVersion: "2.0.0",
          channel: "stable",
        },
      });
      const update = mixed.sidebar.locator(".sidebar-update-card__availability");
      await update.waitFor();
      const footer = mixed.sidebar.locator(".sidebar-footer-bar");
      const { bell, panel } = await openIssuesPanel(mixed.sidebar);
      await assertCanonicalParity(bell, panel, 3);
      expect(await panel.textContent()).not.toContain("update");
      expect(await panel.textContent()).not.toContain("Unread");
      expect(await panel.textContent()).not.toContain("Active run");
      await captureUnionProof(mixed.page, "sidebar-issues", `${theme}-mixed.png`, [
        update,
        panel,
        footer,
      ]);
    } finally {
      await suite.closeBrowserContext(mixed.context);
    }

    const capped = await openState(
      theme,
      Array.from({ length: 10 }, (_, index) => repeatedJob(`Automation ${index + 1}`)),
    );
    try {
      const footer = capped.sidebar.locator(".sidebar-footer-bar");
      const { bell, panel } = await openIssuesPanel(capped.sidebar);
      await assertCanonicalParity(bell, panel, 10);
      expect(await bell.locator(".sidebar-issues-button__count").textContent()).toBe("9+");
      await captureUnionProof(capped.page, "sidebar-issues", `${theme}-9-plus.png`, [
        panel,
        footer,
      ]);
    } finally {
      await suite.closeBrowserContext(capped.context);
    }

    const resolved = await openState(theme, [repeatedJob("Recovered export")]);
    try {
      const footer = resolved.sidebar.locator(".sidebar-footer-bar");
      const { panel } = await openIssuesPanel(resolved.sidebar);
      await resolved.gateway.setMethodResponse("cron.list", cronList([]));
      await resolved.gateway.emitGatewayEvent("cron", {});
      await expect.poll(() => resolved.sidebar.locator(".sidebar-issues-button").count()).toBe(0);
      expect(await panel.count()).toBe(0);
      await resolved.page.mouse.move(0, 0);
      await captureUnionProof(resolved.page, "sidebar-issues", `${theme}-resolved-quiet.png`, [
        footer,
      ]);
    } finally {
      await suite.closeBrowserContext(resolved.context);
    }
  });

  it.each(["light", "dark"] as const)("captures the Issues surface in %s mode", async (theme) => {
    const opened = await openState(theme, [repeatedJob("Nightly export")]);
    try {
      const footer = opened.sidebar.locator(".sidebar-footer-bar");
      const { panel } = await openIssuesPanel(opened.sidebar);
      await captureUnionProof(opened.page, "sidebar-issues", `${theme}-surface.png`, [
        panel,
        footer,
      ]);
    } finally {
      await suite.closeBrowserContext(opened.context);
    }
  });
});
