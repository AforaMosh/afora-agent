import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import type { ControlUiBuildInfo } from "../build-info.ts";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureUnionUiProof } from "./ui-proof.test-support.ts";

const proofArtifactRoot = path.join(process.cwd(), ".artifacts", "control-ui-e2e");

export const SIDEBAR_PROOF_USER = {
  self: true,
  id: "riley",
  name: "Riley",
  email: "riley.with.a.deliberately.long.address@example.test",
} as const;

export function createSidebarFooterProofSuite(name: string, buildInfo?: ControlUiBuildInfo) {
  return createControlUiE2eSuite({
    name,
    browserLaunchOptions: { headless: process.env.OPENCLAW_UI_E2E_HEADED !== "1" },
    startServer: () => startControlUiE2eServer(buildInfo, { source: true }),
    startServerBeforeBrowser: true,
    trackBrowserContexts: true,
    unavailableMessage: (executablePath) =>
      `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
  });
}

export async function openSidebarFooterProofPage(
  suite: ReturnType<typeof createSidebarFooterProofSuite>,
  options: NonNullable<Parameters<typeof installMockGateway>[1]> = {},
  beforeNavigation?: (page: Page) => Promise<void>,
) {
  const context = await suite.newBrowserContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
  });
  const page = await context.newPage();
  await beforeNavigation?.(page);
  const gateway = await installMockGateway(page, {
    ...options,
    presenceUsers: [SIDEBAR_PROOF_USER],
  });
  await page.goto(`${suite.server.baseUrl}chat`);
  const sidebar = page.locator("openclaw-app-sidebar");
  await sidebar.locator(".sidebar-identity-card").waitFor();
  return { context, gateway, page, sidebar };
}

export async function setSidebarProofTheme(page: Page, mode: "dark" | "light") {
  await page.emulateMedia({ colorScheme: mode });
  await page.evaluate((nextMode) => {
    const root = document.documentElement;
    root.dataset.themeMode = nextMode;
    root.dataset.themeResolved = nextMode;
    root.classList.toggle("wa-light", nextMode === "light");
    root.classList.toggle("wa-dark", nextMode === "dark");
    root.style.colorScheme = nextMode;
  }, mode);
  await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(mode);
}

export async function captureUnionProof(
  page: Page,
  directory: string,
  fileName: string,
  locators: readonly Locator[],
) {
  const artifactDir = path.join(proofArtifactRoot, directory);
  await captureUnionUiProof({
    page,
    artifactDir,
    fileName,
    locators,
    animations: "allow",
    clampToViewport: true,
    requireAllLocators: true,
    settleLocators: true,
  });
}
