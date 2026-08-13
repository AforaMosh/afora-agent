import { Routes } from "discord-api-types/v10";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

let listGuildEmojisDiscord: typeof import("./send.emojis-stickers.js").listGuildEmojisDiscord;
let uploadEmojiDiscord: typeof import("./send.emojis-stickers.js").uploadEmojiDiscord;
let uploadStickerDiscord: typeof import("./send.emojis-stickers.js").uploadStickerDiscord;

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

beforeAll(async () => {
  ({ listGuildEmojisDiscord, uploadEmojiDiscord, uploadStickerDiscord } =
    await import("./send.emojis-stickers.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/web-media");
});

describe("listGuildEmojisDiscord", () => {
  it("lists emojis for a guild", async () => {
    const { rest, getMock } = makeDiscordRest();
    getMock.mockResolvedValue([{ id: "e1", name: "party" }]);

    await listGuildEmojisDiscord("g1", discordClientOpts(rest));

    expect(getMock).toHaveBeenCalledWith(Routes.guildEmojis("g1"));
  });
});

describe("uploadEmojiDiscord", () => {
  it("uploads emoji assets", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "e1" });

    await uploadEmojiDiscord(
      {
        guildId: "g1",
        name: "party_blob",
        mediaUrl: "file:///tmp/party.png",
        roleIds: ["r1"],
      },
      discordClientOpts(rest),
    );

    expect(readDiscordRequestPath(postMock as unknown as DiscordMockCallSource)).toBe(
      Routes.guildEmojis("g1"),
    );
    expect(readDiscordRequestBody(postMock as unknown as DiscordMockCallSource)).toEqual({
      name: "party_blob",
      image: "data:image/png;base64,aW1n",
      roles: ["r1"],
    });
    expect(loadWebMediaRaw).toHaveBeenCalledWith("file:///tmp/party.png", 256 * 1024);
  });
});

describe("uploadStickerDiscord", () => {
  it("uploads sticker assets", async () => {
    const { rest, postMock } = makeDiscordRest();
    postMock.mockResolvedValue({ id: "s1" });

    await uploadStickerDiscord(
      {
        guildId: "g1",
        name: "openclaw_wave",
        description: "OpenClaw waving",
        tags: "👋",
        mediaUrl: "file:///tmp/wave.png",
      },
      discordClientOpts(rest),
    );

    expect(readDiscordRequestPath(postMock as unknown as DiscordMockCallSource)).toBe(
      Routes.guildStickers("g1"),
    );
    const stickerBody = readDiscordRequestBody(postMock as unknown as DiscordMockCallSource);
    expect(stickerBody.name).toBe("openclaw_wave");
    expect(stickerBody.description).toBe("OpenClaw waving");
    expect(stickerBody.tags).toBe("👋");
    const files = stickerBody.files as Array<{ name?: string; contentType?: string }>;
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("asset.png");
    expect(files[0]?.contentType).toBe("image/png");
    expect(loadWebMediaRaw).toHaveBeenCalledWith("file:///tmp/wave.png", 512 * 1024);
  });
});
