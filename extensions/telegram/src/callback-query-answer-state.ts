const TELEGRAM_CALLBACK_QUERY_ANSWER_PROMISE = Symbol.for(
  "openclaw.telegram.callbackQueryAnswerPromise",
);

export function setTelegramCallbackQueryAnswerPromise<T extends object>(
  ctx: T,
  promise: Promise<unknown>,
): void {
  Object.defineProperty(ctx, TELEGRAM_CALLBACK_QUERY_ANSWER_PROMISE, {
    configurable: true,
    value: promise,
  });
}

export function getTelegramCallbackQueryAnswerPromise<T extends object>(
  ctx: T,
): Promise<unknown> | undefined {
  const promise = Reflect.get(ctx, TELEGRAM_CALLBACK_QUERY_ANSWER_PROMISE);
  return promise instanceof Promise ? promise : undefined;
}
