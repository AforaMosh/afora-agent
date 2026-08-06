import type { ReplyDispatchDeliveryOutcome } from "./reply-dispatcher.js";

const ACTIVE_TURN_RECEIPT_DELAY_MS = 30_000;
export const ACTIVE_TURN_RECEIPT_TEXT =
  "I’m still working on this. I’ll send the answer when it’s ready.";

export type ActiveTurnReceiptDeliveryOutcome =
  | "confirmed-visible"
  | "proven-unsent"
  | "maybe-visible";

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
  let removeAbortListener: (() => void) | undefined;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const stop = () => {
    stopped = true;
    clearTimer();
    removeAbortListener?.();
    removeAbortListener = undefined;
  };
  const shouldStop = (abortSignal?: AbortSignal) =>
    stopped || visible || abortSignal?.aborted === true;

  return {
    arm(options: {
      eligible: boolean;
      abortSignal?: AbortSignal;
      deliver: () => Promise<ActiveTurnReceiptDeliveryOutcome>;
    }) {
      if (!options.eligible || stopped || timer || inFlight) {
        return;
      }
      if (options.abortSignal) {
        const onAbort = () => stop();
        options.abortSignal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.abortSignal?.removeEventListener("abort", onAbort);
      }
      timer = setTimeout(() => {
        timer = undefined;
        inFlight = (async () => {
          // A proven pre-send failure may be retried once. Any outcome that may
          // already be visible ends the one-shot path to prevent duplicates.
          for (let attempt = 0; attempt < 2; attempt += 1) {
            if (shouldStop(options.abortSignal)) {
              return;
            }
            let outcome: ActiveTurnReceiptDeliveryOutcome;
            try {
              outcome = await options.deliver();
            } catch {
              return;
            }
            if (outcome === "confirmed-visible") {
              visible = true;
              return;
            }
            if (outcome === "maybe-visible") {
              return;
            }
          }
        })().finally(() => {
          inFlight = undefined;
        });
      }, ACTIVE_TURN_RECEIPT_DELAY_MS);
      timer.unref?.();
    },
    noteVisible() {
      visible = true;
      clearTimer();
    },
    cancel: stop,
    async settleBeforeTerminal(): Promise<void> {
      stop();
      await inFlight;
    },
  };
}
