/** Transient ACP session bindings over canonical OpenClaw session keys. */
import type { AcpSessionRuntimeOptions } from "@openclaw/acp-core/types";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";

export type AcpLocalSessionBindingInput = {
  sessionId: string;
  sessionKey: string;
  cwd: string;
  ledgerSessionId?: string;
  runtimeOptions?: AcpSessionRuntimeOptions;
};

export type AcpLocalSessionBinding = Readonly<{
  sessionId: string;
  sessionKey: string;
  cwd: string;
  ledgerSessionId?: string;
  runtimeOptions?: Readonly<AcpSessionRuntimeOptions>;
}>;

export type AcpLocalSessionLifecycle = {
  current?: AcpLocalSessionBinding;
  siblings: readonly AcpLocalSessionBinding[];
  replace: (binding: AcpLocalSessionBindingInput) => AcpLocalSessionBinding;
  remove: (sessionId: string) => AcpLocalSessionBinding | undefined;
};

function normalizeBinding(input: AcpLocalSessionBindingInput): AcpLocalSessionBinding {
  const backendExtras = input.runtimeOptions?.backendExtras
    ? Object.freeze({ ...input.runtimeOptions.backendExtras })
    : undefined;
  const runtimeOptions = input.runtimeOptions
    ? Object.freeze({
        ...input.runtimeOptions,
        ...(backendExtras ? { backendExtras } : {}),
      })
    : undefined;
  return Object.freeze({
    sessionId: input.sessionId,
    sessionKey: input.sessionKey,
    cwd: input.cwd,
    ...(input.ledgerSessionId ? { ledgerSessionId: input.ledgerSessionId } : {}),
    ...(runtimeOptions ? { runtimeOptions } : {}),
  });
}

function canonicalQueueKey(sessionKey: string): string {
  return `canonical:${sessionKey}`;
}

/**
 * Owns only process-local ACP identity bindings.
 *
 * Lifecycle mutations always lock the ACP session id first, then canonical keys
 * in lexical order. Run cancellation and durable session changes stay outside.
 */
export class AcpLocalSessionBindings {
  private readonly bySessionId = new Map<string, AcpLocalSessionBinding>();
  private readonly sessionIdsByKey = new Map<string, Set<string>>();
  private readonly sessionQueue = new KeyedAsyncQueue();
  private readonly canonicalQueue = new KeyedAsyncQueue();

  get(sessionId: string): AcpLocalSessionBinding | undefined {
    return this.bySessionId.get(sessionId);
  }

  listBySessionKey(sessionKey: string): readonly AcpLocalSessionBinding[] {
    const sessionIds = this.sessionIdsByKey.get(sessionKey);
    if (!sessionIds) {
      return [];
    }
    return Object.freeze(
      [...sessionIds]
        .toSorted()
        .map((sessionId) => this.bySessionId.get(sessionId))
        .filter((binding): binding is AcpLocalSessionBinding => binding !== undefined),
    );
  }

  async replace(input: AcpLocalSessionBindingInput): Promise<AcpLocalSessionBinding> {
    return await this.sessionQueue.enqueue(input.sessionId, async () => {
      const current = this.bySessionId.get(input.sessionId);
      return await this.withCanonicalLocks([current?.sessionKey, input.sessionKey], async () =>
        this.replaceUnlocked(input),
      );
    });
  }

  async remove(sessionId: string): Promise<AcpLocalSessionBinding | undefined> {
    return await this.sessionQueue.enqueue(sessionId, async () => {
      const current = this.bySessionId.get(sessionId);
      if (!current) {
        return undefined;
      }
      return await this.withCanonicalLocks([current.sessionKey], async () =>
        this.removeUnlocked(sessionId),
      );
    });
  }

  async runCanonicalLifecycle<T>(params: {
    sessionId: string;
    sessionKey?: string;
    operation: (lifecycle: AcpLocalSessionLifecycle) => Promise<T>;
  }): Promise<T> {
    return await this.sessionQueue.enqueue(params.sessionId, async () => {
      const current = this.bySessionId.get(params.sessionId);
      const lockedSessionKey = params.sessionKey ?? current?.sessionKey;
      return await this.withCanonicalLocks([current?.sessionKey, lockedSessionKey], async () => {
        let active = true;
        const assertActive = () => {
          if (!active) {
            throw new Error("ACP lifecycle mutation scope has ended");
          }
        };
        const lifecycle: AcpLocalSessionLifecycle = {
          current: this.bySessionId.get(params.sessionId),
          siblings: lockedSessionKey ? this.listBySessionKey(lockedSessionKey) : [],
          replace: (binding) => {
            assertActive();
            if (
              !lockedSessionKey ||
              binding.sessionId !== params.sessionId ||
              binding.sessionKey !== lockedSessionKey
            ) {
              throw new Error(
                "ACP lifecycle replacement must keep the locked session id and canonical key",
              );
            }
            return this.replaceUnlocked(binding);
          },
          remove: (sessionId) => {
            assertActive();
            const binding = this.bySessionId.get(sessionId);
            if (!binding || binding.sessionKey !== lockedSessionKey) {
              return undefined;
            }
            return this.removeUnlocked(sessionId);
          },
        };
        try {
          return await params.operation(Object.freeze(lifecycle));
        } finally {
          active = false;
        }
      });
    });
  }

  private replaceUnlocked(input: AcpLocalSessionBindingInput): AcpLocalSessionBinding {
    const next = normalizeBinding(input);
    const previous = this.bySessionId.get(next.sessionId);
    if (previous) {
      this.removeIndex(previous);
    }
    this.bySessionId.set(next.sessionId, next);
    const sessionIds = this.sessionIdsByKey.get(next.sessionKey) ?? new Set<string>();
    sessionIds.add(next.sessionId);
    this.sessionIdsByKey.set(next.sessionKey, sessionIds);
    return next;
  }

  private removeUnlocked(sessionId: string): AcpLocalSessionBinding | undefined {
    const binding = this.bySessionId.get(sessionId);
    if (!binding) {
      return undefined;
    }
    this.bySessionId.delete(sessionId);
    this.removeIndex(binding);
    return binding;
  }

  private removeIndex(binding: AcpLocalSessionBinding): void {
    const sessionIds = this.sessionIdsByKey.get(binding.sessionKey);
    sessionIds?.delete(binding.sessionId);
    if (sessionIds?.size === 0) {
      this.sessionIdsByKey.delete(binding.sessionKey);
    }
  }

  private async withCanonicalLocks<T>(
    sessionKeys: Array<string | undefined>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const keys = [...new Set(sessionKeys.filter((key): key is string => Boolean(key)))].toSorted();
    const run = async (index: number): Promise<T> => {
      const key = keys[index];
      if (!key) {
        return await operation();
      }
      return await this.canonicalQueue.enqueue(canonicalQueueKey(key), async () => run(index + 1));
    };
    return await run(0);
  }
}
