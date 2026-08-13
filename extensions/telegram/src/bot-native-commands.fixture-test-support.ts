// Telegram plugin module implements bot native commands.fixture test support behavior.
import { Bot, Composer, type CommandContext, type Context } from "grammy";
import type { Message } from "grammy/types";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";
import type { OpenClawConfig, TelegramAccountConfig } from "../runtime-api.js";
import type { registerTelegramNativeCommands } from "./bot-native-commands.js";

type RegisterTelegramNativeCommandsParams = Parameters<typeof registerTelegramNativeCommands>[0];

export type NativeCommandTestParams = RegisterTelegramNativeCommandsParams & {
  allowFrom?: RegisterTelegramNativeCommandsParams["opts"]["allowFrom"];
  groupAllowFrom?: RegisterTelegramNativeCommandsParams["opts"]["groupAllowFrom"];
  replyToMode?: RegisterTelegramNativeCommandsParams["opts"]["replyToMode"];
};

const nativeCommandSentMessage = {
  message_id: 999,
  date: 1_700_000_000,
  chat: { id: 100, type: "private", first_name: "Test" },
  text: "sent",
} satisfies Message;

export function createNativeCommandTestBot(): Bot {
  const bot = new Bot("test-token");
  vi.spyOn(bot.api, "setMyCommands").mockResolvedValue(true);
  vi.spyOn(bot.api, "sendMessage").mockResolvedValue(nativeCommandSentMessage);
  vi.spyOn(bot.api, "deleteMessage").mockResolvedValue(true);
  vi.spyOn(bot, "command").mockImplementation(() => new Composer<CommandContext<Context>>());
  return bot;
}

export function createNativeCommandTestParams(
  params: Partial<NativeCommandTestParams> = {},
): RegisterTelegramNativeCommandsParams {
  const log = vi.fn();
  return {
    bot: params.bot ?? createNativeCommandTestBot(),
    cfg: params.cfg ?? ({} as OpenClawConfig),
    runtime: params.runtime ?? { ...createNonExitingRuntimeEnv(), log },
    accountId: params.accountId ?? "default",
    telegramCfg: params.telegramCfg ?? ({} as TelegramAccountConfig),
    nativeEnabled: params.nativeEnabled ?? true,
    nativeSkillsEnabled: params.nativeSkillsEnabled ?? false,
    resolveGroupPolicy:
      params.resolveGroupPolicy ??
      (() =>
        ({
          allowlistEnabled: false,
          allowed: true,
        }) as ReturnType<NativeCommandTestParams["resolveGroupPolicy"]>),
    resolveTelegramGroupConfig:
      params.resolveTelegramGroupConfig ??
      ((_chatId, _messageThreadId) => ({ groupConfig: undefined, topicConfig: undefined })),
    shouldSkipUpdate: params.shouldSkipUpdate ?? (() => false),
    telegramDeps: params.telegramDeps,
    opts: {
      ...(params.opts ?? { token: "token" }),
      allowFrom: params.allowFrom ?? params.opts?.allowFrom ?? [],
      groupAllowFrom: params.groupAllowFrom ?? params.opts?.groupAllowFrom ?? [],
      replyToMode: params.replyToMode ?? params.opts?.replyToMode ?? "off",
    },
  };
}

export function createTelegramPrivateCommandContext(params?: {
  match?: string;
  messageId?: number;
  date?: number;
  chatId?: number;
  userId?: number;
  username?: string;
  threadId?: number;
}) {
  return {
    match: params?.match ?? "",
    message: {
      message_id: params?.messageId ?? 1,
      date: params?.date ?? Math.floor(Date.now() / 1000),
      chat: { id: params?.chatId ?? 100, type: "private" as const },
      ...(params?.threadId != null ? { message_thread_id: params.threadId } : {}),
      from: { id: params?.userId ?? 200, username: params?.username ?? "bob" },
    },
  };
}

export function createTelegramGroupCommandContext(params?: {
  match?: string;
  messageId?: number;
  date?: number;
  chatId?: number;
  title?: string;
  userId?: number;
  username?: string;
}) {
  return {
    match: params?.match ?? "",
    message: {
      message_id: params?.messageId ?? 2,
      date: params?.date ?? Math.floor(Date.now() / 1000),
      chat: {
        id: params?.chatId ?? -1001234567890,
        type: "supergroup" as const,
        title: params?.title ?? "OpenClaw",
      },
      from: { id: params?.userId ?? 200, username: params?.username ?? "bob" },
    },
  };
}

export function createTelegramTopicCommandContext(params?: {
  match?: string;
  messageId?: number;
  date?: number;
  chatId?: number;
  title?: string;
  threadId?: number;
  userId?: number;
  username?: string;
}) {
  return {
    match: params?.match ?? "",
    message: {
      message_id: params?.messageId ?? 2,
      date: params?.date ?? Math.floor(Date.now() / 1000),
      chat: {
        id: params?.chatId ?? -1001234567890,
        type: "supergroup" as const,
        title: params?.title ?? "OpenClaw",
        is_forum: true,
      },
      message_thread_id: params?.threadId ?? 42,
      from: { id: params?.userId ?? 200, username: params?.username ?? "bob" },
    },
  };
}
