// Control UI tests cover the guided mobile pairing wizard through the mocked Gateway.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import qrcode from "qrcode";
import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI mobile pairing mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/mobile-pairing");
const LAN_URL = "ws://192.168.1.20:18789";
const BASE_CONFIG_HASH = "mock-config-hash-0";
const LAN_PATCH = '{"gateway":{"bind":"lan"}}';

const loopbackInspection = {
  configHash: BASE_CONFIG_HASH,
  configState: "applied",
  auth: "token",
  current: { status: "blocked", blocker: "route-unavailable" },
  lan: { status: "available", url: LAN_URL, requiresGatewayChange: true },
  tailscale: { status: "unavailable" },
  publicUrl: { status: "not-configured" },
};

const lanPlan = {
  status: "confirmation-required",
  mode: "lan",
  configHash: BASE_CONFIG_HASH,
  configState: "applied",
  urls: [LAN_URL],
  exposure: "local-network",
  auth: "token",
  access: "limited",
  accessDowngraded: true,
  changes: ["expose-gateway-on-local-network"],
  configWrite: {
    patch: LAN_PATCH,
    revert: { execution: "automatic", patch: '{"gateway":{"bind":"loopback"}}' },
  },
  restartRequired: true,
  preservesCurrentRoute: false,
};

const appliedLanPlan = {
  ...lanPlan,
  changes: [],
  restartRequired: false,
  preservesCurrentRoute: true,
  configWrite: undefined,
};

/**
 * Restarts the application connection the way a `gateway.*` change does, and
 * proves the app socket really dropped and was replaced. Counting sockets for
 * the app URL keeps this honest: the endpoint probe opens its own socket, so a
 * bare online toggle could otherwise target the probe and never restart the app.
 */
async function restartGatewayConnection(gateway: MockGatewayControls, page: Page) {
  const appSocketUrl = (await gateway.getSocketUrls())[0];
  if (!appSocketUrl) {
    throw new Error("Expected the Control UI to hold an application socket before the restart");
  }
  const appSockets = async () =>
    (await gateway.getSocketUrls()).filter((url) => url === appSocketUrl).length;
  const before = await appSockets();
  await gateway.setOnline(false);
  // The wizard survives the disconnect its own change caused.
  await page.getByText("Waiting for the Gateway to restart…").waitFor();
  await gateway.setOnline(true);
  await expect.poll(appSockets, { timeout: 20_000 }).toBeGreaterThan(before);
}

/** Waits out the modal's entry animation so captures are not half-faded. */
async function settleDialog(page: Page) {
  await page.waitForFunction(() => {
    // Resolve the pairing dialog through its panel: other modal hosts (the
    // shell nav drawer) precede it in the DOM, and gating on the first host
    // captures the pairing dialog mid entry animation.
    const panel = document.querySelector(".device-pair-setup");
    const modal = panel?.closest("openclaw-modal-dialog");
    const host = modal?.shadowRoot?.querySelector("wa-dialog");
    const native = host?.shadowRoot?.querySelector("dialog");
    if (!modal || !host || !native || !panel) {
      return false;
    }
    const opaque = [modal, host, native, panel].every(
      (element) => Number(getComputedStyle(element).opacity) === 1,
    );
    if (!opaque) {
      return false;
    }
    const running = [host, native, panel].flatMap((element) =>
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState !== "finished"),
    );
    return running.length === 0;
  });
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
  });
}

const PAIRING_VIEWPORTS = [
  { name: "desktop", height: 900, width: 1280 },
  { name: "mobile", height: 844, width: 390 },
] as const;

const blockedPublicPlan = {
  status: "blocked",
  mode: "public",
  configState: "applied",
  auth: "token",
  blocker: "public-url-insecure",
  changes: [],
};

const SETUP_CODE = Buffer.from(
  JSON.stringify({ url: LAN_URL, bootstrapToken: "e2e-bootstrap-token" }),
  "utf8",
).toString("base64url");

const setupCodeResult = async () => ({
  access: "limited",
  accessDowngraded: true,
  auth: "token",
  gatewayUrl: LAN_URL,
  qrDataUrl: await qrcode.toDataURL(SETUP_CODE, { margin: 2, width: 360 }),
  setupCode: SETUP_CODE,
  urlSource: "gateway.bind=lan",
});

suite.define(() => {
  it("plans, applies, survives the restart, and only then issues a setup code", async () => {
    const setupCodeResponse = await setupCodeResult();
    mkdirSync(artifactDir, { recursive: true });
    await suite.withPage(
      {
        locale: "en-US",
        recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } },
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(String(error)));
        const gateway = await installMockGateway(page, {
          presenceUsers: [{ self: true, id: "operator", name: "Operator" }],
          methodResponses: {
            "config.get": {
              raw: '{\n  "gateway": { "bind": "loopback" }\n}\n',
              hash: BASE_CONFIG_HASH,
              path: "/tmp/openclaw.json",
              config: { gateway: { bind: "loopback" } },
            },
            "config.patch": { ok: true },
            "device.pair.list": { paired: [], pending: [] },
            "device.pair.connectivity.inspect": loopbackInspection,
            "device.pair.connectivity.plan": lanPlan,
            "device.pair.setupCode": setupCodeResponse,
            "node.list": { nodes: [] },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}chat`);
        expect(response?.status()).toBe(200);

        // Pairing lives with the account-level controls in the footer identity menu.
        const sidebar = page.locator("openclaw-app-sidebar");
        await sidebar.getByRole("button", { name: /^Identity and app menu for / }).click();
        const sidebarPairingButton = sidebar
          .locator("wa-dropdown.sidebar-identity-menu")
          .locator(".sidebar-pair-mobile");
        await sidebarPairingButton.waitFor();
        await expect.poll(async () => sidebarPairingButton.isEnabled()).toBe(true);
        await sidebarPairingButton.click();

        const dialog = page.getByRole("dialog", { name: "OpenClaw mobile" });
        await dialog.waitFor();
        const chooserPrompt = page.getByText("How should this phone reach the Gateway?");
        await chooserPrompt.waitFor();
        // The subordinate access control opens collapsed on the default level.
        const accessValue = page.locator(".device-pair-setup__access-value");
        expect(await accessValue.textContent()).toBe("Full access");
        await expect
          .poll(async () => (await gateway.getRequests("device.pair.connectivity.inspect")).length)
          .toBe(1);
        expect(await gateway.getRequests("device.pair.setupCode")).toEqual([]);
        // A loopback-only Gateway is answered by the chooser itself: the route a
        // phone cannot dial is withheld, and the reachable ones are offered.
        expect(await page.getByRole("button", { name: /^Use this connection/ }).count()).toBe(0);
        expect(await page.getByRole("button", { name: /^Local network/ }).isVisible()).toBe(true);

        await page.getByRole("button", { name: /^Local network/ }).click();
        await page.getByText("Expose the Gateway on your local network").waitFor();
        expect(
          await page.getByText("Every device still has to sign in to the Gateway.").isVisible(),
        ).toBe(true);
        expect(
          await page
            .getByText("A plaintext address issues Limited access instead of full control.")
            .isVisible(),
        ).toBe(true);
        expect(
          await page.getByText("This does not put the Gateway on the public internet.").isVisible(),
        ).toBe(true);
        // Nothing is written before the operator confirms the consequences.
        expect(await gateway.getRequests("config.patch")).toEqual([]);

        await page.getByRole("button", { name: "Expose on local network" }).click();
        const patch = await gateway.waitForRequest("config.patch");
        expect(patch.params).toMatchObject({ baseHash: BASE_CONFIG_HASH, raw: LAN_PATCH });
        await page.getByText("Waiting for the Gateway to restart…").waitFor();

        await gateway.setMethodResponse("device.pair.connectivity.plan", appliedLanPlan);
        await restartGatewayConnection(gateway, page);

        const qr = page.getByAltText("OpenClaw mobile pairing QR code");
        await qr.waitFor({ timeout: 20_000 });
        expect(await qr.getAttribute("src")).toMatch(/^data:image\/png;base64,/u);
        expect(await page.getByText(LAN_URL, { exact: true }).isVisible()).toBe(true);
        // Issuance is pinned to the planned LAN route, not a persisted address.
        expect((await gateway.getRequests("device.pair.setupCode")).map((r) => r.params)).toEqual([
          { mode: "lan" },
        ]);
        // Re-inspection after the restart is what unlocks issuance.
        expect(
          (await gateway.getRequests("device.pair.connectivity.inspect")).length,
        ).toBeGreaterThan(1);

        // The Gateway downgraded the plaintext route to Limited; the collapsed
        // access control adopts and surfaces that recorded fact on the chooser,
        // and the adopted level binds to the next issuance.
        await page.getByRole("button", { name: /New code/ }).click();
        await chooserPrompt.waitFor();
        expect(await accessValue.textContent()).toBe("Limited access");
        await page.getByText("Access level").click();
        expect(await page.getByRole("radio", { name: /Limited access/ }).isChecked()).toBe(true);
        await page.getByRole("button", { name: /^Local network/ }).click();
        await page.getByRole("button", { name: "Expose on local network" }).click();
        await page.getByAltText("OpenClaw mobile pairing QR code").waitFor({ timeout: 20_000 });
        expect((await gateway.getRequests("device.pair.setupCode")).map((r) => r.params)).toEqual([
          { mode: "lan" },
          { bootstrapProfile: "limited", mode: "lan" },
        ]);

        writeFileSync(
          path.join(artifactDir, "behavior-summary.json"),
          `${JSON.stringify(
            {
              configPatches: (await gateway.getRequests("config.patch")).map(
                (request) => request.params,
              ),
              inspections: (await gateway.getRequests("device.pair.connectivity.inspect")).length,
              setupCodesIssued: (await gateway.getRequests("device.pair.setupCode")).length,
            },
            null,
            2,
          )}\n`,
        );
        expect(pageErrors).toEqual([]);
      },
    );
  });

  it("keeps a rejected public address editable and never mints for it", async () => {
    mkdirSync(artifactDir, { recursive: true });
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(String(error)));
        const gateway = await installMockGateway(page, {
          presenceUsers: [{ self: true, id: "operator", name: "Operator" }],
          methodResponses: {
            "device.pair.list": { paired: [], pending: [] },
            "device.pair.connectivity.inspect": loopbackInspection,
            "device.pair.connectivity.plan": blockedPublicPlan,
            "node.list": { nodes: [] },
          },
        });

        await page.goto(`${suite.server.baseUrl}settings/security`);
        await page
          .locator(".security-page")
          .getByRole("button", { name: "Pair mobile device" })
          .click();
        await page.getByRole("dialog", { name: "OpenClaw mobile" }).waitFor();

        await page.getByRole("button", { name: /^Public address/ }).click();
        const input = page.locator('input[name="device-pair-public-url"]');
        await input.waitFor();
        await input.fill("ws://gateway.example.com");

        await page.getByRole("button", { name: "Check address" }).click();
        await page.getByText("Public pairing requires a secure wss:// address.").waitFor();
        expect(await input.inputValue()).toBe("ws://gateway.example.com");
        expect(await gateway.getRequests("device.pair.setupCode")).toEqual([]);
        expect(await gateway.getRequests("config.patch")).toEqual([]);
        expect(pageErrors).toEqual([]);
      },
    );
  });

  it.each(PAIRING_VIEWPORTS)(
    "renders every wizard step at $name width in both themes",
    async (viewport) => {
      mkdirSync(artifactDir, { recursive: true });
      for (const colorScheme of ["light", "dark"] as const) {
        await suite.withPage(
          {
            colorScheme,
            locale: "en-US",
            // Deterministic captures: no entry fade to race against.
            reducedMotion: "reduce",
            serviceWorkers: "block",
            viewport: { height: viewport.height, width: viewport.width },
          },
          async ({ page }) => {
            const capture = async (step: string) => {
              await settleDialog(page);
              await page.screenshot({
                path: path.join(artifactDir, `${step}-${viewport.name}-${colorScheme}.png`),
              });
            };
            const gateway = await installMockGateway(page, {
              presenceUsers: [{ self: true, id: "operator", name: "Operator" }],
              methodResponses: {
                "config.get": {
                  raw: '{\n  "gateway": { "bind": "loopback" }\n}\n',
                  hash: BASE_CONFIG_HASH,
                  path: "/tmp/openclaw.json",
                  config: { gateway: { bind: "loopback" } },
                },
                "config.patch": { ok: true },
                "device.pair.list": { paired: [], pending: [] },
                "device.pair.connectivity.inspect": loopbackInspection,
                "device.pair.connectivity.plan": lanPlan,
                "device.pair.setupCode": await setupCodeResult(),
                "node.list": { nodes: [] },
              },
            });

            await page.goto(`${suite.server.baseUrl}settings/security`);
            await page
              .locator(".security-page")
              .getByRole("button", { name: "Pair mobile device" })
              .click();
            await page.getByRole("dialog", { name: "OpenClaw mobile" }).waitFor();
            await page.getByText("How should this phone reach the Gateway?").waitFor();
            await capture("01-chooser");

            await page.getByText("Access level").click();
            await page.getByRole("radio", { name: /Full access/ }).waitFor();
            await capture("02-chooser-access-open");
            await page.getByText("Access level").click();

            await page.getByRole("button", { name: /^Local network/ }).click();
            await page.getByText("Expose the Gateway on your local network").waitFor();
            await capture("03-lan-review");

            await page.getByRole("button", { name: "Expose on local network" }).click();
            await gateway.waitForRequest("config.patch");
            await page.getByText("Waiting for the Gateway to restart…").waitFor();
            await capture("04-awaiting-restart");

            await gateway.setMethodResponse("device.pair.connectivity.plan", appliedLanPlan);
            await restartGatewayConnection(gateway, page);
            await page.getByAltText("OpenClaw mobile pairing QR code").waitFor({ timeout: 20_000 });
            await capture("05-setup-code");

            // Back to the chooser, then down the public branch of the same flow.
            await page.getByRole("button", { name: /New code/ }).click();
            await page.getByText("How should this phone reach the Gateway?").waitFor();
            await gateway.setMethodResponse("device.pair.connectivity.plan", blockedPublicPlan);
            await page.getByRole("button", { name: /^Public address/ }).click();
            const input = page.locator('input[name="device-pair-public-url"]');
            await input.waitFor();
            await input.fill("ws://gateway.example.com");
            await capture("06-public-url");

            await page.getByRole("button", { name: "Check address" }).click();
            await page.getByText("Public pairing requires a secure wss:// address.").waitFor();
            await capture("07-public-url-rejected");
          },
        );
      }
    },
  );
});
