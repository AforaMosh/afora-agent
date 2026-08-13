import type { Bot } from "grammy";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import type { dispatchTelegramMessage } from "./bot-message-dispatch.js";

type TelegramMessageContext = Parameters<typeof dispatchTelegramMessage>[0]["context"];

export function telegramMessageContextFixture(value: object): TelegramMessageContext {
  return Reflect.apply((context: TelegramMessageContext) => context, undefined, [value]);
}

export function telegramContextPayloadFixture(value: object): TelegramMessageContext["ctxPayload"] {
  return Reflect.apply((payload: TelegramMessageContext["ctxPayload"]) => payload, undefined, [
    value,
  ]);
}

export function telegramBotFixture(value: object): Bot {
  return Reflect.apply((bot: Bot) => bot, undefined, [value]);
}

export function telegramDeliveryFixture(value: object) {
  type Delivery = ChannelInboundTurnPlan<"provider_message_sending">["delivery"];
  return Reflect.apply((delivery: Delivery) => delivery, undefined, [value]);
}

export function telegramMessageFixture(value: object): TelegramMessageContext["msg"] {
  return Reflect.apply((message: TelegramMessageContext["msg"]) => message, undefined, [value]);
}

export function telegramPrimaryContextFixture(value: object): TelegramMessageContext["primaryCtx"] {
  return Reflect.apply((context: TelegramMessageContext["primaryCtx"]) => context, undefined, [
    value,
  ]);
}

export function telegramRouteFixture(value: object): TelegramMessageContext["route"] {
  return Reflect.apply((route: TelegramMessageContext["route"]) => route, undefined, [value]);
}

export function telegramTurnFixture(value: object): TelegramMessageContext["turn"] {
  return Reflect.apply((turn: TelegramMessageContext["turn"]) => turn, undefined, [value]);
}
