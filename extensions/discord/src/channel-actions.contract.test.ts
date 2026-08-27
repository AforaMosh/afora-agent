// Discord tests cover channel actions.contract plugin behavior.
import { installChannelActionsContractSuite } from "afora-agent/plugin-sdk/channel-test-helpers";
import type { AforaConfig } from "afora-agent/plugin-sdk/config-contracts";
import { describe } from "vitest";
import { discordPlugin } from "../api.js";

describe("discord actions contract", () => {
  installChannelActionsContractSuite({
    plugin: discordPlugin,
    cases: [
      {
        name: "describes configured Discord actions and capabilities",
        cfg: {
          channels: {
            discord: {
              token: "Bot token-main",
              actions: {
                polls: true,
                reactions: true,
                permissions: false,
                messages: false,
                pins: false,
                threads: false,
                search: false,
                stickers: false,
                memberInfo: false,
                roleInfo: false,
                emojiUploads: false,
                stickerUploads: false,
                channelInfo: false,
                channels: false,
                voiceStatus: false,
                events: false,
                roles: false,
                moderation: false,
                presence: false,
              },
            },
          },
        } as AforaConfig,
        expectedActions: ["send", "poll", "react", "reactions", "emoji-list"],
        expectedCapabilities: ["presentation"],
      },
    ],
  });
});
