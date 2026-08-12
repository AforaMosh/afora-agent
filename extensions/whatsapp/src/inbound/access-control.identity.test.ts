// Whatsapp tests cover typed direct identity access decisions.
import { beforeAll, describe, expect, it } from "vitest";
import type { AcceptedInboundAccessControlResult } from "./access-control.js";
import {
  getAccessControlTestConfig,
  sendMessageMock,
  setAccessControlTestConfig,
  setupAccessControlTestHarness,
  upsertPairingRequestMock,
} from "./access-control.test-harness.js";
import { createTestWebInboundMessage } from "./test-message.test-helper.js";

setupAccessControlTestHarness();
let checkInboundAccessControl: typeof import("./access-control.js").checkInboundAccessControl;
let resolveWhatsAppCommandAuthorized: typeof import("../inbound-policy.js").resolveWhatsAppCommandAuthorized;

beforeAll(async () => {
  ({ checkInboundAccessControl } = await import("./access-control.js"));
  ({ resolveWhatsAppCommandAuthorized } = await import("../inbound-policy.js"));
});

async function checkMappedLidSelf(params: { selfChatMode?: boolean; senderE164: string }) {
  setAccessControlTestConfig({
    channels: {
      whatsapp: {
        dmPolicy: "pairing",
        allowFrom: ["+15550001111"],
        ...(params.selfChatMode === undefined ? {} : { selfChatMode: params.selfChatMode }),
      },
    },
  });
  return await checkInboundAccessControl({
    cfg: getAccessControlTestConfig() as never,
    accountId: "default",
    from: "999@lid",
    selfE164: "+15550009999",
    senderE164: params.senderE164,
    senderJid: "999@lid",
    group: false,
    pushName: "Owner",
    isFromMe: true,
    sock: { sendMessage: sendMessageMock },
    remoteJid: "999@lid",
  });
}

describe("typed WhatsApp direct identity access", () => {
  it.each([
    "telegram:1555",
    "sms:+1555",
    "signal_:+1555",
    "whatsapp:signal_:+1555",
    "signal.:+1555",
    "signal/:+1555",
    "other channel:+1555",
  ])("does not authorize +1555 through foreign identity %s", async (allowFrom) => {
    setAccessControlTestConfig({
      channels: { whatsapp: { dmPolicy: "allowlist", allowFrom: [allowFrom] } },
    });
    await expect(
      checkInboundAccessControl({
        cfg: getAccessControlTestConfig() as never,
        accountId: "default",
        from: "+1555",
        selfE164: "+1999",
        senderE164: "+1555",
        senderJid: "1555@s.whatsapp.net",
        group: false,
        isFromMe: false,
        sock: { sendMessage: sendMessageMock },
        remoteJid: "1555@s.whatsapp.net",
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it.each([
    { name: "omitted", selfChatMode: undefined },
    { name: "enabled", selfChatMode: true },
  ])(
    "admits a mapped LID self-chat through its phone alias when self-chat is $name",
    async ({ selfChatMode }) => {
      const result = await checkMappedLidSelf({ selfChatMode, senderE164: "+15550009999" });
      expect(result.allowed).toBe(true);
      if (!result.allowed) {
        throw new Error("expected mapped LID self-chat admission");
      }
      const accepted: AcceptedInboundAccessControlResult = result;
      expect(accepted.admission.sender).toEqual({ id: "999@lid", isSamePhone: true });
      await expect(
        resolveWhatsAppCommandAuthorized({
          cfg: getAccessControlTestConfig() as never,
          msg: createTestWebInboundMessage({
            event: { id: "cmd-mapped-self-lid" },
            payload: { body: "/status" },
            platform: {
              chatJid: "999@lid",
              recipientJid: "+15550009999",
              sender: { lid: "999@lid", e164: "+15550009999" },
              senderJid: "999@lid",
              senderE164: "+15550009999",
              selfE164: "+15550009999",
            },
            admission: {
              accountId: "default",
              conversation: { kind: "direct", id: "999@lid" },
              sender: { id: "999@lid" },
            },
          }) as never,
        }),
      ).resolves.toBe(true);
      expect(upsertPairingRequestMock).not.toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();
    },
  );

  it("does not grant mapped-LID self access through an unrelated phone alias", async () => {
    await expect(
      checkMappedLidSelf({ selfChatMode: true, senderE164: "+15550008888" }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("blocks a mapped-LID self-chat when self-chat mode is disabled", async () => {
    await expect(
      checkMappedLidSelf({ selfChatMode: false, senderE164: "+15550009999" }),
    ).resolves.toMatchObject({ allowed: false });
  });
});
