import type { AcpSessionManager } from "./manager.core.js";

/** Internal process-lifecycle registry for ACP session manager instances. */
type AcpSessionManagerDisposer = (reason: string) => Promise<void>;

const ACP_SESSION_MANAGER_DISPOSERS = new WeakMap<object, AcpSessionManagerDisposer>();

export function registerAcpSessionManagerDisposer(
  manager: AcpSessionManager,
  dispose: AcpSessionManagerDisposer,
): void {
  ACP_SESSION_MANAGER_DISPOSERS.set(manager, dispose);
}

/** Stops active turns and closes process-local handles without widening the public manager API. */
export async function disposeAcpSessionManagerInstance(
  manager: AcpSessionManager,
  reason: string,
): Promise<void> {
  const dispose = ACP_SESSION_MANAGER_DISPOSERS.get(manager);
  if (!dispose) {
    throw new Error("ACP session manager disposer unavailable");
  }
  await dispose(reason);
}
