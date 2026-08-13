import { ChannelType, Routes } from "discord-api-types/v10";
// Discord tests cover send.creates thread plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasDiscordMessageCreateAmbiguity } from "./retry.js";
import {
  makeDiscordRest,
  readDiscordRequestBody,
  readDiscordRequestPath,
  type DiscordMockCallSource,
} from "./send.test-harness.js";

vi.mock("openclaw/plugin-sdk/web-media", async () => {
  const { discordWebMediaMockFactory } = await import("./send.test-harness.js");
  return discordWebMediaMockFactory();
});

let createThreadDiscord: typeof import("./send.js").createThreadDiscord;
let discordOutbound: typeof import("./outbound-adapter.js").discordOutbound;
let DiscordThreadInitialMessageError: typeof import("./send.js").DiscordThreadInitialMessageError;
let listThreadsDiscord: typeof import("./send.js").listThreadsDiscord;
let sendMessageDiscord: typeof import("./send.js").sendMessageDiscord;

const DISCORD_TEST_CFG = {
  channels: {
    discord: {
      accounts: {
        default: {},
      },
    },
  },
};

function discordClientOpts(rest: ReturnType<typeof makeDiscordRest>["rest"]) {
  return { cfg: DISCORD_TEST_CFG, rest, token: "t" };
}

const requireRecord = createRequireRecord("object", "expected-label");

function createDiscordForumPayloadHarness(parentType: ChannelType = ChannelType.GuildForum) {
  const parentId = "700";
  const { rest, getMock, postMock } = makeDiscordRest();
  let threadCount = 0;
  let messageCount = 0;

  getMock.mockImplementation(async (path: unknown) => {
    const channelId = String(path).split("/").at(-1);
    return {
      id: channelId,
      type: channelId === parentId ? parentType : ChannelType.PublicThread,
    };
  });
  postMock.mockImplementation(async (path: unknown) => {
    if (path === Routes.threads(parentId)) {
      threadCount += 1;
      const threadId = String(700 + threadCount);
      return {
        id: threadId,
        message: { id: `starter-${threadCount}`, channel_id: threadId },
      };
    }
    const channelId = String(path).split("/").at(-2);
    messageCount += 1;
    return { id: `message-${messageCount}`, channel_id: channelId };
  });

  return {
    parentId,
    postMock,
    run: async (
      payload: { text: string; mediaUrls?: string[] },
      options: {
        threadId?: string;
        onDeliveryResult?: Parameters<
          NonNullable<typeof discordOutbound.sendPayload>
        >[0]["onDeliveryResult"];
      } = {},
    ) =>
      await discordOutbound.sendPayload?.({
        cfg: DISCORD_TEST_CFG,
        to: `channel:${parentId}`,
        text: payload.text,
        payload,
        ...(options.threadId ? { threadId: options.threadId } : {}),
        ...(options.onDeliveryResult ? { onDeliveryResult: options.onDeliveryResult } : {}),
        deps: {
          discord: async (...[target, text, sendOptions]: Parameters<typeof sendMessageDiscord>) =>
            await sendMessageDiscord(target, text, {
              ...sendOptions,
              rest,
              token: "t",
            }),
        },
      }),
  };
}

beforeAll(async () => {
  ({
    createThreadDiscord,
    DiscordThreadInitialMessageError,
    listThreadsDiscord,
    sendMessageDiscord,
  } = await import("./send.js"));
  ({ discordOutbound } = await import("./outbound-adapter.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/web-media");
});

describe("sendMessageDiscord", () => {
  it.each([
    {
      label: "a 2001-character reply",
      payload: { text: "a".repeat(2001) },
      expectedThreadMessages: 1,
    },
    {
      label: "a reply with two image attachments",
      payload: {
        text: "Generated images",
        mediaUrls: ["https://example.com/first.jpg", "https://example.com/second.jpg"],
      },
      expectedThreadMessages: 2,
    },
  ])("keeps $label in one automatically created forum thread", async (testCase) => {
    const { parentId, postMock, run } = createDiscordForumPayloadHarness();
    const onDeliveryResult = vi.fn();

    const result = await run(testCase.payload, { onDeliveryResult });

    const requestPaths = postMock.mock.calls.map((call) => call[0]);
    expect(requestPaths).toEqual([
      Routes.threads(parentId),
      ...Array.from({ length: testCase.expectedThreadMessages }, () =>
        Routes.channelMessages("701"),
      ),
    ]);
    expect(onDeliveryResult.mock.calls.map(([delivery]) => delivery.channelId)).toEqual(
      Array.from({ length: testCase.expectedThreadMessages + 1 }, () => "701"),
    );
    expect(result?.receipt).toMatchObject({
      threadId: "701",
      platformMessageIds: [
        "starter-1",
        ...Array.from(
          { length: testCase.expectedThreadMessages },
          (_, index) => `message-${index + 1}`,
        ),
      ],
    });
  });

  it("keeps chunked regular-channel replies on their original channel", async () => {
    const { parentId, postMock, run } = createDiscordForumPayloadHarness(ChannelType.GuildText);

    const result = await run({ text: "a".repeat(2001) });

    expect(postMock.mock.calls.map((call) => call[0])).toEqual([
      Routes.channelMessages(parentId),
      Routes.channelMessages(parentId),
    ]);
    expect(result?.receipt?.threadId).toBeUndefined();
    expect(result?.receipt?.platformMessageIds).toEqual(["message-2"]);
  });

  it("keeps chunked replies targeted at an explicitly selected thread", async () => {
    const { postMock, run } = createDiscordForumPayloadHarness();

    const result = await run({ text: "a".repeat(2001) }, { threadId: "701" });

    expect(postMock.mock.calls.map((call) => call[0])).toEqual([
      Routes.channelMessages("701"),
      Routes.channelMessages("701"),
    ]);
    expect(result?.receipt?.threadId).toBeUndefined();
    expect(result?.receipt?.platformMessageIds).toEqual(["message-2"]);
  });

  it("does not attempt a follow-up when forum thread creation is rejected", async () => {
    const { parentId, postMock, run } = createDiscordForumPayloadHarness();
    postMock.mockRejectedValueOnce(new Error("missing access"));

    await expect(run({ text: "a".repeat(2001) })).rejects.toThrow("missing access");

    expect(postMock).toHaveBeenCalledOnce();
    expect(postMock.mock.calls[0]?.[0]).toBe(Routes.threads(parentId));
  });

  it("does not send a forum follow-up when delivery bookkeeping rejects the starter", async () => {
    const { parentId, postMock, run } = createDiscordForumPayloadHarness();
    const onDeliveryResult = vi.fn().mockRejectedValue(new Error("delivery bookkeeping failed"));

    await expect(run({ text: "a".repeat(2001) }, { onDeliveryResult })).rejects.toThrow(
      "delivery bookkeeping failed",
    );

    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(postMock.mock.calls.map((call) => call[0])).toEqual([Routes.threads(parentId)]);
  });

  it("creates a thread", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", messageId: "m1" },
      discordClientOpts(rest),
    );
    expect(getMock).not.toHaveBeenCalled();
    expect(readDiscordRequestPath(postMock as unknown as DiscordMockCallSource)).toBe(
      Routes.threads("chan1", "m1"),
    );
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource)).toEqual({
      name: "thread",
    });
  });

  it("creates forum threads with an initial message", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildForum });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord("chan1", { name: "thread" }, discordClientOpts(rest));
    expect(getMock).toHaveBeenCalledWith(Routes.channel("chan1"));
    expect(readDiscordRequestPath(postMock as unknown as DiscordMockCallSource)).toBe(
      Routes.threads("chan1"),
    );
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource)).toEqual({
      name: "thread",
      message: { content: "thread" },
    });
  });

  it("keeps forum starter messages within Discord's content limit", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildForum });
    postMock.mockResolvedValue({ id: "t1" });
    const content = "a".repeat(2001);

    await createThreadDiscord("chan1", { name: "thread", content }, discordClientOpts(rest));

    expect(postMock).toHaveBeenCalledTimes(2);
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource, 0)).toEqual({
      name: "thread",
      message: { content: "a".repeat(2000) },
    });
    expect(readDiscordRequestPath(postMock as unknown as DiscordMockCallSource, 1)).toBe(
      Routes.channelMessages("t1"),
    );
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource, 1)).toMatchObject({
      content: "a",
      enforce_nonce: true,
    });
  });

  it("keeps sub-limit multi-line forum content in one starter message", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildForum });
    postMock.mockResolvedValue({ id: "t1" });
    const content = Array.from({ length: 18 }, (_, index) => `line ${index + 1}`).join("\n");

    await createThreadDiscord("chan1", { name: "thread", content }, discordClientOpts(rest));

    expect(postMock).toHaveBeenCalledTimes(1);
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource)).toEqual({
      name: "thread",
      message: { content },
    });
  });

  it("reports a delivered forum starter when a continuation chunk fails", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildForum });
    postMock
      .mockResolvedValueOnce({ id: "t1", message: { id: "starter1", channel_id: "t1" } })
      .mockRejectedValueOnce(Object.assign(new Error("missing access"), { status: 403 }));

    let thrown: unknown;
    try {
      await createThreadDiscord(
        "chan1",
        { name: "thread", content: "a".repeat(2001) },
        discordClientOpts(rest),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DiscordThreadInitialMessageError);
    expect(requireRecord(thrown, "thread initial message error").initialMessageDelivery).toEqual({
      starterMessageDelivered: true,
      deliveredChunkCount: 1,
      deliveredMessageIds: ["starter1"],
      failedChunkDelivery: "not_delivered",
      failedChunkIndex: 1,
      totalChunkCount: 2,
    });
  });

  it("reports an exhausted ambiguous forum continuation as unknown delivery", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildForum });
    const ambiguous = Object.assign(new Error("response lost"), { status: 502 });
    postMock
      .mockResolvedValueOnce({ id: "t1", message: { id: "starter1", channel_id: "t1" } })
      .mockRejectedValue(ambiguous);

    let thrown: unknown;
    try {
      await createThreadDiscord(
        "chan1",
        { name: "thread", content: "a".repeat(2001) },
        {
          ...discordClientOpts(rest),
          retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(postMock).toHaveBeenCalledTimes(3);
    expect(thrown).toBeInstanceOf(DiscordThreadInitialMessageError);
    expect(hasDiscordMessageCreateAmbiguity(thrown)).toBe(true);
    expect(requireRecord(thrown, "thread initial message error").message).toContain(
      "delivery of the remaining initial content could not be confirmed",
    );
    expect(requireRecord(thrown, "thread initial message error").initialMessageDelivery).toEqual({
      starterMessageDelivered: true,
      deliveredChunkCount: 1,
      deliveredMessageIds: ["starter1"],
      failedChunkDelivery: "unknown",
      failedChunkIndex: 1,
      totalChunkCount: 2,
    });
  });

  it("inherits default_auto_archive_duration for forum threads", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({
      type: ChannelType.GuildForum,
      default_auto_archive_duration: 1440,
    });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord("chan1", { name: "thread" }, discordClientOpts(rest));
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource)).toEqual({
      name: "thread",
      auto_archive_duration: 1440,
      message: { content: "thread" },
    });
  });

  it("inherits default_auto_archive_duration for text-channel threads", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({
      type: ChannelType.GuildText,
      default_auto_archive_duration: 10080,
    });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord("chan1", { name: "thread" }, discordClientOpts(rest));
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource)).toEqual({
      name: "thread",
      auto_archive_duration: 10080,
      type: ChannelType.PublicThread,
    });
  });

  it("prefers explicit autoArchiveMinutes over channel default", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({
      type: ChannelType.GuildForum,
      default_auto_archive_duration: 1440,
    });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", autoArchiveMinutes: 4320 },
      discordClientOpts(rest),
    );
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource)).toEqual({
      name: "thread",
      auto_archive_duration: 4320,
      message: { content: "thread" },
    });
  });

  it("preserves explicit autoArchiveMinutes for message-attached threads", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", messageId: "m1", autoArchiveMinutes: 4320 },
      discordClientOpts(rest),
    );
    expect(getMock).not.toHaveBeenCalled();
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource)).toEqual({
      name: "thread",
      auto_archive_duration: 4320,
    });
  });

  it("creates media threads with provided content", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildMedia });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", content: "initial forum post" },
      discordClientOpts(rest),
    );
    expect(readDiscordRequestPath(postMock as unknown as DiscordMockCallSource)).toBe(
      Routes.threads("chan1"),
    );
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource)).toEqual({
      name: "thread",
      message: { content: "initial forum post" },
    });
  });

  it("passes applied_tags for forum threads", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildForum });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "tagged post", appliedTags: ["tag1", "tag2"] },
      discordClientOpts(rest),
    );
    expect(readDiscordRequestPath(postMock as unknown as DiscordMockCallSource)).toBe(
      Routes.threads("chan1"),
    );
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource)).toEqual({
      name: "tagged post",
      message: { content: "tagged post" },
      applied_tags: ["tag1", "tag2"],
    });
  });

  it("omits applied_tags for non-forum threads", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", appliedTags: ["tag1"] },
      discordClientOpts(rest),
    );
    expect(readDiscordRequestPath(postMock as unknown as DiscordMockCallSource)).toBe(
      Routes.threads("chan1"),
    );
    expect(
      "applied_tags" in readDiscordRequestBody(postMock as unknown as DiscordMockCallSource),
    ).toBe(false);
  });

  it("falls back when channel lookup is unavailable", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockRejectedValue(new Error("lookup failed"));
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord("chan1", { name: "thread" }, discordClientOpts(rest));
    expect(readDiscordRequestPath(postMock as unknown as DiscordMockCallSource)).toBe(
      Routes.threads("chan1"),
    );
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource).name).toBe(
      "thread",
    );
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource).type).toBe(
      ChannelType.PublicThread,
    );
  });

  it("respects explicit thread type for standalone threads", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", type: ChannelType.PrivateThread },
      discordClientOpts(rest),
    );
    expect(getMock).toHaveBeenCalledWith(Routes.channel("chan1"));
    expect(readDiscordRequestPath(postMock as unknown as DiscordMockCallSource)).toBe(
      Routes.threads("chan1"),
    );
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource).name).toBe(
      "thread",
    );
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource).type).toBe(
      ChannelType.PrivateThread,
    );
  });

  it("sends initial message for non-forum threads with content", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", content: "Hello thread!" },
      discordClientOpts(rest),
    );
    expect(postMock).toHaveBeenCalledTimes(2);
    // First call: create thread
    expect(readDiscordRequestPath(postMock as unknown as DiscordMockCallSource, 0)).toBe(
      Routes.threads("chan1"),
    );
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource, 0).name).toBe(
      "thread",
    );
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource, 0).type).toBe(
      ChannelType.PublicThread,
    );
    // Second call: send message to thread
    expect(readDiscordRequestPath(postMock as unknown as DiscordMockCallSource, 1)).toBe(
      Routes.channelMessages("t1"),
    );
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource, 1)).toMatchObject({
      content: "Hello thread!",
      enforce_nonce: true,
    });
  });

  it("chunks long initial messages for non-forum threads", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({ id: "t1" });
    const content = "a".repeat(2001);

    await createThreadDiscord("chan1", { name: "thread", content }, discordClientOpts(rest));

    expect(postMock).toHaveBeenCalledTimes(3);
    expect(readDiscordRequestPath(postMock as unknown as DiscordMockCallSource, 1)).toBe(
      Routes.channelMessages("t1"),
    );
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource, 1)).toMatchObject({
      content: "a".repeat(2000),
      enforce_nonce: true,
    });
    expect(readDiscordRequestPath(postMock as unknown as DiscordMockCallSource, 2)).toBe(
      Routes.channelMessages("t1"),
    );
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource, 2)).toMatchObject({
      content: "a",
      enforce_nonce: true,
    });
  });

  it("keeps sub-limit multi-line non-forum content in one initial message", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });
    postMock.mockResolvedValue({ id: "t1", channel_id: "t1" });
    const content = Array.from({ length: 18 }, (_, index) => `line ${index + 1}`).join("\n");

    await createThreadDiscord("chan1", { name: "thread", content }, discordClientOpts(rest));

    expect(postMock).toHaveBeenCalledTimes(2);
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource, 1)).toMatchObject({
      content,
    });
  });

  it("reports delivered non-forum chunks when a later chunk fails", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });
    postMock
      .mockResolvedValueOnce({ id: "t1", name: "thread", type: ChannelType.PublicThread })
      .mockResolvedValueOnce({ id: "msg1", channel_id: "t1" })
      .mockRejectedValueOnce(Object.assign(new Error("missing access"), { status: 403 }));

    let thrown: unknown;
    try {
      await createThreadDiscord(
        "chan1",
        { name: "thread", content: "a".repeat(4001) },
        discordClientOpts(rest),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DiscordThreadInitialMessageError);
    expect(requireRecord(thrown, "thread initial message error").initialMessageDelivery).toEqual({
      starterMessageDelivered: false,
      deliveredChunkCount: 1,
      deliveredMessageIds: ["msg1"],
      failedChunkDelivery: "not_delivered",
      failedChunkIndex: 1,
      totalChunkCount: 3,
    });
  });

  it("reports an exhausted ambiguous non-forum chunk as unknown delivery", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });
    const ambiguous = Object.assign(new Error("response lost"), { status: 502 });
    postMock
      .mockResolvedValueOnce({ id: "t1", name: "thread", type: ChannelType.PublicThread })
      .mockResolvedValueOnce({ id: "msg1", channel_id: "t1" })
      .mockRejectedValue(ambiguous);

    let thrown: unknown;
    try {
      await createThreadDiscord(
        "chan1",
        { name: "thread", content: "a".repeat(4001) },
        {
          ...discordClientOpts(rest),
          retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(postMock).toHaveBeenCalledTimes(4);
    expect(thrown).toBeInstanceOf(DiscordThreadInitialMessageError);
    expect(hasDiscordMessageCreateAmbiguity(thrown)).toBe(true);
    expect(requireRecord(thrown, "thread initial message error").message).toContain(
      "delivery of the remaining initial content could not be confirmed",
    );
    expect(requireRecord(thrown, "thread initial message error").initialMessageDelivery).toEqual({
      starterMessageDelivered: false,
      deliveredChunkCount: 1,
      deliveredMessageIds: ["msg1"],
      failedChunkDelivery: "unknown",
      failedChunkIndex: 1,
      totalChunkCount: 3,
    });
  });

  it("retries continuation sends with a stable nonce per chunk", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });
    postMock
      .mockResolvedValueOnce({ id: "t1", name: "thread", type: ChannelType.PublicThread })
      .mockRejectedValueOnce(Object.assign(new Error("bad gateway"), { status: 502 }))
      .mockResolvedValueOnce({ id: "msg1", channel_id: "t1" })
      .mockResolvedValueOnce({ id: "msg2", channel_id: "t1" });

    await createThreadDiscord(
      "chan1",
      { name: "thread", content: "a".repeat(2001) },
      {
        ...discordClientOpts(rest),
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      },
    );

    expect(postMock).toHaveBeenCalledTimes(4);
    const firstAttempt = readDiscordRequestBody(postMock as unknown as DiscordMockCallSource, 1);
    const retryAttempt = readDiscordRequestBody(postMock as unknown as DiscordMockCallSource, 2);
    const nextChunk = readDiscordRequestBody(postMock as unknown as DiscordMockCallSource, 3);
    expect(firstAttempt.enforce_nonce).toBe(true);
    expect(retryAttempt.nonce).toBe(firstAttempt.nonce);
    expect(nextChunk.enforce_nonce).toBe(true);
    expect(nextChunk.nonce).not.toBe(firstAttempt.nonce);
  });

  it("keeps created non-forum thread details when initial message send fails", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });
    postMock
      .mockResolvedValueOnce({ id: "t1", name: "thread", type: ChannelType.PublicThread })
      .mockRejectedValueOnce(new Error("missing access"));

    let thrown: unknown;
    try {
      await createThreadDiscord(
        "chan1",
        { name: "thread", content: "Hello thread!" },
        discordClientOpts(rest),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DiscordThreadInitialMessageError);
    const error = requireRecord(thrown, "thread initial message error");
    expect(error.name).toBe("DiscordThreadInitialMessageError");
    expect(error.message).toContain("initial message delivery could not be confirmed");
    expect(error.initialMessageError).toBe("missing access");
    expect(error.thread).toEqual({ id: "t1", name: "thread", type: ChannelType.PublicThread });
  });

  it("sends initial message for message-attached threads with content", async () => {
    const { rest, getMock, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "t1" });
    await createThreadDiscord(
      "chan1",
      { name: "thread", messageId: "m1", content: "Discussion here" },
      discordClientOpts(rest),
    );
    // Should not detect channel type for message-attached threads
    expect(getMock).not.toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledTimes(2);
    // First call: create thread from message
    expect(readDiscordRequestPath(postMock as unknown as DiscordMockCallSource, 0)).toBe(
      Routes.threads("chan1", "m1"),
    );
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource, 0)).toEqual({
      name: "thread",
    });
    // Second call: send message to thread
    expect(readDiscordRequestPath(postMock as unknown as DiscordMockCallSource, 1)).toBe(
      Routes.channelMessages("t1"),
    );
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource, 1)).toMatchObject({
      content: "Discussion here",
      enforce_nonce: true,
    });
  });

  it("lists active threads by guild", async () => {
    const { rest, getMock } = makeDiscordRest();
    getMock.mockResolvedValue({ threads: [] });
    await listThreadsDiscord({ guildId: "g1" }, discordClientOpts(rest));
    expect(getMock).toHaveBeenCalledWith(Routes.guildActiveThreads("g1"));
  });
});
