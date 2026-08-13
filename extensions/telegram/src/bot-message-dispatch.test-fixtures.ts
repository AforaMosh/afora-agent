import { Bot } from "grammy";
import type { Chat, Message } from "grammy/types";
import { vi } from "vitest";
import type { dispatchTelegramMessage } from "./bot-message-dispatch.js";

type TelegramMessageContext = Parameters<typeof dispatchTelegramMessage>[0]["context"];
type TelegramMessage = TelegramMessageContext["msg"];
type TelegramMessageChatInput = {
  id?: number;
  type?: Chat["type"];
  first_name?: string;
  title?: string;
  username?: string;
  is_forum?: true;
  is_direct_messages?: true;
};
export type TelegramMessageFixtureInput = Omit<Partial<Message>, "chat"> & {
  chat?: TelegramMessageChatInput;
};
export type TelegramPrimaryContextFixtureInput = Omit<
  Partial<TelegramMessageContext["primaryCtx"]>,
  "message"
> & {
  message?: TelegramMessageFixtureInput;
};
export type TelegramTurnFixtureInput = Omit<Partial<TelegramMessageContext["turn"]>, "record"> & {
  record?: Partial<TelegramMessageContext["turn"]["record"]>;
};
export type TelegramMessageContextOverrides = Omit<
  Partial<TelegramMessageContext>,
  "ctxPayload" | "msg" | "primaryCtx" | "route" | "sendChatActionHandler" | "turn"
> & {
  ctxPayload?: TelegramMessageContext["ctxPayload"];
  msg?: TelegramMessageFixtureInput;
  primaryCtx?: TelegramPrimaryContextFixtureInput;
  route?: Partial<TelegramMessageContext["route"]>;
  sendChatActionHandler?: Partial<TelegramMessageContext["sendChatActionHandler"]>;
  turn?: TelegramTurnFixtureInput;
};

function telegramChatFixture(value: TelegramMessageChatInput = {}): Chat {
  const id = value.id ?? 123;
  const chatType = value.type ?? "private";
  switch (chatType) {
    case "private":
      return {
        id,
        type: "private",
        first_name: value.first_name ?? "Test",
        ...(value.username ? { username: value.username } : {}),
      };
    case "group":
      return { id, type: "group", title: value.title ?? "Test group" };
    case "supergroup":
      return {
        id,
        type: "supergroup",
        title: value.title ?? "Test supergroup",
        ...(value.username ? { username: value.username } : {}),
        ...(value.is_forum ? { is_forum: true as const } : {}),
        ...(value.is_direct_messages ? { is_direct_messages: true as const } : {}),
      };
    case "channel":
      return {
        id,
        type: "channel",
        title: value.title ?? "Test channel",
        ...(value.username ? { username: value.username } : {}),
      };
  }
  chatType satisfies never;
  throw new Error("unsupported Telegram chat fixture type");
}

export function telegramContextPayloadFixture(
  value: Partial<TelegramMessageContext["ctxPayload"]> = {},
): TelegramMessageContext["ctxPayload"] {
  return {
    Body: "",
    BodyForAgent: "",
    BodyForCommands: "",
    ChatType: "direct",
    CommandAuthorized: true,
    CommandBody: "",
    From: "telegram:123",
    RawBody: "",
    SessionKey: "agent:default:telegram:direct:123",
    To: "telegram:123",
    InboundEventKind: "user_request",
    ...value,
  };
}

export function createTelegramBotFixture(): Bot {
  const bot = new Bot("test-token");
  vi.spyOn(bot.api, "sendMessage").mockImplementation(async (chatId, text, params) => ({
    message_id: typeof params?.message_thread_id === "number" ? params.message_thread_id : 1001,
    date: 1_700_000_000,
    chat: telegramChatFixture({ id: typeof chatId === "number" ? chatId : 123, type: "private" }),
    text,
  }));
  vi.spyOn(bot.api, "editMessageText").mockResolvedValue(true);
  vi.spyOn(bot.api, "deleteMessage").mockResolvedValue(true);
  vi.spyOn(bot.api, "editForumTopic").mockResolvedValue(true);
  return bot;
}

export function telegramMessageFixture(value: TelegramMessageFixtureInput = {}): TelegramMessage {
  const { chat, ...message } = value;
  return {
    message_id: 456,
    date: 1_700_000_000,
    ...message,
    chat: telegramChatFixture(chat),
  };
}

export function telegramPrimaryContextFixture(
  value: TelegramPrimaryContextFixtureInput = {},
): TelegramMessageContext["primaryCtx"] {
  const { message, ...context } = value;
  return {
    ...context,
    message: telegramMessageFixture(message),
    getFile:
      value.getFile ??
      vi.fn(async () => ({ file_id: "fixture-file", file_unique_id: "fixture-file-unique" })),
  };
}

export function telegramRouteFixture(
  value: Partial<TelegramMessageContext["route"]> = {},
): TelegramMessageContext["route"] {
  const agentId = value.agentId ?? "default";
  const mainSessionKey = `agent:${agentId}:main`;
  return {
    agentId,
    channel: "telegram",
    accountId: "default",
    sessionKey: `agent:${agentId}:telegram:direct:123`,
    mainSessionKey,
    lastRoutePolicy: "session",
    matchedBy: "default",
    ...value,
  };
}

export function telegramTurnFixture(
  value: TelegramTurnFixtureInput = {},
): TelegramMessageContext["turn"] {
  return {
    storePath: "/tmp/openclaw/telegram-sessions.json",
    recordInboundSession: vi.fn(async () => undefined),
    ...value,
    record: {
      onRecordError: vi.fn(),
      ...value.record,
    },
  };
}

export function createTelegramMessageContextFixture(
  overrides?: TelegramMessageContextOverrides,
): TelegramMessageContext {
  const msg = telegramMessageFixture({ message_thread_id: 777 });
  const base: TelegramMessageContext = {
    cfg: {},
    ctxPayload: telegramContextPayloadFixture(),
    primaryCtx: telegramPrimaryContextFixture({ message: msg }),
    msg,
    chatId: 123,
    isGroup: false,
    groupConfig: undefined,
    resolvedThreadId: undefined,
    replyThreadId: 777,
    threadSpec: { id: 777, scope: "dm" },
    historyKey: undefined,
    historyLimit: 0,
    groupHistories: new Map(),
    route: telegramRouteFixture(),
    skillFilter: undefined,
    sendTyping: vi.fn(),
    sendRecordVoice: vi.fn(),
    sendChatActionHandler: {
      sendChatAction: vi.fn(async () => undefined),
      isSuspended: vi.fn(() => false),
      reset: vi.fn(),
    },
    ackReactionPromise: null,
    reactionApi: null,
    isForum: false,
    statusReactionController: null,
    accountId: "default",
    turn: telegramTurnFixture(),
  };

  return {
    ...base,
    ...overrides,
    ctxPayload: overrides?.ctxPayload ?? base.ctxPayload,
    primaryCtx: telegramPrimaryContextFixture({
      ...base.primaryCtx,
      ...overrides?.primaryCtx,
      message: {
        ...base.primaryCtx.message,
        ...overrides?.primaryCtx?.message,
        chat: {
          ...base.primaryCtx.message.chat,
          ...overrides?.primaryCtx?.message?.chat,
        },
      },
    }),
    msg: telegramMessageFixture({
      ...base.msg,
      ...overrides?.msg,
      chat: { ...base.msg.chat, ...overrides?.msg?.chat },
    }),
    route: telegramRouteFixture({ ...base.route, ...overrides?.route }),
    sendChatActionHandler: {
      ...base.sendChatActionHandler,
      ...overrides?.sendChatActionHandler,
    },
    turn: telegramTurnFixture({
      ...base.turn,
      ...overrides?.turn,
      record: { ...base.turn.record, ...overrides?.turn?.record },
    }),
  };
}
