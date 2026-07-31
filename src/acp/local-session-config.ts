/** ACP session config option normalization and presentation overrides. */
import type { AcpSessionRuntimeOptions } from "@openclaw/acp-core/types";
import { normalizeFastMode } from "@openclaw/normalization-core/string-coerce";
import { parseRuntimeTimeoutSecondsInput } from "./control-plane/runtime-options.js";
import type { AcpLocalSessionPatch } from "./local-session-runtime.js";
import {
  ACP_ELEVATED_LEVEL_CONFIG_ID,
  ACP_FAST_MODE_CONFIG_ID,
  ACP_REASONING_LEVEL_CONFIG_ID,
  ACP_RESPONSE_USAGE_CONFIG_ID,
  ACP_THOUGHT_LEVEL_CONFIG_ID,
  ACP_TIMEOUT_CONFIG_ID,
  ACP_TIMEOUT_SECONDS_CONFIG_ID,
  ACP_TRACE_LEVEL_CONFIG_ID,
  ACP_VERBOSE_LEVEL_CONFIG_ID,
  type AcpSessionPresentationRow,
} from "./translator.presentation.js";

type AcpSessionConfigPatch = {
  overrides: Partial<AcpSessionPresentationRow>;
  patch?: AcpLocalSessionPatch;
  runtimePatch?: Partial<AcpSessionRuntimeOptions>;
};

export function runtimePresentationOverrides(
  runtimeOptions: Readonly<AcpSessionRuntimeOptions> | undefined,
): Partial<AcpSessionPresentationRow> {
  return typeof runtimeOptions?.timeoutSeconds === "number"
    ? { timeoutSeconds: runtimeOptions.timeoutSeconds }
    : {};
}

export function resolveAcpSessionConfigPatch(
  configId: string,
  value: string | boolean,
): AcpSessionConfigPatch {
  if (typeof value !== "string") {
    throw new Error(
      `OpenClaw ACP does not support non-string session config option values for "${configId}".`,
    );
  }
  switch (configId) {
    case ACP_THOUGHT_LEVEL_CONFIG_ID:
      return {
        patch: { thinkingLevel: value },
        overrides: { thinkingLevel: value },
      };
    case ACP_FAST_MODE_CONFIG_ID: {
      const fastMode = normalizeFastMode(value);
      if (fastMode === undefined) {
        throw new Error(`Unsupported fast mode value: ${value}`);
      }
      return {
        patch: { fastMode },
        overrides: { fastMode },
      };
    }
    case ACP_VERBOSE_LEVEL_CONFIG_ID:
      return {
        patch: { verboseLevel: value },
        overrides: { verboseLevel: value },
      };
    case ACP_TRACE_LEVEL_CONFIG_ID:
      return {
        patch: { traceLevel: value },
        overrides: { traceLevel: value },
      };
    case ACP_REASONING_LEVEL_CONFIG_ID:
      return {
        patch: { reasoningLevel: value },
        overrides: { reasoningLevel: value },
      };
    case ACP_RESPONSE_USAGE_CONFIG_ID: {
      const next =
        value === "inherit"
          ? null
          : (value as Exclude<AcpLocalSessionPatch["responseUsage"], null | undefined>);
      return {
        patch: { responseUsage: next },
        overrides: {
          responseUsage: next as AcpSessionPresentationRow["responseUsage"],
        },
      };
    }
    case ACP_ELEVATED_LEVEL_CONFIG_ID:
      return {
        patch: { elevatedLevel: value },
        overrides: { elevatedLevel: value },
      };
    case ACP_TIMEOUT_CONFIG_ID:
    case ACP_TIMEOUT_SECONDS_CONFIG_ID: {
      if (value === "inherit") {
        return {
          runtimePatch: { timeoutSeconds: undefined },
          overrides: { timeoutSeconds: undefined },
        };
      }
      const timeoutSeconds = parseRuntimeTimeoutSecondsInput(value);
      return {
        runtimePatch: { timeoutSeconds },
        overrides: { timeoutSeconds },
      };
    }
    default:
      throw new Error(`OpenClaw ACP does not support session config option "${configId}".`);
  }
}
