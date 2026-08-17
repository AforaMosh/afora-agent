import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import {
  actionOpacity,
  captureUiProof,
  captureUiProofRegion,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionRow,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

function pullRequestSnapshot(branch: string, state: "open" | "merged", number: number) {
  return {
    pullRequests: [
      {
        branch,
        number,
        owner: "openclaw",
        repo: "openclaw",
        state,
        title: `${state === "open" ? "Open" : "Merged"} combination`,
        url: `https://example.test/openclaw/openclaw/pull/${number}`,
      },
    ],
    rateLimited: false,
    status: "ready",
  };
}

suite.define(() => {
  it("composes pull-request state with each session identity without duplicate branch glyphs", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const rows = [
      {
        branch: "feature/named-glyph",
        key: "agent:main:pr-named-glyph",
        label: "Open PR with named session icon",
        state: "open" as const,
        options: { icon: "braces" },
      },
      {
        branch: "feature/emoji",
        key: "agent:main:pr-emoji",
        label: "Open PR with emoji session icon",
        state: "open" as const,
        options: { icon: "🦞" },
      },
      {
        branch: "feature/owner",
        key: "agent:main:pr-owner",
        label: "Merged PR with owner session icon",
        state: "merged" as const,
        options: {
          createdActor: { id: "designer", label: "Design Owner", type: "human" as const },
        },
      },
      {
        branch: "feature/plain",
        key: "agent:main:pr-plain",
        label: "Open PR without a session icon",
        state: "open" as const,
        options: {},
      },
    ];
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.patch",
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
      ],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.now(), {
            createdActor: { id: "operator", label: "Operator", type: "human" },
          }),
          ...rows.map((row, index) =>
            sessionRow(row.key, row.label, Date.now() - index - 1, {
              forkSource: { sessionKey: "agent:main:main", sessionId: "source-session" },
              worktree: { id: `worktree-${index}`, branch: row.branch, repoRoot: "/tmp/openclaw" },
              ...row.options,
            }),
          ),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const codingSection = page.locator('[data-session-section="work"]');
      const codingToggle = codingSection.locator(".sidebar-session-group-toggle");
      await codingToggle.waitFor({ state: "visible" });
      await codingToggle.click();
      await expect
        .poll(async () => {
          const requests = await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD);
          return requests.some((request) => {
            const sessionKeys = requireRecord(request.params).sessionKeys;
            return Array.isArray(sessionKeys) && rows.every((row) => sessionKeys.includes(row.key));
          });
        })
        .toBe(true);
      await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
        sessions: Object.fromEntries(
          rows.map((row, index) => [
            row.key,
            pullRequestSnapshot(row.branch, row.state, index + 1),
          ]),
        ),
      });

      for (const row of rows) {
        const session = page.locator(`[data-session-key="${row.key}"]`);
        const pullRequest = session.locator(
          `.sidebar-session-indicator [data-session-pr-state="${row.state}"]`,
        );
        await expect.poll(() => pullRequest.isVisible()).toBe(true);
        await expect.poll(() => session.locator(".sidebar-session-fork-indicator").count()).toBe(0);
        await expect
          .poll(() => session.locator(".session-row-state [data-session-pr-state]").count())
          .toBe(0);
      }
      await expect
        .poll(() =>
          page
            .locator('[data-session-key="agent:main:pr-named-glyph"] .session-glyph__overlay')
            .isVisible(),
        )
        .toBe(true);
      await expect
        .poll(() =>
          page
            .locator('[data-session-key="agent:main:pr-emoji"] .session-glyph__overlay')
            .isVisible(),
        )
        .toBe(true);
      await expect
        .poll(() =>
          page
            .locator(
              '[data-session-key="agent:main:pr-owner"] .session-glyph__overlay .session-owner-chip',
            )
            .isVisible(),
        )
        .toBe(true);
      for (const key of [
        "agent:main:pr-named-glyph",
        "agent:main:pr-emoji",
        "agent:main:pr-owner",
      ]) {
        const session = page.locator(`[data-session-key="${key}"]`);
        const [primaryBounds, overlayBounds] = await Promise.all([
          session.locator("[data-session-pr-state]").boundingBox(),
          session.locator(".session-glyph__overlay").boundingBox(),
        ]);
        if (!primaryBounds || !overlayBounds) {
          throw new Error(`Expected visible composite PR geometry for ${key}`);
        }
        expect(overlayBounds.x).toBeGreaterThan(primaryBounds.x + primaryBounds.width / 2);
        expect(overlayBounds.y).toBeGreaterThan(primaryBounds.y + primaryBounds.height / 2);
      }
      expect(
        await page
          .locator('[data-session-key="agent:main:pr-plain"] .session-glyph__overlay')
          .count(),
      ).toBe(0);
      await captureUiProof(page, "sidebar-pr-session-icon-combinations-dark.png");
      await captureUiProofRegion(
        codingSection,
        "sidebar-pr-session-icon-combinations-dark-closeup.png",
      );
      await page.emulateMedia({ colorScheme: "light" });
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("light");
      await captureUiProof(page, "sidebar-pr-session-icon-combinations-light.png");
      await captureUiProofRegion(
        codingSection,
        "sidebar-pr-session-icon-combinations-light-closeup.png",
      );
    } finally {
      await context.close();
    }
  });

  it("keeps action-only text widest at rest and swaps active state for actions", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.now()),
          sessionRow(
            "agent:main:hover-actions",
            "A deliberately long action-only sidebar title",
            Date.now() - 1,
          ),
          sessionRow("agent:main:hover-active", "Hover active", Date.now() - 1, {
            hasActiveRun: true,
            status: "running",
          }),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const actionOnlyRow = page.locator('[data-session-key="agent:main:hover-actions"]');
      await actionOnlyRow.waitFor({ state: "visible", timeout: 10_000 });
      const actionOnlyText = actionOnlyRow.locator(".sidebar-recent-session__text");
      const actionOnlyLink = actionOnlyRow.locator(".sidebar-recent-session__link");
      const actionOnlyDetails = actionOnlyRow.locator(".sidebar-recent-session__details");
      const actionOnlyPin = actionOnlyRow.getByRole("button", { name: "Pin session" });
      await expect
        .poll(() => actionOnlyLink.evaluate((element) => getComputedStyle(element).paddingRight))
        .toBe("4px");
      const restingTextBounds = await actionOnlyText.boundingBox();

      await actionOnlyRow.hover();
      await expect.poll(() => actionOpacity(actionOnlyPin)).toBe("1");
      await expect
        .poll(() => actionOnlyDetails.evaluate((element) => getComputedStyle(element).paddingRight))
        .toBe("52px");
      const hoveredTextBounds = await actionOnlyText.boundingBox();

      await page.mouse.move(0, 0);
      await actionOnlyPin.focus();
      await expect.poll(() => actionOpacity(actionOnlyPin)).toBe("1");
      await expect
        .poll(() => actionOnlyDetails.evaluate((element) => getComputedStyle(element).paddingRight))
        .toBe("52px");
      const focusedTextBounds = await actionOnlyText.boundingBox();
      if (!restingTextBounds || !hoveredTextBounds || !focusedTextBounds) {
        throw new Error("Expected visible action-only text geometry");
      }
      expect(hoveredTextBounds.width).toBeCloseTo(restingTextBounds.width, 1);
      expect(focusedTextBounds.width).toBeCloseTo(restingTextBounds.width, 1);

      const row = page.locator('[data-session-key="agent:main:hover-active"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      const state = row.locator(".session-row-state");
      const pin = row.getByRole("button", { name: "Pin session" });
      const menu = row.getByRole("button", { name: "Open session menu" });
      await expect.poll(() => state.locator(".session-run-spinner").isVisible()).toBe(true);
      await expect.poll(() => actionOpacity(state)).toBe("1");

      await row.hover();
      await expect.poll(() => actionOpacity(state)).toBe("0");
      await expect.poll(() => actionOpacity(pin)).toBe("1");
      await expect.poll(() => actionOpacity(menu)).toBe("1");

      const [nameBounds, pinBounds, menuBounds] = await Promise.all([
        row.locator(".sidebar-recent-session__name").boundingBox(),
        pin.boundingBox(),
        menu.boundingBox(),
      ]);
      if (!nameBounds || !pinBounds || !menuBounds) {
        throw new Error("Expected visible hovered action geometry");
      }
      expect(nameBounds.y + nameBounds.height / 2).toBeLessThan(pinBounds.y + pinBounds.height / 2);
      expect(pinBounds.x + pinBounds.width).toBeLessThanOrEqual(menuBounds.x);

      await page.mouse.move(0, 0);
      await pin.focus();
      await expect.poll(() => actionOpacity(state)).toBe("0");
      await expect.poll(() => actionOpacity(pin)).toBe("1");
      await expect.poll(() => actionOpacity(menu)).toBe("1");

      const [focusedNameBounds, focusedPinBounds, focusedMenuBounds] = await Promise.all([
        row.locator(".sidebar-recent-session__name").boundingBox(),
        pin.boundingBox(),
        menu.boundingBox(),
      ]);
      if (!focusedNameBounds || !focusedPinBounds || !focusedMenuBounds) {
        throw new Error("Expected visible focused action geometry");
      }
      expect(focusedNameBounds.y + focusedNameBounds.height / 2).toBeLessThan(
        focusedPinBounds.y + focusedPinBounds.height / 2,
      );
      expect(focusedPinBounds.x + focusedPinBounds.width).toBeLessThanOrEqual(focusedMenuBounds.x);
    } finally {
      await context.close();
    }
  });

  it("keeps fork provenance in the title above always-visible touch actions", async () => {
    const context = await suite.browser.newContext({
      hasTouch: true,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.now()),
          sessionRow(
            "agent:main:touch-forked",
            "A deliberately long non-running touch session title that must not overlap controls",
            Date.now() - 1,
            {
              forkSource: { sessionKey: "agent:main:main", sessionId: "source-session" },
              hasActiveRun: false,
              status: "done",
            },
          ),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator('[data-session-key="agent:main:touch-forked"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      const fork = row.locator(".sidebar-recent-session__name .sidebar-session-fork-indicator");
      const pin = row.getByRole("button", { name: "Pin session" });
      const menu = row.getByRole("button", { name: "Open session menu" });
      await expect.poll(() => fork.isVisible()).toBe(true);
      await expect.poll(() => row.locator(".session-row-state").count()).toBe(0);

      const [nameBounds, forkBounds, pinBounds, menuBounds] = await Promise.all([
        row.locator(".sidebar-recent-session__name").boundingBox(),
        fork.boundingBox(),
        pin.boundingBox(),
        menu.boundingBox(),
      ]);
      if (!nameBounds || !forkBounds || !pinBounds || !menuBounds) {
        throw new Error("Expected visible fork and touch action geometry");
      }
      expect(
        Math.abs(forkBounds.y + forkBounds.height / 2 - (nameBounds.y + nameBounds.height / 2)),
      ).toBeLessThanOrEqual(2);
      expect(nameBounds.y + nameBounds.height / 2).toBeLessThan(pinBounds.y + pinBounds.height / 2);
      expect(pinBounds.x + pinBounds.width).toBeLessThanOrEqual(menuBounds.x);
    } finally {
      await context.close();
    }
  });

  it("keeps semantic state beside always-visible touch actions", async () => {
    const context = await suite.browser.newContext({
      hasTouch: true,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.now()),
          sessionRow("agent:main:touch-active", "Touch active", Date.now() - 1, {
            hasActiveRun: true,
            status: "running",
          }),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator('[data-session-key="agent:main:touch-active"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      const state = row.locator(".session-row-state");
      const pin = row.getByRole("button", { name: "Pin session" });
      const menu = row.getByRole("button", { name: "Open session menu" });
      await expect.poll(() => state.locator(".session-run-spinner").isVisible()).toBe(true);
      await expect.poll(() => actionOpacity(state)).toBe("1");
      await expect.poll(() => pin.isVisible()).toBe(true);
      await expect.poll(() => menu.isVisible()).toBe(true);

      const [stateBounds, pinBounds] = await Promise.all([state.boundingBox(), pin.boundingBox()]);
      if (!stateBounds || !pinBounds) {
        throw new Error("Expected visible touch state and action geometry");
      }
      expect(stateBounds.x + stateBounds.width).toBeLessThanOrEqual(pinBounds.x);
    } finally {
      await context.close();
    }
  });

  it("does not widen desktop session text when hover actions replace trailing state", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.patch",
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
      ],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.now()),
          sessionRow(
            "agent:main:combined-state",
            "Combined state with a deliberately long resting sidebar title",
            Date.now() - 1,
            {
              forkSource: { sessionKey: "agent:main:main", sessionId: "source-session" },
              hasActiveRun: true,
              status: "running",
              unread: true,
              worktree: {
                id: "combined-state-worktree",
                branch: "fix/combined-state",
                repoRoot: "/tmp/openclaw",
              },
            },
          ),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const codingToggle = page.locator(
        '[data-session-section="work"] .sidebar-session-group-toggle',
      );
      await codingToggle.waitFor({ state: "visible" });
      await codingToggle.click();
      await expect
        .poll(async () => {
          const requests = await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD);
          return requests.some((request) => {
            const sessionKeys = requireRecord(request.params).sessionKeys;
            return Array.isArray(sessionKeys) && sessionKeys.includes("agent:main:combined-state");
          });
        })
        .toBe(true);
      await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
        sessions: {
          "agent:main:combined-state": {
            pullRequests: [
              {
                branch: "fix/combined-state",
                number: 1,
                owner: "openclaw",
                repo: "openclaw",
                state: "open",
                title: "Combined state fix",
                url: "https://example.test/openclaw/openclaw/pull/1",
              },
            ],
            rateLimited: false,
            status: "ready",
          },
        },
      });

      const row = page.locator('[data-session-key="agent:main:combined-state"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      const state = row.locator(".session-row-state");
      await expect
        .poll(() =>
          row.locator(".sidebar-recent-session__name .sidebar-session-fork-indicator").count(),
        )
        .toBe(0);
      await expect.poll(() => state.locator('[aria-label="Forked session"]').count()).toBe(0);
      await expect
        .poll(() =>
          row.locator(".sidebar-session-indicator [data-session-pr-state='open']").isVisible(),
        )
        .toBe(true);
      await expect.poll(() => state.locator("[data-session-pr-state]").count()).toBe(0);
      await expect.poll(() => state.locator(".session-run-spinner").isVisible()).toBe(true);
      await expect.poll(() => state.locator(".session-unread-dot").isVisible()).toBe(true);
      const [endcapBounds, spinnerBounds, unreadBounds] = await Promise.all([
        row.locator(".sidebar-recent-session__details-endcap").boundingBox(),
        state.locator(".session-run-spinner").boundingBox(),
        state.locator(".session-unread-dot").boundingBox(),
      ]);
      if (!endcapBounds || !spinnerBounds || !unreadBounds) {
        throw new Error("Expected visible combined session state geometry");
      }
      // Fractional flex distribution can move a 12px spinner by under two
      // device pixels; larger drift would mean the endcap clips status again.
      for (const iconBounds of [spinnerBounds, unreadBounds]) {
        expect(iconBounds.x).toBeGreaterThanOrEqual(endcapBounds.x - 2);
        expect(iconBounds.x + iconBounds.width).toBeLessThanOrEqual(
          endcapBounds.x + endcapBounds.width + 2,
        );
      }
      const link = row.locator(".sidebar-recent-session__link");
      const details = row.locator(".sidebar-recent-session__details");
      const pin = row.getByRole("button", { name: "Pin session" });
      const menu = row.getByRole("button", { name: "Open session menu" });
      await expect
        .poll(() => link.evaluate((element) => getComputedStyle(element).paddingRight))
        .toBe("4px");

      const [restingTextBounds, restingStateBounds, restingPinBounds, restingMenuBounds] =
        await Promise.all([
          row.locator(".sidebar-recent-session__text").boundingBox(),
          state.boundingBox(),
          pin.boundingBox(),
          menu.boundingBox(),
        ]);
      if (!restingTextBounds || !restingStateBounds || !restingPinBounds || !restingMenuBounds) {
        throw new Error("Expected visible resting session state geometry");
      }
      const actionSurfaceWidth = restingMenuBounds.x + restingMenuBounds.width - restingPinBounds.x;
      expect(restingTextBounds.x + restingTextBounds.width).toBeGreaterThan(
        restingStateBounds.x - actionSurfaceWidth,
      );
      const restingNameBounds = await row.locator(".sidebar-recent-session__name").boundingBox();
      if (!restingNameBounds) {
        throw new Error("Expected visible resting session title geometry");
      }
      expect(restingNameBounds.y + restingNameBounds.height / 2).toBeLessThan(
        restingStateBounds.y + restingStateBounds.height / 2,
      );
      await row.hover();
      await expect.poll(() => actionOpacity(state)).toBe("0");
      await expect.poll(() => actionOpacity(pin)).toBe("1");
      await expect.poll(() => actionOpacity(menu)).toBe("1");
      await expect
        .poll(() => details.evaluate((element) => getComputedStyle(element).paddingRight))
        .toBe("52px");

      const [textBounds, nameBounds, pinBounds, menuBounds] = await Promise.all([
        row.locator(".sidebar-recent-session__text").boundingBox(),
        row.locator(".sidebar-recent-session__name").boundingBox(),
        pin.boundingBox(),
        menu.boundingBox(),
      ]);
      if (!textBounds || !nameBounds || !pinBounds || !menuBounds) {
        throw new Error("Expected visible combined session action geometry");
      }
      expect(textBounds.width).toBeCloseTo(restingTextBounds.width, 1);
      expect(nameBounds.y + nameBounds.height / 2).toBeLessThan(pinBounds.y + pinBounds.height / 2);
      expect(pinBounds.x + pinBounds.width).toBeLessThanOrEqual(menuBounds.x);
      await page.mouse.move(0, 0);
      await pin.focus();
      await expect.poll(() => actionOpacity(state)).toBe("0");
      await expect.poll(() => actionOpacity(pin)).toBe("1");
      await expect.poll(() => actionOpacity(menu)).toBe("1");
      await expect
        .poll(() => details.evaluate((element) => getComputedStyle(element).paddingRight))
        .toBe("52px");

      const [focusedTextBounds, focusedNameBounds, focusedPinBounds, focusedMenuBounds] =
        await Promise.all([
          row.locator(".sidebar-recent-session__text").boundingBox(),
          row.locator(".sidebar-recent-session__name").boundingBox(),
          pin.boundingBox(),
          menu.boundingBox(),
        ]);
      if (!focusedTextBounds || !focusedNameBounds || !focusedPinBounds || !focusedMenuBounds) {
        throw new Error("Expected visible focused session action geometry");
      }
      expect(focusedTextBounds.width).toBeCloseTo(restingTextBounds.width, 1);
      expect(focusedNameBounds.y + focusedNameBounds.height / 2).toBeLessThan(
        focusedPinBounds.y + focusedPinBounds.height / 2,
      );
      expect(focusedPinBounds.x + focusedPinBounds.width).toBeLessThanOrEqual(focusedMenuBounds.x);
    } finally {
      await context.close();
    }
  });
});
