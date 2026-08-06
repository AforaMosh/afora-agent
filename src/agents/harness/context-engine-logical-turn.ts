import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import {
  resolveContextEngineOwnerPluginId,
  resolveLogicalTurnContextEngines,
} from "../../context-engine/registry.js";
import type { ContextEngine } from "../../context-engine/types.js";

const LOGICAL_TURN_ENGINE_METHODS = new Set<PropertyKey>(
  "bootstrap maintain ingest ingestBatch afterTurn assemble compact prepareSubagentSpawn onSubagentEnded".split(
    " ",
  ),
);

function isAbortRejection(error: unknown, params: unknown): boolean {
  const signal = (params as { abortSignal?: unknown } | null | undefined)?.abortSignal;
  if (!signal || typeof signal !== "object" || !("aborted" in signal) || !signal.aborted) {
    return false;
  }
  if (error === (signal as AbortSignal).reason) {
    return true;
  }
  return error instanceof Error && error.name === "AbortError";
}

export type ContextEngineLogicalTurnLease = {
  readonly engine: ContextEngine;
  readonly effectiveEngine: ContextEngine;
  readonly effectiveEnginePluginId?: string;
  readonly degraded: boolean;
  deferDisposalUntil: (promise: Promise<unknown>) => void;
  dispose: () => Promise<void>;
};

export async function createContextEngineLogicalTurnLease(params: {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  warn?: (message: string) => void;
}): Promise<ContextEngineLogicalTurnLease> {
  ensureContextEnginesInitialized();
  const resolution = await resolveLogicalTurnContextEngines(params.config, {
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
  });
  let effectiveEngine = resolution.configuredEngine;
  let degraded = Boolean(resolution.configuredFailure);
  let warned = false;
  let disposed = false;
  const disposalHolds = new Set<Promise<unknown>>();

  const warnOnce = (reason: string) => {
    if (warned) {
      return;
    }
    warned = true;
    (params.warn ?? console.warn)(
      `[context-engine] Context engine "${sanitizeForLog(resolution.configuredEngineId)}" degraded to "${sanitizeForLog(resolution.defaultEngine.info.id)}" for this logical turn: ${sanitizeForLog(reason)}`,
    );
  };
  if (resolution.configuredFailure) {
    effectiveEngine = resolution.defaultEngine;
    warnOnce(resolution.configuredFailure);
  }

  const engine = new Proxy({} as ContextEngine, {
    get(_target, property) {
      if (property === "info") {
        return effectiveEngine.info;
      }
      if (property === "dispose") {
        return async () => await lease.dispose();
      }
      const value = Reflect.get(effectiveEngine, property, effectiveEngine);
      if (typeof value !== "function") {
        return value;
      }
      if (!LOGICAL_TURN_ENGINE_METHODS.has(property)) {
        return value.bind(effectiveEngine);
      }
      return async (operationParams: unknown) => {
        const selectedEngine = effectiveEngine;
        const method = Reflect.get(selectedEngine, property, selectedEngine) as (
          value: unknown,
        ) => unknown;
        try {
          return await method.call(selectedEngine, operationParams);
        } catch (error) {
          if (
            isAbortRejection(error, operationParams) ||
            selectedEngine === resolution.defaultEngine
          ) {
            throw error;
          }
          degraded = true;
          effectiveEngine = resolution.defaultEngine;
          warnOnce(error instanceof Error ? error.message : String(error));
          const fallbackMethod = Reflect.get(effectiveEngine, property, effectiveEngine) as
            | ((value: unknown) => unknown)
            | undefined;
          if (typeof fallbackMethod !== "function") {
            throw error;
          }
          return await fallbackMethod.call(effectiveEngine, operationParams);
        }
      };
    },
  });

  const lease: ContextEngineLogicalTurnLease = {
    engine,
    get effectiveEngine() {
      return effectiveEngine;
    },
    get effectiveEnginePluginId() {
      return resolveContextEngineOwnerPluginId(effectiveEngine);
    },
    get degraded() {
      return degraded;
    },
    deferDisposalUntil(promise) {
      if (disposed) {
        throw new Error("context-engine logical turn lease is already disposed");
      }
      disposalHolds.add(promise);
      void promise.finally(() => disposalHolds.delete(promise)).catch(() => {});
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      const engines = new Set([resolution.configuredEngine, resolution.defaultEngine]);
      const disposeEngines = async () => {
        await Promise.allSettled(
          [...engines].map(async (resolved) => {
            await resolved.dispose?.();
          }),
        );
      };
      if (disposalHolds.size > 0) {
        void Promise.allSettled([...disposalHolds]).then(disposeEngines);
        return;
      }
      await disposeEngines();
    },
  };
  return lease;
}
