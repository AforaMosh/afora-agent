// Whatsapp tests cover index plugin behavior.
import { describe, expect, it } from "vitest";
import { whatsappPlugin } from "./channel-plugin-api.js";

describe("whatsapp bundled entries", () => {
  it("declares account config as channel-restart reload metadata", () => {
    expect(whatsappPlugin.reload).toEqual({
      configPrefixes: [
        "channels.whatsapp.enabled",
        "channels.whatsapp.accounts",
        "channels.whatsapp.selfChatMode",
      ],
      noopPrefixes: ["channels.whatsapp"],
    });
  });

  it("keeps DM security normalization inside typed WhatsApp identities", () => {
    const resolveDmPolicy = whatsappPlugin.security?.resolveDmPolicy;
    if (!resolveDmPolicy) {
      throw new Error("WhatsApp DM security resolver unavailable");
    }
    const cfg = {
      channels: {
        whatsapp: { dmPolicy: "allowlist", allowFrom: ["+15550001111"] },
      },
    } as never;
    const result = resolveDmPolicy({
      cfg,
      account: whatsappPlugin.config.resolveAccount(cfg, "default"),
    });
    if (!result) {
      throw new Error("WhatsApp DM security policy unavailable");
    }

    expect(result.normalizeEntry?.("signal:+15550001111")).toBe("");
    expect(result.normalizeEntry?.("whatsapp:whatsapp:777@lid")).toBe("777@lid");
    expect(result.normalizeEntry?.("whatsapp:whatsapp:777@hosted.lid")).toBe("777@hosted.lid");
  });
});
