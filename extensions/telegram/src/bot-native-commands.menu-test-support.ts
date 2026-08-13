// Telegram plugin module implements bot native commands.menu test support behavior.
import { Composer, type CommandContext, type Context } from "grammy";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { expect, vi, type Mock } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import type { TelegramNativeCommandDeps } from "./bot-native-command-deps.runtime.js";
import {
  createNativeCommandTestParams as createBaseNativeCommandTestParams,
  createNativeCommandTestBot,
  createTelegramPrivateCommandContext,
  type NativeCommandTestParams as RegisterTelegramNativeCommandsParams,
} from "./bot-native-commands.fixture-test-support.js";

type RegisteredCommand = {
  command: string;
  description: string;
};
type UnknownMock = Mock<(...args: unknown[]) => unknown>;

type CreateCommandBotResult = {
  bot: RegisterTelegramNativeCommandsParams["bot"];
  commandHandlers: Map<string, (ctx: unknown) => Promise<void>>;
  sendMessage: ReturnType<typeof vi.fn>;
  deleteMessage: ReturnType<typeof vi.fn>;
  setMyCommands: ReturnType<typeof vi.fn>;
};
type CreateCommandBotParams = {
  api?: Record<string, unknown>;
};

const skillCommandMocks = vi.hoisted(() => ({
  listSkillCommandsForAgents: vi.fn<TelegramNativeCommandDeps["listSkillCommandsForAgents"]>(
    () => [],
  ),
}));

const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn(async () => ({ delivered: true })),
  editMessageTelegram: vi.fn(async () => ({ ok: true as const, messageId: "999", chatId: "100" })),
  emitTelegramMessageSentHooks: vi.fn(),
}));

export const listSkillCommandsForAgents = skillCommandMocks.listSkillCommandsForAgents;
export const deliverReplies = deliveryMocks.deliverReplies;
export const editMessageTelegram = deliveryMocks.editMessageTelegram;
export const emitTelegramMessageSentHooks: UnknownMock = deliveryMocks.emitTelegramMessageSentHooks;

vi.mock("./bot/delivery.js", () => ({
  deliverReplies,
  emitTelegramMessageSentHooks,
}));

vi.mock("./bot/delivery.replies.js", () => ({
  deliverReplies,
}));

export async function waitForRegisteredCommands(
  setMyCommands: ReturnType<typeof vi.fn>,
): Promise<RegisteredCommand[]> {
  await vi.waitFor(() => {
    expect(setMyCommands).toHaveBeenCalled();
  });
  return setMyCommands.mock.calls.at(0)?.[0] as RegisteredCommand[];
}

export function resetNativeCommandMenuMocks() {
  listSkillCommandsForAgents.mockClear();
  listSkillCommandsForAgents.mockReturnValue([]);
  deliverReplies.mockClear();
  deliverReplies.mockResolvedValue({ delivered: true });
  editMessageTelegram.mockClear();
  editMessageTelegram.mockResolvedValue({ ok: true as const, messageId: "999", chatId: "100" });
  emitTelegramMessageSentHooks.mockClear();
}

export function createCommandBot(params: CreateCommandBotParams = {}): CreateCommandBotResult {
  const commandHandlers = new Map<string, (ctx: unknown) => Promise<void>>();
  const bot = createNativeCommandTestBot();
  Object.assign(bot.api, params.api);
  const sendMessage = vi.spyOn(bot.api, "sendMessage");
  const deleteMessage = vi.spyOn(bot.api, "deleteMessage");
  const setMyCommands = vi.spyOn(bot.api, "setMyCommands");
  vi.spyOn(bot, "command").mockImplementation((name, handler) => {
    if (typeof handler !== "function") {
      throw new TypeError("Expected function command middleware");
    }
    commandHandlers.set(String(name), async (ctx) => {
      await Reflect.apply(handler, undefined, [ctx, async () => {}]);
    });
    return new Composer<CommandContext<Context>>();
  });
  return { bot, commandHandlers, sendMessage, deleteMessage, setMyCommands };
}

export function createNativeCommandTestParams(
  cfg: OpenClawConfig,
  params: Partial<RegisterTelegramNativeCommandsParams> = {},
): RegisterTelegramNativeCommandsParams {
  const telegramDeps: TelegramNativeCommandDeps = {
    getRuntimeConfig: vi.fn(() => cfg) as TelegramNativeCommandDeps["getRuntimeConfig"],
    readChannelAllowFromStore: vi.fn(
      async () => [],
    ) as TelegramNativeCommandDeps["readChannelAllowFromStore"],
    dispatchChannelInboundTurn: vi.fn(async (plan) => ({
      admission: { kind: "dispatch" },
      dispatched: true,
      ctxPayload: plan.ctxPayload,
      routeSessionKey: plan.route.sessionKey,
      dispatchResult: {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
      },
    })) as TelegramNativeCommandDeps["dispatchChannelInboundTurn"],
    listSkillCommandsForAgents,
    syncTelegramMenuCommands: vi.fn(({ bot, commandsToRegister }) => {
      if (commandsToRegister.length === 0) {
        return undefined;
      }
      return bot.api.setMyCommands(commandsToRegister);
    }) as TelegramNativeCommandDeps["syncTelegramMenuCommands"],
    editMessageTelegram,
    sendMessageTelegram: vi.fn(async () => ({ messageId: "999", chatId: "100" })),
  };
  return createBaseNativeCommandTestParams({
    cfg,
    runtime: params.runtime ?? ({} as RuntimeEnv),
    nativeSkillsEnabled: true,
    telegramDeps,
    ...params,
  });
}

export function createPrivateCommandContext(
  params?: Parameters<typeof createTelegramPrivateCommandContext>[0],
) {
  return createTelegramPrivateCommandContext(params);
}
