/**
 * Subagent spawn planning helpers.
 *
 * Resolves model, thinking, and timeout choices before the sessions_spawn executor launches work.
 */
import { formatThinkingLevels } from "../../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { FastMode } from "../../../shared/fast-mode.js";
import {
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
  resolveSubagentSpawnModelSelection,
} from "../../model-selection.js";
import { resolveSubagentThinkingOverride } from "./subagent-spawn-thinking.js";

const log = createSubsystemLogger("agents/subagent-spawn-plan");

/** Splits a provider/model ref while preserving model-only refs. */
export function splitModelRef(ref?: string) {
  if (!ref) {
    return { provider: undefined, model: undefined };
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    return { provider: undefined, model: undefined };
  }
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    const provider = trimmed.slice(0, slash);
    const model = trimmed.slice(slash + 1);
    return { provider, model };
  }
  const provider = undefined;
  const model = trimmed;
  if (model) {
    return { provider, model };
  }
  return { provider: undefined, model: trimmed };
}

/**
 * A subagent run is never capped by a wall clock. Zero is the value the rest of
 * the stack already reads as "no deadline" — `resolveSubagentRunDurationMs`
 * returns undefined for it, and `resolveAgentTimeoutMs` maps `overrideSeconds: 0`
 * onto NO_TIMEOUT_MS — so returning zero disables both the run deadline and the
 * wait path that classifies a run as timed_out.
 */
const UNCAPPED_SUBAGENT_RUN_TIMEOUT_SECONDS = 0;

/**
 * Resolves the effective subagent run timeout. It is always uncapped.
 *
 * A run timeout kills a worker for taking too long, and that is the one failure
 * this product cannot absorb: the work is discarded and the customer gets silence
 * where a result should be. This replaces the 900s floor that shipped in 1.1.3 —
 * a floor still leaves a cap, and a cap still kills. Measured across the fleet,
 * the account that passed no timeout on any of its runs had the best record by a
 * wide margin, and every worker death traced back to a cap firing on a long but
 * healthy run.
 *
 * Both inputs are therefore ignored, not just the per-call one: a configured
 * `agents.defaults.subagents.runTimeoutSeconds` is refused the same way, so a
 * tenant seeded with one — or an operator who adds one later — cannot reintroduce
 * the failure for a new account.
 *
 * The parameter is still accepted rather than rejected, so an existing caller
 * does not start erroring; it is dropped with a warning that says so.
 *
 * This is not unbounded execution. The CLI's no-output kill still ends a worker
 * that has genuinely stopped producing, which is an output-based signal rather
 * than a wall clock, and `maxConcurrent` still bounds how many run at once. A
 * worker that must stop early is killed, not starved by a timer.
 */
export function resolveConfiguredSubagentRunTimeoutSeconds(params: {
  cfg: OpenClawConfig;
  runTimeoutSeconds?: number;
}) {
  const requested =
    typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
      ? Math.max(0, Math.floor(params.runTimeoutSeconds))
      : undefined;
  const configured =
    typeof params.cfg?.agents?.defaults?.subagents?.runTimeoutSeconds === "number" &&
    Number.isFinite(params.cfg.agents.defaults.subagents.runTimeoutSeconds)
      ? Math.max(0, Math.floor(params.cfg.agents.defaults.subagents.runTimeoutSeconds))
      : undefined;
  const dropped = requested ?? configured;
  if (dropped !== undefined && dropped > 0) {
    log.warn(
      `subagent run timeout ${dropped}s ignored: subagent runs are uncapped, because a run timeout kills the worker and discards its work. Kill the run to stop a worker early.`,
    );
  }
  return UNCAPPED_SUBAGENT_RUN_TIMEOUT_SECONDS;
}

/** Resolves the subagent model plus thinking patch to apply to the spawned session. */
export function resolveSubagentModelAndThinkingPlan(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  requesterAgentConfig?: unknown;
  targetAgentConfig?: unknown;
  modelOverride?: string;
  thinkingOverrideRaw?: string;
  callerThinkingRaw?: string;
  fastMode?: FastMode;
}) {
  const resolvedModel = resolveSubagentSpawnModelSelection({
    cfg: params.cfg,
    agentId: params.targetAgentId,
    modelOverride: params.modelOverride,
  });

  const thinkingPlan = resolveSubagentThinkingOverride({
    cfg: params.cfg,
    requesterAgentConfig: params.requesterAgentConfig,
    targetAgentConfig: params.targetAgentConfig,
    thinkingOverrideRaw: params.thinkingOverrideRaw,
    callerThinkingRaw: params.callerThinkingRaw,
  });
  if (thinkingPlan.status === "error") {
    const { provider, model } = splitModelRef(resolvedModel);
    // The hint is provider/model-specific because valid thinking levels vary by backend.
    const hint = formatThinkingLevels(provider, model);
    return {
      status: "error" as const,
      resolvedModel,
      error: `Invalid thinking level "${thinkingPlan.thinkingCandidateRaw}". Use one of: ${hint}.`,
    };
  }

  const modelOverrideSource = params.modelOverride?.trim() ? "user" : "auto";
  const hasConfiguredAutoModel =
    modelOverrideSource === "auto" &&
    Boolean(
      resolveSubagentConfiguredModelSelection({
        cfg: params.cfg,
        agentId: params.targetAgentId,
      }),
    );
  const configuredModelRef = hasConfiguredAutoModel ? splitModelRef(resolvedModel) : undefined;
  const modelOrigin = configuredModelRef?.model
    ? {
        provider:
          configuredModelRef.provider ??
          resolveDefaultModelForAgent({
            cfg: params.cfg,
            agentId: params.targetAgentId,
          }).provider,
        model: configuredModelRef.model,
      }
    : undefined;

  return {
    status: "ok" as const,
    resolvedModel,
    modelApplied: Boolean(resolvedModel),
    thinkingOverride: thinkingPlan.thinkingOverride,
    initialSessionPatch: {
      ...(resolvedModel
        ? {
            model: resolvedModel,
            modelOverrideSource,
            ...(modelOrigin
              ? {
                  // Config-selected models are session overrides, not legacy fallback residue.
                  // Self-origin metadata keeps cleanup from discarding them before first use.
                  modelOverrideFallbackOriginProvider: modelOrigin.provider,
                  modelOverrideFallbackOriginModel: modelOrigin.model,
                }
              : {}),
          }
        : {}),
      ...thinkingPlan.initialSessionPatch,
      ...(params.fastMode !== undefined ? { fastMode: params.fastMode } : {}),
    },
  };
}
