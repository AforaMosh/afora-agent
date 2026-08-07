type ActiveTurnReceiptSignalState = {
  preTransport: AbortSignal;
  transportStarted: boolean;
  resolveTransportStarted: () => void;
  transportStartedPromise: Promise<void>;
};

const signalStates = new WeakMap<AbortSignal, ActiveTurnReceiptSignalState>();

export class ActiveTurnReceiptTransportCancelledError extends Error {
  constructor() {
    super("active turn receipt cancelled before transport start");
    this.name = "ActiveTurnReceiptTransportCancelledError";
  }
}

export function bindActiveTurnReceiptSignals(params: {
  preTransport: AbortSignal;
  terminal: AbortSignal;
}): AbortSignal {
  let resolveTransportStarted = () => {};
  const transportStartedPromise = new Promise<void>((resolve) => {
    resolveTransportStarted = resolve;
  });
  signalStates.set(params.terminal, {
    preTransport: params.preTransport,
    transportStarted: false,
    resolveTransportStarted,
    transportStartedPromise,
  });
  return params.terminal;
}

export function resolveActiveTurnReceiptPreTransportSignal(terminal: AbortSignal): AbortSignal {
  return signalStates.get(terminal)?.preTransport ?? terminal;
}

function tryStartActiveTurnReceiptTransport(terminal: AbortSignal): boolean {
  const state = signalStates.get(terminal);
  if (!state || state.transportStarted) {
    return true;
  }
  // Preparation cancellation must win before this atomic claim. Afterwards,
  // only terminal containment may abort, preserving ambiguous-send ordering.
  if (state.preTransport.aborted || terminal.aborted) {
    return false;
  }
  state.transportStarted = true;
  state.resolveTransportStarted();
  return true;
}

export function claimActiveTurnReceiptTransport(terminal: AbortSignal): void {
  if (!tryStartActiveTurnReceiptTransport(terminal)) {
    throw new ActiveTurnReceiptTransportCancelledError();
  }
}

export function hasActiveTurnReceiptTransportStarted(terminal: AbortSignal): boolean {
  return signalStates.get(terminal)?.transportStarted === true;
}

function waitForActiveTurnReceiptTransportStarted(terminal: AbortSignal): Promise<void> {
  return signalStates.get(terminal)?.transportStartedPromise ?? Promise.resolve();
}

export async function runActiveTurnReceiptDelivery<T>(
  terminal: AbortSignal,
  run: () => Promise<T> | T,
): Promise<T> {
  const preTransport = resolveActiveTurnReceiptPreTransportSignal(terminal);
  const operation = Promise.resolve(run());
  const race = async <R>(competitors: Promise<R>[], signals: AbortSignal[]) => {
    const removers: Array<() => void> = [];
    const aborted = signals.map(
      (signal) =>
        new Promise<never>((_, reject) => {
          const onAbort = () => reject(new ActiveTurnReceiptTransportCancelledError());
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          removers.push(() => signal.removeEventListener("abort", onAbort));
        }),
    );
    try {
      return await Promise.race([...competitors, ...aborted]);
    } finally {
      removers.forEach((remove) => remove());
    }
  };
  type Result = { kind: "settled"; value: Awaited<T> } | { kind: "started" };
  const result = await race<Result>(
    [
      operation.then((value) => ({ kind: "settled" as const, value })),
      waitForActiveTurnReceiptTransportStarted(terminal).then(() => ({ kind: "started" as const })),
    ],
    [terminal, preTransport],
  );
  return result.kind === "settled" ? result.value : await race([operation], [terminal]);
}

export async function runActiveTurnReceiptPreparation<T>(
  terminal: AbortSignal | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  if (!terminal) {
    return await run();
  }
  const signals = [resolveActiveTurnReceiptPreTransportSignal(terminal), terminal];
  if (signals.some((signal) => signal.aborted)) {
    throw new ActiveTurnReceiptTransportCancelledError();
  }
  return await Promise.race([
    Promise.resolve(run()),
    ...signals.map(
      (signal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new ActiveTurnReceiptTransportCancelledError()),
            { once: true },
          );
        }),
    ),
  ]);
}

export function assertActiveTurnReceiptNotAborted(terminal: AbortSignal | undefined): void {
  if (
    terminal &&
    (terminal.aborted || resolveActiveTurnReceiptPreTransportSignal(terminal).aborted)
  ) {
    throw new ActiveTurnReceiptTransportCancelledError();
  }
}
