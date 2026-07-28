import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../utils.js";
import {
  applyConfigOperations,
  createRuntimeConfigMutationOperations,
} from "./config-path-mutation.js";
import { getRuntimeConfigSnapshot, getRuntimeConfigSourceSnapshot } from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.js";

export function projectSourceOntoRuntimeShape(source: unknown, runtime: unknown): unknown {
  if (!isRecord(source) || !isRecord(runtime)) {
    return structuredClone(source);
  }
  return Object.fromEntries(
    Object.entries(source).map(([key, sourceValue]) => [
      key,
      key in runtime
        ? projectSourceOntoRuntimeShape(sourceValue, runtime[key])
        : structuredClone(sourceValue),
    ]),
  );
}

/** Projects a complete runtime-shaped candidate onto an authored source baseline. */
export function projectRuntimeConfigOntoSourceSnapshot(params: {
  sourceSnapshot: OpenClawConfig;
  runtimeSnapshot: OpenClawConfig;
  candidate: OpenClawConfig;
  sensitiveSourcePaths?: readonly (readonly string[])[];
}): OpenClawConfig {
  const assertArraysProjectWithoutResolution = (
    source: unknown,
    runtime: unknown,
    candidate: unknown,
    path: readonly string[] = [],
  ): void => {
    if (Array.isArray(runtime) && Array.isArray(candidate)) {
      if (!isDeepStrictEqual(runtime, candidate) && !isDeepStrictEqual(source, runtime)) {
        throw new Error(
          `Deprecated writeConfigFile(config, options) cannot safely replace runtime-resolved array at ${path.join(".") || "<root>"}; use mutateConfigFile() with source intent.`,
        );
      }
      return;
    }
    if (!isRecord(runtime) || !isRecord(candidate)) {
      return;
    }
    const sourceRecord = isRecord(source) ? source : {};
    for (const key of new Set([...Object.keys(runtime), ...Object.keys(candidate)])) {
      assertArraysProjectWithoutResolution(sourceRecord[key], runtime[key], candidate[key], [
        ...path,
        key,
      ]);
    }
  };
  assertArraysProjectWithoutResolution(
    params.sourceSnapshot,
    params.runtimeSnapshot,
    params.candidate,
  );
  const operations = createRuntimeConfigMutationOperations({
    source: params.sourceSnapshot,
    runtime: params.runtimeSnapshot,
    candidate: params.candidate,
    // Compatibility candidates cannot remove defaults that have no authored
    // source path; applying those unsets to the source is intentionally a no-op.
    runtimeOnlyUnsetPolicy: "ignore",
    sensitiveSourcePaths: params.sensitiveSourcePaths,
  });
  return applyConfigOperations(params.sourceSnapshot, operations);
}

function hasCompatibleTopLevelShape(runtime: OpenClawConfig, candidate: OpenClawConfig): boolean {
  const runtimeRecord = runtime as Record<string, unknown>;
  const candidateRecord = candidate as Record<string, unknown>;
  return Object.entries(runtimeRecord).every(([key, runtimeValue]) => {
    if (!Object.hasOwn(candidateRecord, key)) {
      return false;
    }
    const candidateValue = candidateRecord[key];
    if (Array.isArray(runtimeValue) || Array.isArray(candidateValue)) {
      return Array.isArray(runtimeValue) && Array.isArray(candidateValue);
    }
    return runtimeValue === null || candidateValue === null
      ? runtimeValue === null && candidateValue === null
      : typeof runtimeValue === typeof candidateValue;
  });
}

/** Projects a runtime-derived config back onto the active authored source snapshot. */
export function projectConfigOntoRuntimeSourceSnapshot(config: OpenClawConfig): OpenClawConfig {
  const runtimeSnapshot = getRuntimeConfigSnapshot();
  const sourceSnapshot = getRuntimeConfigSourceSnapshot();
  if (!runtimeSnapshot || !sourceSnapshot || !hasCompatibleTopLevelShape(runtimeSnapshot, config)) {
    return config;
  }
  if (config === runtimeSnapshot) {
    return sourceSnapshot ?? config;
  }
  return projectRuntimeConfigOntoSourceSnapshot({
    sourceSnapshot,
    runtimeSnapshot,
    candidate: config,
  });
}
