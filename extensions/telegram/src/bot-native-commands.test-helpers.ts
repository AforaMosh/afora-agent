// Telegram helper module supports bot native commands helpers behavior.
import {
  createEmptyPluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelGroupPolicy } from "openclaw/plugin-sdk/config-contracts";
import type {
  TelegramAccountConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import type { MockFn } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { vi } from "vitest";
import type { TelegramNativeCommandDeps } from "./bot-native-command-deps.runtime.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";

resetPluginRuntimeStateForTest();
setActivePluginRegistry(createEmptyPluginRegistry());

type RegisterTelegramNativeCommandsParams = Parameters<typeof registerTelegramNativeCommands>[0];

type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").dispatchReplyWithBufferedBlockDispatcher;
type DispatchReplyWithBufferedBlockDispatcherResult = Awaited<
  ReturnType<DispatchReplyWithBufferedBlockDispatcherFn>
>;
type ResolveChunkModeFn = typeof import("./bot-native-commands.runtime.js").resolveChunkMode;
type EnsureConfiguredBindingRouteReadyFn =
  typeof import("./bot-native-commands.runtime.js").ensureConfiguredBindingRouteReady;
type GetAgentScopedMediaLocalRootsFn =
  typeof import("./bot-native-commands.runtime.js").getAgentScopedMediaLocalRoots;
type ResolveThreadSessionKeysFn =
  typeof import("./bot-native-commands.runtime.js").resolveThreadSessionKeys;
type AnyMock = MockFn<(...args: unknown[]) => unknown>;
type AnyAsyncMock = MockFn<(...args: unknown[]) => Promise<unknown>>;
type SendMessageMock = MockFn<Bot["api"]["sendMessage"]>;
type SetMyCommandsMock = MockFn<Bot["api"]["setMyCommands"]>;
type NativeCommandHarness = {
  handlers: Record<string, (ctx: unknown) => Promise<void>>;
  sendMessage: SendMessageMock;
  dispatchReplyWithBufferedBlockDispatcher: typeof replyPipelineMocks.dispatchReplyWithBufferedBlockDispatcher;
  setMyCommands: SetMyCommandsMock;
  log: AnyMock;
  bot: RegisterTelegramNativeCommandsParams["bot"];
  readChannelAllowFromStore: AnyAsyncMock;
};

const replyPipelineMocks = vi.hoisted(() => {
  const dispatchReplyResult: DispatchReplyWithBufferedBlockDispatcherResult = {
    queuedFinal: false,
    counts: {} as DispatchReplyWithBufferedBlockDispatcherResult["counts"],
  };
  return {
    finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
    dispatchReplyWithBufferedBlockDispatcher: vi.fn<DispatchReplyWithBufferedBlockDispatcherFn>(
      async () => dispatchReplyResult,
    ),
    resolveChunkMode: vi.fn<ResolveChunkModeFn>(() => "length"),
    ensureConfiguredBindingRouteReady: vi.fn<EnsureConfiguredBindingRouteReadyFn>(async () => ({
      ok: true,
    })),
    getAgentScopedMediaLocalRoots: vi.fn<GetAgentScopedMediaLocalRootsFn>(() => []),
    resolveThreadSessionKeys: vi.fn<ResolveThreadSessionKeysFn>(
      ({ baseSessionKey, threadId, parentSessionKey, useSuffix = true, normalizeThreadId }) => {
        const normalizedThreadId =
          typeof threadId === "string" ? (normalizeThreadId?.(threadId) ?? threadId.trim()) : "";
        return {
          sessionKey:
            normalizedThreadId && useSuffix
              ? `${baseSessionKey}:thread:${normalizedThreadId.toLowerCase()}`
              : baseSessionKey,
          parentSessionKey,
        };
      },
    ),
  };
});
const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn(async () => ({ delivered: true })),
}));

const sentMessage = {
  message_id: 1,
  date: 1_700_000_000,
  chat: { id: 100, type: "private", first_name: "Test" },
  text: "sent",
} satisfies Message;

const dispatchChannelInboundTurnForTest: TelegramNativeCommandDeps["dispatchChannelInboundTurn"] =
  async (plan) => {
    const delivery = plan.delivery;
    const dispatchResult = await replyPipelineMocks.dispatchReplyWithBufferedBlockDispatcher({
      ctx: plan.ctxPayload,
      cfg: plan.cfg,
      dispatcherOptions: {
        ...plan.dispatcherOptions,
        deliver:
          "deliverWithProviderMessageSending" in delivery
            ? (payload, info) => {
                const providerInfo = {
                  ...info,
                  onPlatformSendDispatch: async () => undefined,
                };
                return delivery.deliverWithProviderMessageSending(payload, providerInfo);
              }
            : delivery.deliver,
        onError: delivery.onError,
      },
      replyOptions: plan.replyOptions,
    });
    return {
      admission: { kind: "dispatch" },
      dispatched: true,
      ctxPayload: plan.ctxPayload,
      routeSessionKey: plan.route.sessionKey,
      dispatchResult,
    };
  };

vi.mock("./bot-native-commands.runtime.js", () => ({
  finalizeInboundContext: replyPipelineMocks.finalizeInboundContext,
  resolveChunkMode: replyPipelineMocks.resolveChunkMode,
  ensureConfiguredBindingRouteReady: replyPipelineMocks.ensureConfiguredBindingRouteReady,
  getAgentScopedMediaLocalRoots: replyPipelineMocks.getAgentScopedMediaLocalRoots,
  resolveThreadSessionKeys: replyPipelineMocks.resolveThreadSessionKeys,
}));
vi.mock("./bot-native-commands.delivery.runtime.js", () => ({
  deliverReplies: deliveryMocks.deliverReplies,
  emitTelegramMessageSentHooks: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/reply-dispatch-runtime", () => ({
  dispatchReplyWithBufferedBlockDispatcher:
    replyPipelineMocks.dispatchReplyWithBufferedBlockDispatcher,
}));
vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  readChannelAllowFromStore: vi.fn(async () => []),
  resolveConfiguredBindingRoute: vi.fn(({ route }: { route: unknown }) => ({
    route,
    bindingResolution: null,
    boundSessionKey: "",
  })),
  resolveRuntimeConversationBindingRoute: vi.fn(({ route }: { route: unknown }) => ({
    bindingRecord: null,
    route,
  })),
  getSessionBindingService: vi.fn(() => ({
    resolveByConversation: vi.fn(() => null),
    touch: vi.fn(),
  })),
  isPluginOwnedSessionBindingRecord: vi.fn(() => false),
}));
vi.mock("./bot/delivery.js", () => ({ deliverReplies: deliveryMocks.deliverReplies }));
vi.mock("./bot/delivery.replies.js", () => ({ deliverReplies: deliveryMocks.deliverReplies }));

export function createNativeCommandsHarness(params?: {
  cfg?: OpenClawConfig;
  runtime?: RuntimeEnv;
  telegramCfg?: TelegramAccountConfig;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  storeAllowFrom?: string[];
  readChannelAllowFromStore?: AnyAsyncMock;
  useAccessGroups?: boolean;
  nativeEnabled?: boolean;
  groupConfig?: TelegramGroupConfig;
  topicConfig?: TelegramTopicConfig;
  resolveGroupPolicy?: () => ChannelGroupPolicy;
}): NativeCommandHarness {
  replyPipelineMocks.dispatchReplyWithBufferedBlockDispatcher.mockClear();
  const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
  const bot = new Bot("test-token");
  const sendMessage = vi.spyOn(bot.api, "sendMessage").mockResolvedValue(sentMessage);
  const setMyCommands = vi.spyOn(bot.api, "setMyCommands").mockResolvedValue(true);
  const log: AnyMock = vi.fn();
  const baseCfg = params?.cfg ?? ({} as OpenClawConfig);
  const cfg =
    params?.useAccessGroups === undefined
      ? baseCfg
      : {
          ...baseCfg,
          commands: { ...baseCfg.commands, useAccessGroups: params.useAccessGroups },
        };
  const readChannelAllowFromStore: AnyAsyncMock =
    params?.readChannelAllowFromStore ?? vi.fn(async () => params?.storeAllowFrom ?? []);
  const telegramDeps = {
    getRuntimeConfig: vi.fn(() => cfg),
    readChannelAllowFromStore:
      readChannelAllowFromStore as TelegramNativeCommandDeps["readChannelAllowFromStore"],
    dispatchChannelInboundTurn: dispatchChannelInboundTurnForTest,
    listSkillCommandsForAgents: vi.fn(() => []),
    syncTelegramMenuCommands: vi.fn(),
    sendMessageTelegram: vi.fn(async (_to, text) => {
      await sendMessage(100, text, {});
      return { messageId: "999", chatId: "100" };
    }),
  };
  vi.spyOn(bot, "command").mockImplementation((name, handler) => {
    if (typeof handler !== "function") {
      throw new TypeError("Expected function command middleware");
    }
    handlers[String(name)] = async (ctx) => {
      await Reflect.apply(handler, undefined, [ctx, async () => {}]);
    };
    return new Composer<CommandContext<Context>>();
  });

  const runtime: RuntimeEnv = params?.runtime ?? {
    log,
    error: vi.fn(),
    exit: vi.fn(),
  };

  registerTelegramNativeCommands({
    bot,
    cfg,
    runtime,
    accountId: "default",
    telegramCfg: params?.telegramCfg ?? ({} as TelegramAccountConfig),
    nativeEnabled: params?.nativeEnabled ?? true,
    nativeSkillsEnabled: false,
    telegramDeps,
    resolveGroupPolicy:
      params?.resolveGroupPolicy ??
      (() =>
        ({
          allowlistEnabled: false,
          allowed: true,
        }) as ChannelGroupPolicy),
    resolveTelegramGroupConfig: () => ({
      groupConfig: params?.groupConfig,
      topicConfig: params?.topicConfig,
    }),
    shouldSkipUpdate: () => false,
    opts: {
      token: "token",
      allowFrom: params?.allowFrom ?? [],
      groupAllowFrom: params?.groupAllowFrom ?? [],
      replyToMode: "off",
    },
  });

  return {
    handlers,
    sendMessage,
    dispatchReplyWithBufferedBlockDispatcher:
      replyPipelineMocks.dispatchReplyWithBufferedBlockDispatcher,
    setMyCommands,
    log,
    bot,
    readChannelAllowFromStore,
  };
}

export function createTelegramDmCommandContext(params?: { senderId?: number; username?: string }) {
  const senderId = params?.senderId ?? 12345;
  return {
    message: {
      chat: { id: senderId, type: "private" },
      from: {
        id: senderId,
        username: params?.username ?? "testuser",
      },
      message_id: 1,
      date: 1700000000,
    },
    match: "",
  };
}

export function createTelegramGroupCommandContext(params?: {
  senderId?: number;
  username?: string;
  threadId?: number;
}) {
  return {
    message: {
      chat: { id: -100999, type: "supergroup", is_forum: true },
      from: {
        id: params?.senderId ?? 12345,
        username: params?.username ?? "testuser",
      },
      message_thread_id: params?.threadId ?? 42,
      message_id: 1,
      date: 1700000000,
    },
    match: "",
  };
}

export function findNotAuthorizedCalls(sendMessage: SendMessageMock) {
  return sendMessage.mock.calls.filter(
    (call) => typeof call[1] === "string" && call[1].includes("not authorized"),
  );
}
import { Bot, Composer, type CommandContext, type Context } from "grammy";
import type { Message } from "grammy/types";
