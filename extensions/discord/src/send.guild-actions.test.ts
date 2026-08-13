import { Routes } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addRoleDiscord,
  banMemberDiscord,
  removeRoleDiscord,
  timeoutMemberDiscord,
} from "./send.guild.js";
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

function discordClientOpts(rest: ReturnType<typeof makeDiscordRest>["rest"]) {
  return { cfg: DISCORD_TEST_CFG, rest, token: "t" };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Discord guild member actions", () => {
  it("times out a member", async () => {
    const { rest, patchMock } = makeDiscordRest();
    patchMock.mockResolvedValue({ id: "m1" });

    await timeoutMemberDiscord(
      { guildId: "g1", userId: "u1", durationMinutes: 10 },
      discordClientOpts(rest),
    );

    expect(readDiscordRequestPath(patchMock as unknown as DiscordMockCallSource)).toBe(
      Routes.guildMember("g1", "u1"),
    );
    expect(
      readDiscordRequestBody(patchMock as unknown as DiscordMockCallSource)
        .communication_disabled_until,
    ).toBeTypeOf("string");
  });

  it("rejects timeout durations outside Date range", async () => {
    const { rest, patchMock } = makeDiscordRest();

    await expect(
      timeoutMemberDiscord(
        { guildId: "g1", userId: "u1", durationMinutes: 8_640_000_000_000_001 },
        discordClientOpts(rest),
      ),
    ).rejects.toThrow("Discord timeout duration is outside the supported Date range");
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("rejects timeout durations that overflow from the current clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    const { rest, patchMock } = makeDiscordRest();

    await expect(
      timeoutMemberDiscord(
        { guildId: "g1", userId: "u1", durationMinutes: 1 },
        discordClientOpts(rest),
      ),
    ).rejects.toThrow("Discord timeout duration is outside the supported Date range");
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("adds and removes roles", async () => {
    const { rest, putMock, deleteMock } = makeDiscordRest();
    putMock.mockResolvedValue({});
    deleteMock.mockResolvedValue({});

    await addRoleDiscord({ guildId: "g1", userId: "u1", roleId: "r1" }, discordClientOpts(rest));
    await removeRoleDiscord({ guildId: "g1", userId: "u1", roleId: "r1" }, discordClientOpts(rest));

    expect(putMock).toHaveBeenCalledWith(Routes.guildMemberRole("g1", "u1", "r1"));
    expect(deleteMock).toHaveBeenCalledWith(Routes.guildMemberRole("g1", "u1", "r1"));
  });

  it("bans a member", async () => {
    const { rest, putMock } = makeDiscordRest();
    putMock.mockResolvedValue({});

    await banMemberDiscord(
      { guildId: "g1", userId: "u1", deleteMessageDays: 2 },
      discordClientOpts(rest),
    );

    expect(readDiscordRequestPath(putMock as unknown as DiscordMockCallSource)).toBe(
      Routes.guildBan("g1", "u1"),
    );
    expect(readDiscordRequestBody(putMock as unknown as DiscordMockCallSource)).toEqual({
      delete_message_days: 2,
    });
  });
});
