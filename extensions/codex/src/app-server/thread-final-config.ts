import { mergeCodexThreadConfigs } from "./plugin-thread-config.js";
import type {
  CodexStartOrResumeThreadParams,
  CodexThreadFinalConfigPatchDecision,
  CodexThreadFinalConfigPatchResult,
} from "./thread-lifecycle-types.js";

/** Combines static safety caps with the per-start/resume hook relay patch. */
export function resolveCodexThreadFinalConfigPatch(
  params: Pick<
    CodexStartOrResumeThreadParams,
    "buildFinalConfigPatch" | "finalConfigPatch" | "nativeHookRelayGeneration"
  >,
  decision: CodexThreadFinalConfigPatchDecision,
): CodexThreadFinalConfigPatchResult {
  const built = params.buildFinalConfigPatch?.(decision);
  return {
    // The dynamic builder owns per-thread relay state, but static safety caps
    // remain final so a builder cannot widen scheduled authority.
    configPatch: mergeCodexThreadConfigs(built?.configPatch, params.finalConfigPatch),
    nativeHookRelayGeneration: built?.nativeHookRelayGeneration ?? params.nativeHookRelayGeneration,
  };
}
