type Awaitable<T> = T | Promise<T>;

export type GatewayPostReadySidecarHandle = { stop: () => Awaitable<void> };

/** Stop sidecars immediately when shutdown has already started before they are reported. */
export function stopPostReadySidecarsAfterCloseStarted(params: {
  postReadySidecars: readonly GatewayPostReadySidecarHandle[];
  closeStarted: boolean;
  onStopError: (error: unknown, index: number) => void;
}): void {
  if (!params.closeStarted) {
    return;
  }
  for (const [index, postReadySidecar] of params.postReadySidecars.entries()) {
    try {
      void Promise.resolve(postReadySidecar.stop()).catch((error: unknown) => {
        params.onStopError(error, index);
      });
    } catch (error) {
      params.onStopError(error, index);
    }
  }
}
