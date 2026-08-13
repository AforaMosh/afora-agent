import { MessageFlags, Routes } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendPollDiscord, sendStickerDiscord } from "./send.outbound.js";
import {
  makeDiscordRest,
  readDiscordRequestBody,
  readDiscordRequestPath,
  type DiscordMockCallSource,
} from "./send.test-harness.js";

const DISCORD_TEST_CFG = {
  channels: {
    discord: {
      accounts: {
        default: {},
      },
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendStickerDiscord", () => {
  it("sends sticker payloads", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "msg1", channel_id: "789" });

    const result = await sendStickerDiscord("channel:789", ["123"], {
      cfg: DISCORD_TEST_CFG,
      rest,
      token: "t",
      content: "hiya",
    });

    expect(result.messageId).toBe("msg1");
    expect(result.channelId).toBe("789");
    expect(result.receipt.parts[0]?.platformMessageId).toBe("msg1");
    expect(result.receipt.parts[0]?.kind).toBe("card");
    expect(readDiscordRequestPath(postMock as unknown as DiscordMockCallSource)).toBe(
      Routes.channelMessages("789"),
    );
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource)).toMatchObject({
      content: "hiya",
      flags: MessageFlags.SuppressEmbeds,
      sticker_ids: ["123"],
      enforce_nonce: true,
    });
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource).nonce).toMatch(
      /^[0-9a-f]{24}$/,
    );
  });

  it("allows sticker content link embeds when disabled", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "msg1", channel_id: "789" });

    await sendStickerDiscord("channel:789", ["123"], {
      cfg: DISCORD_TEST_CFG,
      rest,
      token: "t",
      content: "https://example.com",
      suppressEmbeds: false,
    });

    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource)).toMatchObject({
      content: "https://example.com",
      sticker_ids: ["123"],
      enforce_nonce: true,
    });
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource).nonce).toMatch(
      /^[0-9a-f]{24}$/,
    );
  });

  it("reuses a single nonce across a retried 502 for stickers", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock
      .mockRejectedValueOnce(Object.assign(new Error("bad gateway"), { status: 502 }))
      .mockResolvedValueOnce({ id: "msg1", channel_id: "789" });

    await sendStickerDiscord("channel:789", ["123"], {
      cfg: DISCORD_TEST_CFG,
      rest,
      token: "t",
      content: "hiya",
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    expect(postMock).toHaveBeenCalledTimes(2);
    const firstNonce = readDiscordRequestBody(
      postMock as unknown as DiscordMockCallSource,
      0,
    ).nonce;
    const secondNonce = readDiscordRequestBody(
      postMock as unknown as DiscordMockCallSource,
      1,
    ).nonce;
    expect(firstNonce).toMatch(/^[0-9a-f]{24}$/);
    expect(secondNonce).toBe(firstNonce);
  });
});

describe("sendPollDiscord", () => {
  it("sends polls with answers", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "msg1", channel_id: "789" });

    const result = await sendPollDiscord(
      "channel:789",
      {
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
      },
      {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
      },
    );

    expect(result.messageId).toBe("msg1");
    expect(result.channelId).toBe("789");
    expect(result.receipt.parts[0]?.platformMessageId).toBe("msg1");
    expect(result.receipt.parts[0]?.kind).toBe("card");
    expect(readDiscordRequestPath(postMock as unknown as DiscordMockCallSource)).toBe(
      Routes.channelMessages("789"),
    );
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource).flags).toBe(
      MessageFlags.SuppressEmbeds,
    );
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource).poll).toEqual({
      question: { text: "Lunch?" },
      answers: [{ poll_media: { text: "Pizza" } }, { poll_media: { text: "Sushi" } }],
      duration: 24,
      allow_multiselect: false,
      layout_type: 1,
    });
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource)).toMatchObject({
      enforce_nonce: true,
    });
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource).nonce).toMatch(
      /^[0-9a-f]{24}$/,
    );
  });

  it("reuses a single nonce across a retried 502 for polls", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock
      .mockRejectedValueOnce(Object.assign(new Error("bad gateway"), { status: 502 }))
      .mockResolvedValueOnce({ id: "msg1", channel_id: "789" });

    await sendPollDiscord(
      "channel:789",
      {
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
      },
      {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      },
    );

    expect(postMock).toHaveBeenCalledTimes(2);
    const firstNonce = readDiscordRequestBody(
      postMock as unknown as DiscordMockCallSource,
      0,
    ).nonce;
    const secondNonce = readDiscordRequestBody(
      postMock as unknown as DiscordMockCallSource,
      1,
    ).nonce;
    expect(firstNonce).toMatch(/^[0-9a-f]{24}$/);
    expect(secondNonce).toBe(firstNonce);
  });

  it("combines silent and suppress-embeds flags for polls", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "msg1", channel_id: "789" });

    await sendPollDiscord(
      "channel:789",
      {
        question: "Lunch?",
        options: ["Pizza", "Sushi"],
      },
      {
        cfg: DISCORD_TEST_CFG,
        rest,
        token: "t",
        content: "https://example.com",
        silent: true,
      },
    );

    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource).flags).toBe(
      MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications,
    );
  });
});
