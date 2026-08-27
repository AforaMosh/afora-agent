/**
 * Resolves subagent thinking-level inheritance and overrides. Spawning uses
 * this helper to patch the child session without leaking invalid caller input.
 */
import { asOptionalObjectRecord } from "@afora/normalization-core/record-coerce";
import { normalizeOptionalString } from "@afora/normalization-core/string-coerce";
import { normalizeThinkLevel } from "../../../auto-reply/thinking.shared.js";
import type { AforaConfig } from "../../../config/types.afora.js";

/** Resolves subagent thinking override and initial session patch from caller/agent config. */
export function resolveSubagentThinkingOverride(params: {
  cfg: AforaConfig;
  requesterAgentConfig?: unknown;
  targetAgentConfig?: unknown;
  thinkingOverrideRaw?: string;
  callerThinkingRaw?: string;
}) {
  const requesterSubagents = asOptionalObjectRecord(
    asOptionalObjectRecord(params.requesterAgentConfig)?.subagents,
  );
  const targetSubagents = asOptionalObjectRecord(
    asOptionalObjectRecord(params.targetAgentConfig)?.subagents,
  );
  const defaultSubagents = asOptionalObjectRecord(params.cfg.agents?.defaults?.subagents);
  const resolvedThinkingDefaultRaw =
    normalizeOptionalString(requesterSubagents?.thinking) ??
    normalizeOptionalString(targetSubagents?.thinking) ??
    normalizeOptionalString(defaultSubagents?.thinking);

  const overrideCandidateRaw = params.thinkingOverrideRaw || resolvedThinkingDefaultRaw;
  if (overrideCandidateRaw) {
    const normalizedThinking = normalizeThinkLevel(overrideCandidateRaw);
    if (!normalizedThinking) {
      return {
        status: "error" as const,
        thinkingCandidateRaw: overrideCandidateRaw,
      };
    }

    return {
      status: "ok" as const,
      thinkingOverride: normalizedThinking,
      initialSessionPatch: {
        thinkingLevel: normalizedThinking,
      },
    };
  }

  if (!params.callerThinkingRaw) {
    return {
      status: "ok" as const,
      thinkingOverride: undefined,
      initialSessionPatch: {},
    };
  }

  const normalizedThinking = normalizeThinkLevel(params.callerThinkingRaw);
  if (!normalizedThinking) {
    return {
      status: "ok" as const,
      thinkingOverride: undefined,
      initialSessionPatch: {},
    };
  }

  return {
    status: "ok" as const,
    thinkingOverride: undefined,
    initialSessionPatch: {
      thinkingLevel: normalizedThinking,
    },
  };
}
