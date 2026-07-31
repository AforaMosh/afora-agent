/** ACP session orchestration over local OpenClaw session and turn runtimes. */
import { randomUUID } from "node:crypto";
import type {
  CancelNotification,
  CloseSessionRequest,
  CloseSessionResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import type { AcpServerOptions, AcpSessionRuntimeOptions } from "@openclaw/acp-core/types";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createFixedWindowRateLimiter,
  resolveFixedWindowRateLimitInteger,
  type FixedWindowRateLimiter,
} from "../infra/fixed-window-rate-limit.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { mergeRuntimeOptions } from "./control-plane/runtime-options.js";
import type { AcpEventLedgerReplay } from "./event-ledger.js";
import type {
  AcpLocalSessionBinding,
  AcpLocalSessionBindingInput,
  AcpLocalSessionLifecycle,
} from "./local-session-bindings.js";
import { AcpLocalSessionBindings } from "./local-session-bindings.js";
import {
  resolveAcpSessionConfigPatch,
  runtimePresentationOverrides,
} from "./local-session-config.js";
import {
  EMPTY_ACP_EVENT_LEDGER_REPLAY,
  replayLocalSessionHistory,
  resolveInitialLoadLedgerReplay,
  resolveLoadLedgerReplay,
} from "./local-session-replay.js";
import type { AcpLocalSessionRuntime } from "./local-session-runtime.js";
import type { AcpLocalTurnRuntime } from "./local-turn-runtime.js";
import { parseSessionMeta, type AcpSessionMeta } from "./session-mapper.js";
import type { SessionSnapshot } from "./translator.presentation.js";
import {
  assertAbsoluteCwd,
  decodeListSessionsCursor,
  encodeListSessionsCursor,
  resolveListSessionsPageSize,
} from "./translator.session-list.js";
import type { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";

const SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS = 120;
const SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS = 10_000;

export type AcpLocalSessionControllerOptions = {
  sessionRuntime: AcpLocalSessionRuntime;
  turnRuntime: AcpLocalTurnRuntime;
  bindings: AcpLocalSessionBindings;
  sessionUpdates: AcpTranslatorSessionUpdates;
  serverOptions?: AcpServerOptions;
  createSessionId?: () => string;
  log?: (message: string) => void;
};

function hasExplicitSessionRouting(meta: AcpSessionMeta, opts: AcpServerOptions): boolean {
  return Boolean(
    meta.sessionKey || meta.sessionLabel || opts.defaultSessionKey || opts.defaultSessionLabel,
  );
}

function shouldResetSession(meta: AcpSessionMeta, opts: AcpServerOptions): boolean {
  return meta.resetSession ?? opts.resetSession ?? false;
}

function toBindingInput(binding: AcpLocalSessionBinding): AcpLocalSessionBindingInput {
  return {
    sessionId: binding.sessionId,
    sessionKey: binding.sessionKey,
    cwd: binding.cwd,
    ...(binding.ledgerSessionId ? { ledgerSessionId: binding.ledgerSessionId } : {}),
    ...(binding.runtimeOptions
      ? {
          runtimeOptions: {
            ...binding.runtimeOptions,
            ...(binding.runtimeOptions.backendExtras
              ? { backendExtras: { ...binding.runtimeOptions.backendExtras } }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Owns ACP session lifecycle and protocol-facing orchestration.
 *
 * Durable state, turn execution, event projection, and protocol transport remain
 * in their dedicated owners.
 */
export class AcpLocalSessionController {
  private readonly opts: AcpServerOptions;
  private readonly createSessionId: () => string;
  private readonly log: (message: string) => void;
  private readonly sessionCreateRateLimiter: FixedWindowRateLimiter;
  private readonly sessionLifecycleQueue = new KeyedAsyncQueue();
  private readonly sessionAdmissionQueue = new KeyedAsyncQueue();
  private readonly pendingLifecycles = new Set<Promise<unknown>>();
  private shutdownPromise?: Promise<void>;
  private stopped = false;

  constructor(private readonly options: AcpLocalSessionControllerOptions) {
    this.opts = options.serverOptions ?? {};
    this.createSessionId = options.createSessionId ?? randomUUID;
    this.log = options.log ?? (() => {});
    this.sessionCreateRateLimiter = createFixedWindowRateLimiter({
      maxRequests: resolveFixedWindowRateLimitInteger(
        this.opts.sessionCreateRateLimit?.maxRequests,
        SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS,
        { min: 1 },
      ),
      windowMs: resolveFixedWindowRateLimitInteger(
        this.opts.sessionCreateRateLimit?.windowMs,
        SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS,
        { min: 1_000 },
      ),
    });
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.assertRunning();
    this.assertSupportedSessionSetup(params.mcpServers);
    assertAbsoluteCwd(params.cwd, "session/new");
    this.enforceSessionCreateRateLimit("newSession");

    const sessionId = this.createSessionId();
    return await this.withSessionLifecycleRequest(sessionId, async () => {
      const meta = parseSessionMeta(params["_meta"]);
      const sessionKey = await this.options.sessionRuntime.resolveSessionKey({
        meta,
        fallbackKey: `acp-bridge:${sessionId}`,
      });
      const { binding, snapshot } = await this.setupSessionBinding({
        sessionId,
        sessionKey,
        cwd: params.cwd,
        meta,
        completeLedger: true,
        resetLedger: true,
        replay: "none",
      });
      this.log(`newSession: ${binding.sessionId} -> ${binding.sessionKey}`);
      return {
        sessionId: binding.sessionId,
        configOptions: snapshot.configOptions,
        modes: snapshot.modes,
      };
    });
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    return await this.withSessionLifecycleRequest(params.sessionId, async () => {
      this.assertSupportedSessionSetup(params.mcpServers);
      assertAbsoluteCwd(params.cwd, "session/load");
      const current = this.options.bindings.get(params.sessionId);

      const meta = parseSessionMeta(params["_meta"]);
      const explicitRouting = hasExplicitSessionRouting(meta, this.opts);
      const routedReplay = await resolveInitialLoadLedgerReplay(this.options.sessionUpdates, {
        explicitRouting,
        sessionId: params.sessionId,
      });
      const sessionKey = await this.options.sessionRuntime.resolveSessionKey({
        meta,
        fallbackKey: current?.sessionKey ?? routedReplay.sessionKey ?? params.sessionId,
      });
      const reset = shouldResetSession(meta, this.opts);
      const { binding, snapshot } = await this.setupSessionBinding({
        sessionId: params.sessionId,
        sessionKey,
        cwd: params.cwd,
        meta,
        completeLedger: reset,
        ...(reset ? { resetLedger: true } : {}),
        enforceCreationRateLimit: "loadSession",
        replay: reset
          ? "none"
          : {
              resolveLedger: async (retainedCurrent) =>
                await resolveLoadLedgerReplay(this.options.sessionUpdates, {
                  explicitRouting,
                  sessionId: params.sessionId,
                  sessionKey,
                  ...(retainedCurrent?.ledgerSessionId
                    ? { ledgerSessionId: retainedCurrent.ledgerSessionId }
                    : {}),
                }),
            },
        preserveCurrentLedgerIdentity: true,
        preserveCurrentRuntimeOptions: true,
        requireExistingOnTargetChange: true,
        ...(routedReplay.complete && routedReplay.sessionKey
          ? { existingLedgerSessionKey: routedReplay.sessionKey }
          : {}),
      });
      this.log(`loadSession: ${binding.sessionId} -> ${binding.sessionKey}`);
      return {
        configOptions: snapshot.configOptions,
        modes: snapshot.modes,
      };
    });
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    this.assertRunning();
    return await (async () => {
      const requestedCwd = normalizeOptionalString(params.cwd);
      if (requestedCwd) {
        assertAbsoluteCwd(requestedCwd, "session/list");
      }
      const cursor = decodeListSessionsCursor(params.cursor);
      if (params.cursor && cursor.cwd !== requestedCwd) {
        throw new Error("ACP session list cursor does not match the cwd filter.");
      }
      const pageSize = resolveListSessionsPageSize(params["_meta"]);
      const rows = await this.options.sessionRuntime.listSessions({
        ...(requestedCwd ? { cwd: requestedCwd } : {}),
        offset: cursor.offset,
        limit: pageSize + 1,
      });
      const sessions = rows.slice(0, pageSize);
      return {
        sessions,
        nextCursor:
          rows.length > pageSize
            ? encodeListSessionsCursor({
                offset: cursor.offset + sessions.length,
                ...(requestedCwd ? { cwd: requestedCwd } : {}),
              })
            : null,
      };
    })();
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    return await this.withSessionLifecycleRequest(params.sessionId, async () => {
      this.assertSupportedSessionSetup(params.mcpServers ?? []);
      assertAbsoluteCwd(params.cwd, "session/resume");
      const current = this.options.bindings.get(params.sessionId);
      const meta = parseSessionMeta(params["_meta"]);
      const sessionKey = await this.options.sessionRuntime.resolveSessionKey({
        meta,
        fallbackKey: current?.sessionKey ?? params.sessionId,
      });
      const reset = shouldResetSession(meta, this.opts);
      const { binding, snapshot } = await this.setupSessionBinding({
        sessionId: params.sessionId,
        sessionKey,
        cwd: params.cwd,
        meta,
        completeLedger: reset,
        ...(reset ? { resetLedger: true } : {}),
        enforceCreationRateLimit: "resumeSession",
        replay: "none",
        requireExistingOnTargetChange: true,
        preserveCurrentLedgerIdentity: true,
        preserveCurrentRuntimeOptions: true,
      });
      this.log(`resumeSession: ${binding.sessionId} -> ${binding.sessionKey}`);
      return {
        configOptions: snapshot.configOptions,
        modes: snapshot.modes,
      };
    });
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    return await this.withSessionLifecycleRequest(params.sessionId, async () => {
      return await this.withBoundSessionLifecycle(params.sessionId, async (binding, lifecycle) => {
        await this.options.turnRuntime.quiesceSession(
          binding.sessionId,
          new Error("ACP session closed"),
        );
        lifecycle.remove(binding.sessionId);
        this.log(`closeSession: ${binding.sessionId}`);
        return {};
      });
    });
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    return await this.withSessionLifecycleRequest(params.sessionId, async () => {
      return await this.withBoundSessionLifecycle(params.sessionId, async (binding) => {
        if (!params.modeId) {
          return {};
        }
        const snapshot = await this.options.sessionRuntime.patchSession(
          binding.sessionKey,
          { thinkingLevel: params.modeId },
          {
            thinkingLevel: params.modeId,
            spawnedCwd: binding.cwd,
            ...runtimePresentationOverrides(binding.runtimeOptions),
          },
        );
        await this.sendSessionSnapshotUpdate(binding, snapshot, {
          includeControls: true,
          record: true,
        });
        this.log(`setSessionMode: ${binding.sessionId} -> ${params.modeId}`);
        return {};
      });
    });
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    return await this.withSessionLifecycleRequest(params.sessionId, async () => {
      return await this.withBoundSessionLifecycle(params.sessionId, async (binding, lifecycle) => {
        const configPatch = resolveAcpSessionConfigPatch(params.configId, params.value);
        const nextRuntimeOptions = configPatch.runtimePatch
          ? mergeRuntimeOptions({
              current: binding.runtimeOptions
                ? {
                    ...binding.runtimeOptions,
                    ...(binding.runtimeOptions.backendExtras
                      ? { backendExtras: { ...binding.runtimeOptions.backendExtras } }
                      : {}),
                  }
                : undefined,
              patch: configPatch.runtimePatch,
            })
          : undefined;
        const snapshot = configPatch.patch
          ? await this.options.sessionRuntime.patchSession(binding.sessionKey, configPatch.patch, {
              ...configPatch.overrides,
              spawnedCwd: binding.cwd,
              ...runtimePresentationOverrides(nextRuntimeOptions ?? binding.runtimeOptions),
            })
          : await this.options.sessionRuntime.getSessionSnapshot(binding.sessionKey, {
              ...configPatch.overrides,
              ...runtimePresentationOverrides(nextRuntimeOptions ?? binding.runtimeOptions),
            });
        await this.sendSessionSnapshotUpdate(binding, snapshot, {
          includeControls: true,
          record: true,
        });
        if (nextRuntimeOptions) {
          lifecycle.replace({
            ...toBindingInput(binding),
            runtimeOptions: nextRuntimeOptions,
          });
        }
        this.log(
          `setSessionConfigOption: ${binding.sessionId} -> ${params.configId}=${params.value}`,
        );
        return { configOptions: snapshot.configOptions };
      });
    });
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    let completion: Promise<PromptResponse> | undefined;
    // Route selection must commit before a later prompt reads the binding. Hold
    // lifecycle ordering only through admission so later control can quiesce the turn.
    await this.withSessionLifecycleRequest(params.sessionId, async () => {
      await this.withSessionAdmission(params.sessionId, async () => {
        const binding = this.requireBinding(params.sessionId);
        completion = this.options.turnRuntime.prompt(toBindingInput(binding), params);
      });
    });
    if (!completion) {
      throw new Error(`Session ${params.sessionId} prompt was not admitted`);
    }
    return await completion;
  }

  async cancel(params: CancelNotification): Promise<void> {
    if (this.stopped) {
      return;
    }
    await this.sessionAdmissionQueue.enqueue(params.sessionId, async () => {
      if (this.stopped) {
        return;
      }
      if (this.options.bindings.get(params.sessionId)) {
        await this.options.turnRuntime.cancel(params.sessionId);
      }
    });
  }

  shutdown(reason: unknown = new Error("ACP session controller stopped")): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.stopped = true;
    this.shutdownPromise = (async () => {
      await Promise.allSettled(this.pendingLifecycles);
      const sessionIds = this.options.bindings.list().map((binding) => binding.sessionId);
      await this.withSessionLocks(sessionIds, async () => {
        await this.options.turnRuntime.shutdown(reason);
        for (const binding of this.options.bindings.list()) {
          await this.options.bindings.remove(binding.sessionId);
        }
        this.options.sessionUpdates.stop();
      });
    })();
    return this.shutdownPromise;
  }

  private async setupSessionBinding(params: {
    sessionId: string;
    sessionKey: string;
    cwd: string;
    meta: AcpSessionMeta;
    completeLedger: boolean;
    resetLedger?: boolean;
    enforceCreationRateLimit?: "loadSession" | "resumeSession";
    replay:
      | "none"
      | {
          resolveLedger: (
            retainedCurrent: AcpLocalSessionBinding | undefined,
          ) => Promise<AcpEventLedgerReplay>;
        };
    requireExistingOnTargetChange?: boolean;
    existingLedgerSessionKey?: string;
    preserveCurrentLedgerIdentity?: boolean;
    preserveCurrentRuntimeOptions?: boolean;
    runtimeOptions?: AcpSessionRuntimeOptions;
  }): Promise<{ binding: AcpLocalSessionBinding; snapshot: SessionSnapshot }> {
    return await this.trackLifecycle(
      this.options.bindings.runCanonicalLifecycle({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        operation: async (lifecycle) => {
          const affectedSessionIds = [
            params.sessionId,
            lifecycle.current?.sessionId,
            ...lifecycle.siblings.map((binding) => binding.sessionId),
          ].filter((sessionId): sessionId is string => Boolean(sessionId));
          return await this.withSessionLocks(affectedSessionIds, async () => {
            const reset = shouldResetSession(params.meta, this.opts);
            const retainedCurrent =
              lifecycle.current?.sessionKey === params.sessionKey ? lifecycle.current : undefined;
            if (params.enforceCreationRateLimit && !retainedCurrent) {
              this.enforceSessionCreateRateLimit(params.enforceCreationRateLimit);
            }
            if (
              params.requireExistingOnTargetChange &&
              !retainedCurrent &&
              params.existingLedgerSessionKey !== params.sessionKey
            ) {
              await this.options.sessionRuntime.getExistingSessionSnapshot(params.sessionKey);
            }
            const sessionsToQuiesce = new Map<string, AcpLocalSessionBinding>();
            if (lifecycle.current) {
              sessionsToQuiesce.set(lifecycle.current.sessionId, lifecycle.current);
            }
            if (reset) {
              for (const sibling of lifecycle.siblings) {
                sessionsToQuiesce.set(sibling.sessionId, sibling);
              }
            }
            for (const binding of sessionsToQuiesce.values()) {
              await this.options.turnRuntime.quiesceSession(
                binding.sessionId,
                new Error(reset ? "ACP canonical session reset" : "ACP session rebound"),
              );
            }

            const ledgerReplay =
              params.replay === "none"
                ? EMPTY_ACP_EVENT_LEDGER_REPLAY
                : await params.replay.resolveLedger(retainedCurrent);
            const staleBindings = new Map<string, AcpLocalSessionBinding>();
            if (reset) {
              for (const sibling of lifecycle.siblings) {
                staleBindings.set(sibling.sessionId, sibling);
              }
              if (lifecycle.current?.sessionKey === params.sessionKey) {
                staleBindings.set(lifecycle.current.sessionId, lifecycle.current);
              }
            }
            await this.options.sessionRuntime.resetSessionIfNeeded({
              meta: params.meta,
              sessionKey: params.sessionKey,
              cwd: params.cwd,
            });
            if (reset) {
              // Preserve complete replay when the durable reset fails. Once the
              // reset succeeds, stale ledgers must be retired before rebinding.
              for (const stale of staleBindings.values()) {
                await this.options.sessionUpdates.invalidateLedgerSession(stale);
              }
              for (const stale of staleBindings.values()) {
                lifecycle.remove(stale.sessionId);
              }
            }

            const retainedLedgerSessionId =
              !reset && params.preserveCurrentLedgerIdentity
                ? retainedCurrent?.ledgerSessionId
                : undefined;
            const retainedRuntimeOptions = params.preserveCurrentRuntimeOptions
              ? retainedCurrent?.runtimeOptions
              : undefined;
            const ledgerSessionId = ledgerReplay.sessionId ?? retainedLedgerSessionId;
            const candidate: AcpLocalSessionBindingInput = {
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              cwd: params.cwd,
              ...(!reset && ledgerSessionId ? { ledgerSessionId } : {}),
              ...((params.runtimeOptions ?? retainedRuntimeOptions)
                ? {
                    runtimeOptions: {
                      ...(params.runtimeOptions ?? retainedRuntimeOptions),
                    },
                  }
                : {}),
            };
            const commitBeforeDelivery = reset || params.resetLedger === true;
            if (commitBeforeDelivery) {
              await this.options.sessionUpdates.startLedgerSession(candidate, {
                complete: params.completeLedger || ledgerReplay.complete,
                ...(params.resetLedger ? { reset: true } : {}),
              });
            }
            const committedBinding = commitBeforeDelivery
              ? lifecycle.replace(candidate)
              : undefined;
            const snapshot = await this.options.sessionRuntime.getSessionSnapshot(
              params.sessionKey,
              runtimePresentationOverrides(candidate.runtimeOptions),
            );
            if (!reset && params.replay !== "none") {
              await replayLocalSessionHistory({
                sessionId: params.sessionId,
                sessionKey: params.sessionKey,
                ledgerReplay,
                sessionRuntime: this.options.sessionRuntime,
                sessionUpdates: this.options.sessionUpdates,
                log: this.log,
              });
            }
            await this.sendSessionSnapshotUpdate(candidate, snapshot, {
              includeControls: false,
              record: params.resetLedger === true,
            });
            await this.options.sessionUpdates.sendAvailableCommands(candidate, {
              record: params.resetLedger === true,
            });
            if (!commitBeforeDelivery) {
              await this.options.sessionUpdates.startLedgerSession(candidate, {
                complete: params.completeLedger || ledgerReplay.complete,
              });
            }
            return {
              binding: committedBinding ?? lifecycle.replace(candidate),
              snapshot,
            };
          });
        },
      }),
    );
  }

  private async sendSessionSnapshotUpdate(
    session: AcpLocalSessionBindingInput,
    snapshot: SessionSnapshot,
    options: { includeControls: boolean; record: boolean },
  ): Promise<void> {
    const common = {
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
      record: options.record,
    };
    if (options.includeControls) {
      await this.options.sessionUpdates.emit({
        ...common,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: snapshot.modes.currentModeId,
        },
      });
      await this.options.sessionUpdates.emit({
        ...common,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: snapshot.configOptions,
        },
      });
    }
    if (snapshot.metadata) {
      await this.options.sessionUpdates.emit({
        ...common,
        update: {
          sessionUpdate: "session_info_update",
          ...snapshot.metadata,
        },
      });
    }
    if (snapshot.usage) {
      await this.options.sessionUpdates.emit({
        ...common,
        update: {
          sessionUpdate: "usage_update",
          used: snapshot.usage.used,
          size: snapshot.usage.size,
          _meta: {
            source: "local-session-store",
            approximate: true,
          },
        },
      });
    }
  }

  private requireBinding(sessionId: string): AcpLocalSessionBinding {
    const binding = this.options.bindings.get(sessionId);
    if (!binding) {
      throw new Error(`Session ${sessionId} not found`);
    }
    return binding;
  }

  private assertSupportedSessionSetup(mcpServers: ReadonlyArray<unknown>): void {
    if (mcpServers.length === 0) {
      return;
    }
    throw new Error(
      "OpenClaw ACP does not support per-session MCP servers. Configure MCP in OpenClaw instead.",
    );
  }

  private enforceSessionCreateRateLimit(
    method: "newSession" | "loadSession" | "resumeSession",
  ): void {
    const budget = this.sessionCreateRateLimiter.consume();
    if (budget.allowed) {
      return;
    }
    throw new Error(
      `ACP session creation rate limit exceeded for ${method}; retry after ${Math.ceil(budget.retryAfterMs / 1_000)}s.`,
    );
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw new Error("ACP session controller is stopped");
    }
  }

  private trackLifecycle<T>(lifecycle: Promise<T>): Promise<T> {
    this.pendingLifecycles.add(lifecycle);
    const clearLifecycle = () => {
      this.pendingLifecycles.delete(lifecycle);
    };
    void lifecycle.then(clearLifecycle, clearLifecycle);
    return lifecycle;
  }

  private async withBoundSessionLifecycle<T>(
    sessionId: string,
    operation: (binding: AcpLocalSessionBinding, lifecycle: AcpLocalSessionLifecycle) => Promise<T>,
  ): Promise<T> {
    return await this.trackLifecycle(
      this.options.bindings.runCanonicalLifecycle({
        sessionId,
        operation: async (lifecycle) =>
          await this.withSessionLocks([sessionId], async () => {
            const binding = lifecycle.current;
            if (!binding) {
              throw new Error(`Session ${sessionId} not found`);
            }
            return await operation(binding, lifecycle);
          }),
      }),
    );
  }

  private async withSessionLifecycleRequest<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertRunning();
    // Serialize setup and control from method entry so routing awaits cannot let
    // a later close overtake and then be undone by an earlier request.
    return await this.trackLifecycle(this.sessionLifecycleQueue.enqueue(sessionId, operation));
  }

  private async withSessionAdmission<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return await this.sessionAdmissionQueue.enqueue(sessionId, async () => {
      this.assertRunning();
      return await operation();
    });
  }

  private async withSessionLocks<T>(
    sessionIds: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const keys = [...new Set(sessionIds)].toSorted();
    const acquire = async (index: number): Promise<T> => {
      const key = keys[index];
      if (!key) {
        return await operation();
      }
      return await this.sessionAdmissionQueue.enqueue(key, async () => acquire(index + 1));
    };
    return await acquire(0);
  }
}
