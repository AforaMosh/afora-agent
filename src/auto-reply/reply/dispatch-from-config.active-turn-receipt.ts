import type { ReplyDispatchDeliveryOutcome } from "./reply-dispatcher.js";

const ACTIVE_TURN_RECEIPT_DELAY_MS = 30_000;
const ACTIVE_TURN_RECEIPT_TERMINAL_SETTLE_MS = 5_000;
export const ACTIVE_TURN_RECEIPT_TEXT =
  "I’m still working on this. I’ll send the answer when it’s ready.";

export type ActiveTurnReceiptDeliveryOutcome =
  | "confirmed-visible"
  | "proven-unsent"
  | "maybe-visible";

type ActiveTurnReceiptDeliverySignals = {
  preTransportAbortSignal: AbortSignal;
  terminalAbortSignal: AbortSignal;
};

export function classifyActiveTurnReceiptDispatchOutcome(
  outcome: ReplyDispatchDeliveryOutcome,
): ActiveTurnReceiptDeliveryOutcome {
  if (outcome === "delivered") {
    return "confirmed-visible";
  }
  if (outcome === "cancelled" || outcome === "failed-before-deliver") {
    return "proven-unsent";
  }
  return "maybe-visible";
}

export function createActiveTurnReceiptCoordinator() {
  let visible = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let preTransportAbortController: AbortController | undefined;
  let terminalAbortController: AbortController | undefined;
  let removeAbortListener: (() => void) | undefined;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const stop = (reason = new Error("active turn receipt cancelled before transport")) => {
    stopped = true;
    clearTimer();
    preTransportAbortController?.abort(reason);
    removeAbortListener?.();
    removeAbortListener = undefined;
  };
  const shouldStop = (abortSignal?: AbortSignal) =>
    stopped || visible || abortSignal?.aborted === true;

  return {
    arm(options: {
      eligible: boolean;
      abortSignal?: AbortSignal;
      deliver: (
        signals: ActiveTurnReceiptDeliverySignals,
      ) => Promise<ActiveTurnReceiptDeliveryOutcome>;
    }) {
      if (!options.eligible || stopped || timer || inFlight) {
        return;
      }
      if (options.abortSignal) {
        const onAbort = () => stop(options.abortSignal?.reason);
        options.abortSignal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.abortSignal?.removeEventListener("abort", onAbort);
      }
      timer = setTimeout(() => {
        timer = undefined;
        preTransportAbortController = new AbortController();
        terminalAbortController = new AbortController();
        inFlight = (async () => {
          if (shouldStop(options.abortSignal)) {
            return;
          }
          try {
            const outcome = await options.deliver({
              preTransportAbortSignal: preTransportAbortController!.signal,
              terminalAbortSignal: terminalAbortController!.signal,
            });
            if (outcome === "confirmed-visible") {
              visible = true;
            }
          } catch {
            // Durable delivery retains proven-unsent intents for readiness-owned recovery.
          }
        })().finally(() => {
          inFlight = undefined;
          preTransportAbortController = undefined;
          terminalAbortController = undefined;
        });
      }, ACTIVE_TURN_RECEIPT_DELAY_MS);
      timer.unref?.();
    },
    noteVisible() {
      visible = true;
      stop(new Error("active turn receipt cancelled by confirmed visibility"));
    },
    cancel: stop,
    async settleBeforeTerminal(): Promise<void> {
      stop();
      const pending = inFlight;
      if (!pending) {
        return;
      }
      let terminalSettleTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"deadline">((resolve) => {
        terminalSettleTimer = setTimeout(
          () => resolve("deadline"),
          ACTIVE_TURN_RECEIPT_TERMINAL_SETTLE_MS,
        );
        terminalSettleTimer.unref?.();
      });
      const settled = await Promise.race([pending.then(() => "settled" as const), deadline]);
      if (terminalSettleTimer) {
        clearTimeout(terminalSettleTimer);
      }
      if (settled === "deadline") {
        terminalAbortController?.abort(new Error("active turn receipt terminal settle timed out"));
      }
    },
  };
}
