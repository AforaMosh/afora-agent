type Awaitable<T> = T | Promise<T>;

export type GatewayPostReadySidecarHandle = { stop: () => Awaitable<void> };
type SidecarStopLogger = { warn: (message: string) => void };

/** Stop sidecars immediately when shutdown has already started before they are reported. */
export function stopLateSidecarsAfterCloseStarted(
  sidecars: readonly GatewayPostReadySidecarHandle[],
  closeStarted: boolean,
  label: string,
  log: SidecarStopLogger,
): void {
  if (!closeStarted) {
    return;
  }
  for (const [index, sidecar] of sidecars.entries()) {
    try {
      void Promise.resolve(sidecar.stop()).catch((error: unknown) => {
        log.warn(`${label} sidecar ${index} failed to stop after close started: ${String(error)}`);
      });
    } catch (error) {
      log.warn(`${label} sidecar ${index} failed to stop after close started: ${String(error)}`);
    }
  }
}

/** Stop every registered sidecar before surfacing the first failure to the caller. */
export async function stopRegisteredSidecars(params: {
  sidecars: readonly GatewayPostReadySidecarHandle[];
  label: string;
  log: SidecarStopLogger;
}): Promise<void> {
  let firstFailure: { error: unknown } | null = null;
  for (const [index, sidecar] of params.sidecars.entries()) {
    try {
      await sidecar.stop();
    } catch (error) {
      params.log.warn(`${params.label} sidecar ${index} failed to stop: ${String(error)}`);
      firstFailure ??= { error };
    }
  }
  if (firstFailure) {
    throw firstFailure.error;
  }
}

/** Normal close is best-effort; a failed group must not skip later groups or teardown. */
export async function stopRegisteredSidecarGroupsForClose(
  stops: readonly (() => Awaitable<void>)[],
): Promise<void> {
  for (const stop of stops) {
    try {
      await stop();
    } catch {
      // stopRegisteredSidecars already logged each failed handle.
    }
  }
}
