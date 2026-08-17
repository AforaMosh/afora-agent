import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  sessionRow,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import { createSidebarCustomizationSuite } from "./sidebar-customization.test-support.ts";

const suite = createSidebarCustomizationSuite(
  "Control UI sidebar scrollbar and resize mocked Gateway E2E",
);
const visualVariants = [{ colorScheme: "light" as const }, { colorScheme: "dark" as const }];

function configResponse(colorScheme: "light" | "dark") {
  const config = { ui: { prefs: { locale: "en", themeMode: colorScheme } } };
  const hash = `sidebar-scroll-resize-${colorScheme}`;
  return {
    appliedConfigHash: hash,
    config,
    configRevisionHash: hash,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

async function waitForAnimations(locator: Locator) {
  await locator.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

async function captureSidebarChrome(page: Page, shellNav: Locator, fileName: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  const box = await shellNav.boundingBox();
  if (!box) {
    throw new Error("expected visible sidebar chrome");
  }
  const artifactDir = path.join(
    process.cwd(),
    ".artifacts",
    "control-ui-e2e",
    "sidebar-scroll-resize",
  );
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    clip: { x: box.x, y: box.y, width: box.width + 8, height: box.height },
    path: path.join(artifactDir, fileName),
  });
}

suite.define(() => {
  it.each(visualVariants)(
    "keeps scrollbar, divider, and resize feedback quiet in $colorScheme",
    async ({ colorScheme }) => {
      const context = await suite.newBrowserContext({
        colorScheme,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 620, width: 1440 },
      });
      const page = await context.newPage();
      const sessionKey = "agent:main:scroll-resize";
      const baseTime = Date.parse("2026-08-17T12:00:00.000Z");
      const rows = Array.from({ length: 32 }, (_, index) =>
        sessionRow(
          index === 0 ? sessionKey : `agent:main:overflow-${index}`,
          index === 0 ? "Scrollbar and resize proof" : `Overflow session ${index}`,
          baseTime - index * 60_000,
        ),
      );
      await installMockGateway(page, {
        methodResponses: {
          "config.get": configResponse(colorScheme),
          "sessions.list": sessionsListResponse(rows),
        },
        sessionKey,
      });

      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await expect
          .poll(() => page.locator("html").getAttribute("data-theme-mode"))
          .toBe(colorScheme);

        const sidebar = page.locator("openclaw-app-sidebar");
        const sidebarRoot = sidebar.locator(".sidebar");
        const body = sidebar.locator(".sidebar-shell__body");
        const shellNav = page.locator(".shell-nav");
        const resizer = page.getByRole("separator", { name: "Resize sidebar" });
        await body.waitFor();

        const scrollChrome = await body.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            color: style.scrollbarColor,
            gutter: style.scrollbarGutter,
            scrollable: element.scrollHeight > element.clientHeight,
          };
        });
        expect(scrollChrome.color).toContain("rgba(0, 0, 0, 0)");
        expect(scrollChrome.gutter).toBe("stable");
        expect(scrollChrome.scrollable).toBe(true);

        await body.hover();
        expect(await body.evaluate((element) => getComputedStyle(element).scrollbarColor)).not.toBe(
          scrollChrome.color,
        );

        const [bodyBox, sidebarBox] = await Promise.all([
          body.boundingBox(),
          sidebarRoot.boundingBox(),
        ]);
        expect(bodyBox).not.toBeNull();
        expect(sidebarBox).not.toBeNull();
        expect(Math.abs(bodyBox!.x + bodyBox!.width - (sidebarBox!.x + sidebarBox!.width))).toBe(
          0,
        );

        const rest = await resizer.evaluate((element) => ({
          divider: getComputedStyle(element).getPropertyValue("--rail-divider-color").trim(),
          shell: getComputedStyle(element.previousElementSibling!).borderInlineEndColor,
          width: element.getBoundingClientRect().width,
        }));
        expect(rest.divider).toBe("transparent");
        expect(rest.shell).not.toBe("rgba(0, 0, 0, 0)");
        expect(rest.width).toBe(6);

        await resizer.hover();
        await waitForAnimations(resizer);
        const active = await resizer.evaluate((element) => ({
          divider: getComputedStyle(element, "::after").backgroundColor,
          outline: getComputedStyle(element).outlineStyle,
          shell: getComputedStyle(element.previousElementSibling!).borderInlineEndColor,
          width: getComputedStyle(element, "::after").width,
        }));
        expect(active.divider).not.toBe("rgba(0, 0, 0, 0)");
        expect(active.outline).toBe("none");
        expect(active.shell).toBe("rgba(0, 0, 0, 0)");
        expect(active.width).toBe("2px");
        await captureSidebarChrome(page, shellNav, `scroll-resize-${colorScheme}.png`);

        const resizerBounds = await resizer.boundingBox();
        if (!resizerBounds) {
          throw new Error("expected visible sidebar resizer");
        }
        const resizerX = resizerBounds.x + resizerBounds.width / 2;
        const resizerY = resizerBounds.y + resizerBounds.height / 2;
        await page.mouse.move(resizerX, resizerY);
        await page.mouse.down();
        await expect.poll(() => resizer.getAttribute("class")).toContain("dragging");
        await page.mouse.move(resizerX + 22, resizerY);
        await expect
          .poll(async () => Math.round((await shellNav.boundingBox())?.width ?? 0))
          .toBe(280);
        await page.mouse.up();

        await page.setViewportSize({ height: 620, width: 900 });
        await page.locator("html").evaluate((element) => element.setAttribute("dir", "rtl"));
        await expect.poll(() => resizer.isVisible()).toBe(false);
        expect(
          await shellNav.evaluate((element) => getComputedStyle(element).borderInlineEndWidth),
        ).toBe("0px");
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
