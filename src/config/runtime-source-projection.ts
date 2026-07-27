import { isDeepStrictEqual } from "node:util";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { isRecord } from "../utils.js";
import { isMergePatchObjectKeyAllowed } from "./merge-patch.js";
import { normalizeAgentModelRefForConfig } from "./model-input.js";
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

export type RuntimeSourceProjectionError = {
  code:
    | "incompatible-runtime-shape"
    | "ambiguous-runtime-array"
    | "ambiguous-runtime-map"
    | "blocked-runtime-key";
  key: string;
};

class AmbiguousRuntimeArrayProjectionError extends Error {
  constructor(readonly path: readonly string[]) {
    super("ambiguous runtime array projection");
  }
}

class BlockedRuntimeProjectionKeyError extends Error {
  constructor(readonly path: readonly string[]) {
    super("blocked runtime projection key");
  }
}

class AmbiguousRuntimeMapProjectionError extends Error {
  constructor(readonly path: readonly string[]) {
    super("ambiguous runtime map projection");
  }
}

function cloneCandidateValue(value: unknown, path: readonly string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((child, index) => cloneCandidateValue(child, [...path, String(index)]));
  }
  if (!isRecord(value)) {
    return structuredClone(value);
  }
  const cloned: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!isMergePatchObjectKeyAllowed(key, path.length > 0 ? path.join(".") : undefined)) {
      throw new BlockedRuntimeProjectionKeyError([...path, key]);
    }
    cloned[key] = cloneCandidateValue(child, [...path, key]);
  }
  return cloned;
}

function containsAuthoredReference(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes("${");
  }
  if (Array.isArray(value)) {
    return value.some(containsAuthoredReference);
  }
  if (!isRecord(value)) {
    return false;
  }
  if (Object.hasOwn(value, "$include")) {
    return true;
  }
  if (typeof value.source === "string" && typeof value.id === "string") {
    return true;
  }
  return Object.values(value).some(containsAuthoredReference);
}

function isAgentModelMapPath(path: readonly string[]): boolean {
  return (
    (path.length === 3 && path[0] === "agents" && path[1] === "defaults" && path[2] === "models") ||
    (path.length === 4 &&
      path[0] === "agents" &&
      (path[1] === "entries" || path[1] === "list") &&
      path[3] === "models")
  );
}

function findUniqueArrayIdentityMatch(params: {
  runtime: unknown[];
  candidateValue: unknown;
  unusedRuntimeIndexes: ReadonlySet<number>;
}): number | undefined {
  if (!isRecord(params.candidateValue)) {
    return undefined;
  }
  for (const key of ["id", "agentId"] as const) {
    const identity = params.candidateValue[key];
    if (typeof identity !== "string") {
      continue;
    }
    const matches = [...params.unusedRuntimeIndexes].filter((index) => {
      const runtimeValue = params.runtime[index];
      return isRecord(runtimeValue) && runtimeValue[key] === identity;
    });
    if (matches.length === 1) {
      return matches[0];
    }
  }
  return undefined;
}

function projectRuntimeCandidateOntoSource(
  source: unknown,
  runtime: unknown,
  candidate: unknown,
  path: readonly string[] = [],
): unknown {
  if (isDeepStrictEqual(runtime, candidate)) {
    return structuredClone(source);
  }
  if (Array.isArray(runtime) && Array.isArray(candidate)) {
    if (!Array.isArray(source)) {
      throw new AmbiguousRuntimeArrayProjectionError(path);
    }
    const sourceArray = source;
    if (runtime.length > sourceArray.length) {
      throw new AmbiguousRuntimeArrayProjectionError(path);
    }
    const matchedRuntimeIndexes = new Array<number | undefined>(candidate.length);
    const unusedRuntimeIndexes = new Set(runtime.keys());
    const unmatchedForPermutation = new Set(runtime.keys());
    const hasSameMultiset = candidate.every((candidateValue) => {
      const runtimeIndex = [...unmatchedForPermutation].find((index) =>
        isDeepStrictEqual(runtime[index], candidateValue),
      );
      if (runtimeIndex === undefined) {
        return false;
      }
      unmatchedForPermutation.delete(runtimeIndex);
      return true;
    });
    const isSameLengthPermutation =
      candidate.length === runtime.length &&
      hasSameMultiset &&
      unmatchedForPermutation.size === 0 &&
      !isDeepStrictEqual(candidate, runtime);
    const hasUniqueCrossIndexMatch = candidate.some((candidateValue, candidateIndex) => {
      const matchingRuntimeIndexes = runtime.flatMap((runtimeValue, runtimeIndex) =>
        isDeepStrictEqual(runtimeValue, candidateValue) ? [runtimeIndex] : [],
      );
      return matchingRuntimeIndexes.length === 1 && matchingRuntimeIndexes[0] !== candidateIndex;
    });
    const potentialShift =
      candidate.length !== runtime.length || hasUniqueCrossIndexMatch || isSameLengthPermutation;
    for (const [candidateIndex, candidateValue] of candidate.entries()) {
      const allEquivalentRuntimeIndexes = runtime.flatMap((runtimeValue, runtimeIndex) =>
        isDeepStrictEqual(runtimeValue, candidateValue) ? [runtimeIndex] : [],
      );
      const candidateEquivalentCount = candidate.filter((value) =>
        isDeepStrictEqual(value, candidateValue),
      ).length;
      const multiplicityIncreases = candidateEquivalentCount > allEquivalentRuntimeIndexes.length;
      if (
        candidateEquivalentCount !== allEquivalentRuntimeIndexes.length &&
        (multiplicityIncreases
          ? allEquivalentRuntimeIndexes.some((runtimeIndex) =>
              containsAuthoredReference(sourceArray[runtimeIndex]),
            )
          : allEquivalentRuntimeIndexes.some(
              (runtimeIndex) =>
                !isDeepStrictEqual(
                  sourceArray[runtimeIndex],
                  sourceArray[allEquivalentRuntimeIndexes[0]!],
                ),
            ))
      ) {
        throw new AmbiguousRuntimeArrayProjectionError(path);
      }
      const sameIndexMatches =
        unusedRuntimeIndexes.has(candidateIndex) &&
        isDeepStrictEqual(runtime[candidateIndex], candidateValue);
      if (sameIndexMatches) {
        matchedRuntimeIndexes[candidateIndex] = candidateIndex;
        unusedRuntimeIndexes.delete(candidateIndex);
        continue;
      }
      const equivalentRuntimeIndexes = [...unusedRuntimeIndexes].filter((runtimeIndex) =>
        isDeepStrictEqual(runtime[runtimeIndex], candidateValue),
      );
      if (
        potentialShift &&
        equivalentRuntimeIndexes.length > 1 &&
        equivalentRuntimeIndexes.some(
          (runtimeIndex) =>
            !isDeepStrictEqual(
              sourceArray[runtimeIndex],
              sourceArray[equivalentRuntimeIndexes[0]!],
            ),
        )
      ) {
        throw new AmbiguousRuntimeArrayProjectionError(path);
      }
      const matchedIndex =
        equivalentRuntimeIndexes[0] ??
        findUniqueArrayIdentityMatch({
          runtime,
          candidateValue,
          unusedRuntimeIndexes,
        });
      if (matchedIndex !== undefined) {
        matchedRuntimeIndexes[candidateIndex] = matchedIndex;
        unusedRuntimeIndexes.delete(matchedIndex);
      }
    }
    for (const [candidateIndex, matchedIndex] of matchedRuntimeIndexes.entries()) {
      if (matchedIndex === undefined || matchedIndex === candidateIndex) {
        continue;
      }
      const equivalentRuntimeIndexes = runtime.flatMap((runtimeValue, runtimeIndex) =>
        isDeepStrictEqual(runtimeValue, candidate[candidateIndex]) ? [runtimeIndex] : [],
      );
      if (
        equivalentRuntimeIndexes.length > 1 &&
        equivalentRuntimeIndexes.some(
          (runtimeIndex) =>
            !isDeepStrictEqual(
              sourceArray[runtimeIndex],
              sourceArray[equivalentRuntimeIndexes[0]!],
            ),
        )
      ) {
        throw new AmbiguousRuntimeArrayProjectionError(path);
      }
    }
    const unmatchedCandidateCount = candidate.reduce(
      (count, _value, index) => count + (matchedRuntimeIndexes[index] === undefined ? 1 : 0),
      0,
    );
    if (
      unmatchedCandidateCount > 1 &&
      [...unusedRuntimeIndexes].some((runtimeIndex) =>
        containsAuthoredReference(sourceArray[runtimeIndex]),
      )
    ) {
      throw new AmbiguousRuntimeArrayProjectionError(path);
    }
    const shifted =
      candidate.length !== runtime.length ||
      matchedRuntimeIndexes.some(
        (runtimeIndex, candidateIndex) =>
          runtimeIndex !== undefined && runtimeIndex !== candidateIndex,
      );
    return candidate.map((candidateValue, candidateIndex) => {
      const matchedIndex = matchedRuntimeIndexes[candidateIndex];
      if (matchedIndex !== undefined) {
        return projectRuntimeCandidateOntoSource(
          sourceArray[matchedIndex],
          runtime[matchedIndex],
          candidateValue,
          [...path, String(candidateIndex)],
        );
      }
      if (!shifted && unusedRuntimeIndexes.has(candidateIndex)) {
        unusedRuntimeIndexes.delete(candidateIndex);
        return projectRuntimeCandidateOntoSource(
          sourceArray[candidateIndex],
          runtime[candidateIndex],
          candidateValue,
          [...path, String(candidateIndex)],
        );
      }
      if (
        [...unusedRuntimeIndexes].some((runtimeIndex) =>
          containsAuthoredReference(sourceArray[runtimeIndex]),
        )
      ) {
        throw new AmbiguousRuntimeArrayProjectionError(path);
      }
      return cloneCandidateValue(candidateValue, [...path, String(candidateIndex)]);
    });
  }
  if (isRecord(runtime) && isRecord(candidate)) {
    const sourceRecord = isRecord(source) ? source : {};
    const projected = structuredClone(sourceRecord);
    const exactRuntimeSourceByCandidate = new Map<string, string>();
    for (const [candidateKey, candidateValue] of Object.entries(candidate)) {
      const matches = Object.keys(runtime).filter((runtimeKey) =>
        isDeepStrictEqual(runtime[runtimeKey], candidateValue),
      );
      const candidateChangesExistingKey =
        !Object.hasOwn(runtime, candidateKey) ||
        !isDeepStrictEqual(runtime[candidateKey], candidateValue);
      if (
        matches.length > 1 &&
        candidateChangesExistingKey &&
        matches.some(
          (runtimeKey) =>
            !Object.hasOwn(sourceRecord, runtimeKey) ||
            containsAuthoredReference(sourceRecord[runtimeKey]),
        )
      ) {
        throw new AmbiguousRuntimeMapProjectionError(path);
      }
      if (matches.length === 1) {
        exactRuntimeSourceByCandidate.set(candidateKey, matches[0]!);
      }
    }
    for (const runtimeKey of Object.keys(runtime)) {
      const consumers = [...exactRuntimeSourceByCandidate.values()].filter(
        (sourceKey) => sourceKey === runtimeKey,
      ).length;
      if (
        consumers > 1 &&
        (!Object.hasOwn(sourceRecord, runtimeKey) ||
          containsAuthoredReference(sourceRecord[runtimeKey]))
      ) {
        throw new AmbiguousRuntimeMapProjectionError(path);
      }
    }
    const authoredKeyByRuntimeKey = new Map<string, string>();
    if (isAgentModelMapPath(path)) {
      for (const runtimeKey of Object.keys(runtime)) {
        const matches = Object.keys(sourceRecord).filter(
          (sourceKey) => normalizeAgentModelRefForConfig(sourceKey) === runtimeKey,
        );
        const runtimeEntryChanges =
          !Object.hasOwn(candidate, runtimeKey) ||
          !isDeepStrictEqual(runtime[runtimeKey], candidate[runtimeKey]);
        if (matches.length > 1 && runtimeEntryChanges) {
          throw new AmbiguousRuntimeMapProjectionError(path);
        }
        if (matches.length === 1) {
          authoredKeyByRuntimeKey.set(runtimeKey, matches[0]!);
        }
      }
    }
    const removedKeys = Object.keys(runtime).filter((key) => !Object.hasOwn(candidate, key));
    const addedKeys = Object.keys(candidate).filter((key) => !Object.hasOwn(runtime, key));
    const availableRemovedKeys = new Set(removedKeys);
    const renamedFromByAdded = new Map<string, string>();
    const matchesByAdded = new Map(
      addedKeys.map((addedKey) => [
        addedKey,
        removedKeys.filter((removedKey) =>
          isDeepStrictEqual(runtime[removedKey], candidate[addedKey]),
        ),
      ]),
    );
    for (const addedKey of addedKeys) {
      const matches = matchesByAdded.get(addedKey) ?? [];
      const removedKey = matches[0];
      const competingAddedCount = removedKey
        ? [...matchesByAdded.values()].filter((candidateMatches) =>
            candidateMatches.includes(removedKey),
          ).length
        : 0;
      if (matches.length === 1 && removedKey && competingAddedCount === 1) {
        renamedFromByAdded.set(addedKey, removedKey);
        availableRemovedKeys.delete(removedKey);
      }
    }
    const unmatchedAddedKeys = addedKeys.filter((key) => !renamedFromByAdded.has(key));
    if (
      unmatchedAddedKeys.length > 0 &&
      [...availableRemovedKeys].some((key) => containsAuthoredReference(sourceRecord[key]))
    ) {
      throw new AmbiguousRuntimeMapProjectionError(path);
    }
    const keys = new Set([...Object.keys(runtime), ...Object.keys(candidate)]);
    for (const key of keys) {
      if (!isMergePatchObjectKeyAllowed(key, path.length > 0 ? path.join(".") : undefined)) {
        throw new BlockedRuntimeProjectionKeyError([...path, key]);
      }
      if (!Object.hasOwn(candidate, key)) {
        delete projected[key];
        const authoredKey = authoredKeyByRuntimeKey.get(key);
        if (authoredKey && authoredKey !== key) {
          delete projected[authoredKey];
        }
        continue;
      }
      if (!Object.hasOwn(runtime, key)) {
        const renamedFrom = exactRuntimeSourceByCandidate.get(key) ?? renamedFromByAdded.get(key);
        projected[key] = renamedFrom
          ? Object.hasOwn(sourceRecord, renamedFrom)
            ? projectRuntimeCandidateOntoSource(
                sourceRecord[renamedFrom],
                runtime[renamedFrom],
                candidate[key],
                [...path, key],
              )
            : cloneCandidateValue(candidate[key], [...path, key])
          : cloneCandidateValue(candidate[key], [...path, key]);
        continue;
      }
      if (!isDeepStrictEqual(runtime[key], candidate[key])) {
        const exactRuntimeSource = exactRuntimeSourceByCandidate.get(key);
        const authoredKey = authoredKeyByRuntimeKey.get(key) ?? key;
        if (authoredKey !== key) {
          delete projected[authoredKey];
        }
        projected[key] =
          exactRuntimeSource && exactRuntimeSource !== key
            ? projectRuntimeCandidateOntoSource(
                sourceRecord[exactRuntimeSource],
                runtime[exactRuntimeSource],
                candidate[key],
                [...path, key],
              )
            : projectRuntimeCandidateOntoSource(
                sourceRecord[authoredKey],
                runtime[key],
                candidate[key],
                [...path, key],
              );
      }
    }
    return projected;
  }
  return cloneCandidateValue(candidate, path);
}

function findIncompatibleTopLevelRuntimeProjectionKey(params: {
  runtimeSnapshot: OpenClawConfig;
  candidate: OpenClawConfig;
}): string | undefined {
  const runtime = params.runtimeSnapshot as Record<string, unknown>;
  const candidate = params.candidate as Record<string, unknown>;
  for (const key of Object.keys(runtime)) {
    if (!Object.hasOwn(candidate, key)) {
      return key;
    }
    const runtimeValue = runtime[key];
    const candidateValue = candidate[key];
    const runtimeType = Array.isArray(runtimeValue)
      ? "array"
      : runtimeValue === null
        ? "null"
        : typeof runtimeValue;
    const candidateType = Array.isArray(candidateValue)
      ? "array"
      : candidateValue === null
        ? "null"
        : typeof candidateValue;
    if (runtimeType !== candidateType) {
      return key;
    }
  }
  return undefined;
}

/** Projects a runtime-derived candidate onto an explicit authored source snapshot. */
export function projectRuntimeConfigOntoSourceSnapshot(params: {
  sourceSnapshot: OpenClawConfig;
  runtimeSnapshot: OpenClawConfig;
  candidate: OpenClawConfig;
}): Result<OpenClawConfig, RuntimeSourceProjectionError> {
  if (params.candidate === params.runtimeSnapshot) {
    return ok(params.sourceSnapshot);
  }
  const incompatibleKey = findIncompatibleTopLevelRuntimeProjectionKey({
    runtimeSnapshot: params.runtimeSnapshot,
    candidate: params.candidate,
  });
  if (incompatibleKey !== undefined) {
    return err({ code: "incompatible-runtime-shape", key: incompatibleKey });
  }
  try {
    return ok(
      projectRuntimeCandidateOntoSource(
        params.sourceSnapshot,
        params.runtimeSnapshot,
        params.candidate,
      ) as OpenClawConfig,
    );
  } catch (error) {
    if (error instanceof AmbiguousRuntimeArrayProjectionError) {
      return err({
        code: "ambiguous-runtime-array",
        key: error.path.length > 0 ? error.path.join(".") : "<root>",
      });
    }
    if (error instanceof BlockedRuntimeProjectionKeyError) {
      return err({
        code: "blocked-runtime-key",
        key: error.path.join("."),
      });
    }
    if (error instanceof AmbiguousRuntimeMapProjectionError) {
      return err({
        code: "ambiguous-runtime-map",
        key: error.path.length > 0 ? error.path.join(".") : "<root>",
      });
    }
    throw error;
  }
}

/** Projects a runtime-derived config back onto the active authored source snapshot. */
export function projectConfigOntoRuntimeSourceSnapshot(config: OpenClawConfig): OpenClawConfig {
  const runtimeConfigSnapshot = getRuntimeConfigSnapshot();
  const runtimeConfigSourceSnapshot = getRuntimeConfigSourceSnapshot();
  if (!runtimeConfigSnapshot || !runtimeConfigSourceSnapshot) {
    return config;
  }
  const projection = projectRuntimeConfigOntoSourceSnapshot({
    sourceSnapshot: runtimeConfigSourceSnapshot,
    runtimeSnapshot: runtimeConfigSnapshot,
    candidate: config,
  });
  return projection.ok ? projection.value : config;
}
