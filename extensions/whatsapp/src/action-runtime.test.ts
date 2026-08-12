// Whatsapp tests cover action runtime plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleWhatsAppAction, whatsAppActionRuntime } from "./action-runtime.js";
import { createWebSendApi } from "./inbound/send-api.js";

const originalWhatsAppActionRuntime = { ...whatsAppActionRuntime };
const sendReactionWhatsApp = vi.fn(async () => undefined);

const enabledConfig = {
  channels: { whatsapp: { actions: { reactions: true } } },
} as OpenClawConfig;

describe("handleWhatsAppAction", () => {
  function reactionConfig(reactionLevel: "minimal" | "extensive" | "off" | "ack"): OpenClawConfig {
    return {
      channels: { whatsapp: { actions: { reactions: true }, reactionLevel } },
    } as OpenClawConfig;
  }

  function expectLastReactionSend(expected: {
    chat: string;
    messageId: string;
    emoji: string;
    accountId: string;
    fromMe?: boolean;
    participant?: string;
  }) {
    const calls = sendReactionWhatsApp.mock.calls as unknown[][];
    const call = calls.at(-1);
    if (!call) {
      throw new Error("expected WhatsApp reaction send");
    }
    expect(call[0]).toBe(expected.chat);
    expect(call[1]).toBe(expected.messageId);
    expect(call[2]).toBe(expected.emoji);
    const options = call[3] as {
      verbose?: unknown;
      fromMe?: unknown;
      participant?: unknown;
      accountId?: unknown;
    };
    expect(options.verbose).toBe(false);
    expect(options.fromMe).toBe(expected.fromMe);
    expect(options.participant).toBe(expected.participant);
    expect(options.accountId).toBe(expected.accountId);
  }

  function installRealReactionSendBoundary() {
    const nativeSendMessage = vi.fn(async () => ({ key: { id: "native-reaction" } }) as never);
    const api = createWebSendApi({
      sock: {
        sendMessage: nativeSendMessage,
        sendPresenceUpdate: vi.fn(async () => undefined),
      },
      defaultAccountId: DEFAULT_ACCOUNT_ID,
    });
    Object.assign(whatsAppActionRuntime, {
      sendReactionWhatsApp: async (
        chatJid: string,
        messageId: string,
        emoji: string,
        options: { fromMe?: boolean; participant?: string },
      ) => {
        await api.sendReaction(
          chatJid,
          messageId,
          emoji,
          options.fromMe ?? false,
          options.participant,
        );
      },
    });
    return nativeSendMessage;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(whatsAppActionRuntime, originalWhatsAppActionRuntime, {
      sendReactionWhatsApp,
    });
  });

  it("adds reactions", async () => {
    await handleWhatsAppAction(
      {
        action: "react",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        emoji: "✅",
      },
      enabledConfig,
    );
    expectLastReactionSend({
      chat: "+123",
      messageId: "msg1",
      emoji: "✅",
      accountId: DEFAULT_ACCOUNT_ID,
    });
  });

  it("adds reactions when reactionLevel is minimal", async () => {
    await handleWhatsAppAction(
      {
        action: "react",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        emoji: "✅",
      },
      reactionConfig("minimal"),
    );
    expectLastReactionSend({
      chat: "+123",
      messageId: "msg1",
      emoji: "✅",
      accountId: DEFAULT_ACCOUNT_ID,
    });
  });

  it("adds reactions when reactionLevel is extensive", async () => {
    await handleWhatsAppAction(
      {
        action: "react",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        emoji: "✅",
      },
      reactionConfig("extensive"),
    );
    expectLastReactionSend({
      chat: "+123",
      messageId: "msg1",
      emoji: "✅",
      accountId: DEFAULT_ACCOUNT_ID,
    });
  });

  it("removes reactions on empty emoji", async () => {
    await handleWhatsAppAction(
      {
        action: "react",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        emoji: "",
      },
      enabledConfig,
    );
    expectLastReactionSend({
      chat: "+123",
      messageId: "msg1",
      emoji: "",
      accountId: DEFAULT_ACCOUNT_ID,
    });
  });

  it("removes reactions when remove flag set", async () => {
    await handleWhatsAppAction(
      {
        action: "react",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        emoji: "✅",
        remove: true,
      },
      enabledConfig,
    );
    expectLastReactionSend({
      chat: "+123",
      messageId: "msg1",
      emoji: "",
      accountId: DEFAULT_ACCOUNT_ID,
    });
  });

  it("passes account scope and sender flags", async () => {
    await handleWhatsAppAction(
      {
        action: "react",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        emoji: "🎉",
        accountId: "work",
        fromMe: true,
        participant: "999@s.whatsapp.net",
      },
      enabledConfig,
    );
    expectLastReactionSend({
      chat: "+123",
      messageId: "msg1",
      emoji: "🎉",
      accountId: "work",
      fromMe: true,
      participant: "999@s.whatsapp.net",
    });
  });

  it("preserves LID participant ids when forwarding reactions", async () => {
    await handleWhatsAppAction(
      {
        action: "react",
        chatJid: "12345@g.us",
        messageId: "msg1",
        emoji: "🎉",
        participant: "123@lid",
      },
      enabledConfig,
    );
    expectLastReactionSend({
      chat: "12345@g.us",
      messageId: "msg1",
      emoji: "🎉",
      accountId: DEFAULT_ACCOUNT_ID,
      participant: "123@lid",
    });
  });

  it.each([
    "\u00a0+1555\u00a0",
    "\ufeff+1555\ufeff",
    "\u2028+1555\u2028",
    "\n+1555",
    "+1555\t",
    "telegram:+1555",
    "1555@example.com",
  ])("rejects unsafe or malformed chatJid %j before native send", async (chatJid) => {
    const nativeSendMessage = installRealReactionSendBoundary();

    await expect(
      handleWhatsAppAction(
        { action: "react", chatJid, messageId: "msg1", emoji: "✅" },
        enabledConfig,
      ),
    ).rejects.toThrow();
    expect(nativeSendMessage).not.toHaveBeenCalled();
  });

  it.each([
    "\u00a0999@s.whatsapp.net\u00a0",
    "\ufeff999@lid\ufeff",
    "\u2028999@hosted.lid\u2028",
    "\n999@s.whatsapp.net",
    "999@lid\t",
    "telegram:+1999",
    "999@example.com",
  ])("rejects unsafe or malformed participant %j before native send", async (participant) => {
    const nativeSendMessage = installRealReactionSendBoundary();

    await expect(
      handleWhatsAppAction(
        {
          action: "react",
          chatJid: "12345@g.us",
          messageId: "msg1",
          emoji: "✅",
          participant,
        },
        enabledConfig,
      ),
    ).rejects.toThrow(
      "Invalid WhatsApp target; use an E.164 phone number or a supported WhatsApp JID",
    );
    expect(nativeSendMessage).not.toHaveBeenCalled();
  });

  it("allows ASCII-spaced targets while retaining unrelated field trimming", async () => {
    const nativeSendMessage = installRealReactionSendBoundary();

    await handleWhatsAppAction(
      {
        action: " react ",
        chatJid: "  +1 (555) 123-4567  ",
        messageId: "  msg1  ",
        emoji: "✅",
        participant: "  +1 (999) 555-0000  ",
      },
      enabledConfig,
    );

    expect(nativeSendMessage).toHaveBeenCalledWith("15551234567@s.whatsapp.net", {
      react: {
        text: "✅",
        key: {
          remoteJid: "15551234567@s.whatsapp.net",
          id: "msg1",
          fromMe: false,
          participant: "19995550000@s.whatsapp.net",
        },
      },
    });
  });

  it("respects reaction gating", async () => {
    const cfg = {
      channels: { whatsapp: { actions: { reactions: false } } },
    } as OpenClawConfig;
    await expect(
      handleWhatsAppAction(
        {
          action: "react",
          chatJid: "123@s.whatsapp.net",
          messageId: "msg1",
          emoji: "✅",
        },
        cfg,
      ),
    ).rejects.toThrow(/WhatsApp reactions are disabled/);
  });

  it("disables reactions when WhatsApp is not configured", async () => {
    await expect(
      handleWhatsAppAction(
        {
          action: "react",
          chatJid: "123@s.whatsapp.net",
          messageId: "msg1",
          emoji: "✅",
        },
        {} as OpenClawConfig,
      ),
    ).rejects.toThrow(/WhatsApp reactions are disabled/);
  });

  it("prefers the action gate error when both actions.reactions and reactionLevel disable reactions", async () => {
    const cfg = {
      channels: { whatsapp: { actions: { reactions: false }, reactionLevel: "ack" } },
    } as OpenClawConfig;

    await expect(
      handleWhatsAppAction(
        {
          action: "react",
          chatJid: "123@s.whatsapp.net",
          messageId: "msg1",
          emoji: "✅",
        },
        cfg,
      ),
    ).rejects.toThrow(/WhatsApp reactions are disabled/);
    expect(sendReactionWhatsApp).not.toHaveBeenCalled();
  });

  it.each(["off", "ack"] as const)(
    "blocks agent reactions when reactionLevel is %s",
    async (reactionLevel) => {
      await expect(
        handleWhatsAppAction(
          {
            action: "react",
            chatJid: "123@s.whatsapp.net",
            messageId: "msg1",
            emoji: "✅",
          },
          reactionConfig(reactionLevel),
        ),
      ).rejects.toThrow(
        new RegExp(`WhatsApp agent reactions disabled \\(reactionLevel="${reactionLevel}"\\)`),
      );
      expect(sendReactionWhatsApp).not.toHaveBeenCalled();
    },
  );

  it("applies default account allowFrom when accountId is omitted", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          actions: { reactions: true },
          allowFrom: ["111@s.whatsapp.net"],
          accounts: {
            [DEFAULT_ACCOUNT_ID]: {
              allowFrom: ["222@s.whatsapp.net"],
            },
          },
        },
      },
    } as OpenClawConfig;

    try {
      await handleWhatsAppAction(
        {
          action: "react",
          chatJid: "111@s.whatsapp.net",
          messageId: "msg1",
          emoji: "✅",
        },
        cfg,
      );
      throw new Error("expected WhatsApp action authorization error");
    } catch (error) {
      expect((error as { name?: unknown }).name).toBe("ToolAuthorizationError");
      expect((error as { status?: unknown }).status).toBe(403);
    }
  });

  it("routes to resolved default account when no accountId is provided", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          actions: { reactions: true },
          accounts: {
            work: {
              allowFrom: ["123@s.whatsapp.net"],
            },
          },
        },
      },
    } as OpenClawConfig;

    await handleWhatsAppAction(
      {
        action: "react",
        chatJid: "123@s.whatsapp.net",
        messageId: "msg1",
        emoji: "✅",
      },
      cfg,
    );

    expectLastReactionSend({
      chat: "+123",
      messageId: "msg1",
      emoji: "✅",
      accountId: "work",
    });
  });
});
