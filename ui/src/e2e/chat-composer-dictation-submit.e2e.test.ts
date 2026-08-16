import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { installTalkBrowserFixtures } from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI composer dictation submission" });

suite.define(() => {
  it("keeps a dictated transcript with its draft while finalization owns the composer", async () => {
    await suite.withPage({ permissions: ["microphone"] }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "talk.catalog": { transcription: { ready: true } },
          "talk.session.create": {
            sessionId: "dictation-submit-e2e",
            transcriptionSessionId: "dictation-submit-e2e",
            audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
          },
          "talk.session.appendAudio": {},
          "talk.session.close": {},
        },
      });
      await installTalkBrowserFixtures(page);

      await page.goto(`${suite.server.baseUrl}chat`);
      const textarea = page.locator(".agent-chat__input textarea");
      const microphone = page.getByRole("button", { name: "Start voice input" });
      const send = page.getByRole("button", { name: "Send message" });
      await textarea.fill("Existing draft");
      const bounds = await microphone.boundingBox();
      expect(bounds).not.toBeNull();
      if (!bounds) {
        throw new Error("expected microphone button bounds");
      }
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await gateway.waitForRequest("talk.session.create");
      await gateway.emitGatewayEvent("talk.event", {
        transcriptionSessionId: "dictation-submit-e2e",
        type: "transcript",
        text: "dictated ending",
        final: true,
      });
      await page.mouse.up();

      await expect
        .poll(() => page.getByRole("button", { name: "Finishing dictation…" }).isVisible())
        .toBe(true);
      await expect.poll(() => send.isDisabled()).toBe(true);
      await textarea.press("Enter");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await expect.poll(() => textarea.inputValue()).toBe("Existing draft dictated ending");
    });
  });
});
