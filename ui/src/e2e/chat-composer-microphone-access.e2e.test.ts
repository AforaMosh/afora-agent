// Control UI E2E tests cover microphone access across pointer modes and replacement states.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { installTalkBrowserFixtures } from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI composer microphone access",
  browserLaunchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
});

suite.define(() => {
  it("exposes the microphone device picker before Talk starts on touch-only devices", async () => {
    await suite.withPage(
      { hasTouch: true, permissions: ["microphone"], viewport: { width: 320, height: 568 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page);
        await installTalkBrowserFixtures(page);
        await page.goto(`${suite.server.baseUrl}chat`);

        expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
        const picker = page.getByRole("button", { name: "Microphone input" });
        await expect.poll(() => picker.count()).toBe(1);
        const pickerStyle = await picker.evaluate((node) => {
          const style = getComputedStyle(node);
          return {
            opacity: style.opacity,
            pointerEvents: style.pointerEvents,
            width: node.getBoundingClientRect().width,
          };
        });
        expect(pickerStyle).toMatchObject({ opacity: "1", pointerEvents: "auto" });
        expect(pickerStyle.width).toBeGreaterThanOrEqual(20);

        await picker.tap();
        await expect.poll(() => page.getByRole("menuitemradio").count()).toBe(3);
        expect(await gateway.getRequests("talk.client.create")).toHaveLength(0);
      },
    );
  });

  it("keeps keyboard focus on the microphone picker after selecting a device", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      await installMockGateway(page);
      await installTalkBrowserFixtures(page);
      await page.goto(`${suite.server.baseUrl}chat`);

      const picker = page.getByRole("button", { name: "Microphone input" });
      await expect.poll(() => picker.count()).toBe(1);
      for (let index = 0; index < 30; index += 1) {
        if (await picker.evaluate((node) => document.activeElement === node)) {
          break;
        }
        await page.keyboard.press("Tab");
      }
      expect(await picker.evaluate((node) => document.activeElement === node)).toBe(true);

      await page.keyboard.press("Enter");
      await expect.poll(() => page.getByRole("menuitemradio").count()).toBe(3);
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            queueMicrotask(() => requestAnimationFrame(() => resolve()));
          }),
      );

      expect(await picker.evaluate((node) => document.activeElement === node)).toBe(true);
      await page.keyboard.press("Tab");
      const voice = page.getByRole("button", { name: "Start voice input" });
      expect(await voice.evaluate((node) => document.activeElement === node)).toBe(true);
    });
  });

  it("keeps live Talk styling when an active run moves controls into a replacement banner", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const activeRunId = "replacement-banner-active-run";
      const sessionKey = "agent:main:main";
      const session = {
        activeRunIds: [activeRunId],
        archived: false,
        contextTokens: null,
        displayName: "Main",
        hasActiveRun: true,
        key: sessionKey,
        kind: "direct",
        label: "Main",
        model: "gpt-5.5",
        modelProvider: "openai",
        sessionId: "session:main",
        status: "running",
        totalTokens: 0,
        updatedAt: Date.now(),
      };
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.list": {
            count: 1,
            defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
            sessions: [session],
          },
          "talk.client.create": {
            provider: "google",
            voiceSessionId: "replacement-banner-talk",
            transport: "provider-websocket",
            protocol: "google-live-bidi",
            clientSecret: "auth_tokens/replacement-banner-talk",
            websocketUrl:
              "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
            audio: {
              inputEncoding: "pcm16",
              inputSampleRateHz: 16_000,
              outputEncoding: "pcm16",
              outputSampleRateHz: 24_000,
            },
          },
        },
        sessionInfo: session,
        sessionKey,
      });
      await installTalkBrowserFixtures(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByRole("button", { name: "Start voice input" }).click();
      await gateway.waitForRequest("talk.client.create");
      await gateway.deliverLatest({ setupComplete: {} });
      await expect
        .poll(() => page.getByRole("button", { name: "Stop voice input" }).count())
        .toBe(1);

      await gateway.emitGatewayEvent("sessions.changed", {
        ...session,
        agentId: "main",
        archived: true,
        reason: "update",
        sessionKey,
      });
      const banner = page.locator(".agent-chat__disabled-banner");
      await expect.poll(() => banner.count()).toBe(1);
      const liveTalk = banner.getByRole("button", { name: "Stop voice input" });
      await expect.poll(() => liveTalk.count()).toBe(1);
      expect(await page.locator(".agent-chat__input").count()).toBe(0);

      const liveStyle = await liveTalk.evaluate((node) => {
        const style = getComputedStyle(node);
        const glow = getComputedStyle(node, "::after");
        return {
          glowAnimation: glow.animationName,
          minWidth: Number.parseFloat(style.minWidth),
          position: style.position,
          width: node.getBoundingClientRect().width,
        };
      });
      expect(liveStyle.position).toBe("relative");
      expect(liveStyle.minWidth).toBeGreaterThanOrEqual(64);
      expect(liveStyle.width).toBeGreaterThanOrEqual(64);
      expect(liveStyle.glowAnimation).toBe("chat-voice-live-breathe");

      await gateway.closeLatest(1006, "provider unavailable");
      await expect
        .poll(() => liveTalk.getAttribute("class"))
        .toContain("chat-send-btn--voice-error");
      await expect
        .poll(() =>
          liveTalk.evaluate(
            (node) =>
              getComputedStyle(node.querySelector(".chat-send-btn__voice-stop-glyph")!).opacity,
          ),
        )
        .toBe("1");
      expect(
        await liveTalk.evaluate((node) => getComputedStyle(node, "::after").animationName),
      ).toBe("none");
    });
  });
});
