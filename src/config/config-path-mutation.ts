// Applies immutable path removals to config-like objects.
import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { LEGACY_IMPLICIT_AGENT_ID } from "../routing/session-key.js";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import { containsEnvVarReference } from "./env-substitution.js";
import { applyMergePatch } from "./merge-patch.js";
import { isSensitiveConfigPath } from "./sensitive-paths.js";
import type { OpenClawConfig } from "./types.js";
import { isSecretRef } from "./types.secrets.js";

export type ConfigPath = readonly string[];

export type ConfigMutationOperation =
  | {
      kind: "set";
      path: ConfigPath;
      value: unknown;
      /** Array-valued container depths copied from the validated candidate. */
      arrayContainerDepths?: readonly number[];
    }
  | { kind: "unset"; path: ConfigPath; strictIncludeOwnership?: boolean }
  | { kind: "merge"; patch: unknown };

export function configPathExists(root: unknown, path: ConfigPath): boolean {
  let current = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = parseConfigPathArrayIndex(segment);
      if (index === undefined || index >= current.length) {
        return false;
      }
      current = current[index];
    } else if (isWritePlainObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return false;
    }
  }
  return true;
}

function configPathHasIncludeOwner(root: unknown, path: ConfigPath): boolean {
  let current = root;
  for (const segment of path) {
    if (isWritePlainObject(current) && Object.hasOwn(current, "$include")) {
      return true;
    }
    if (Array.isArray(current)) {
      const index = parseConfigPathArrayIndex(segment);
      if (index === undefined || index >= current.length) {
        return false;
      }
      current = current[index];
    } else if (isWritePlainObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return false;
    }
  }
  return isWritePlainObject(current) && Object.hasOwn(current, "$include");
}

function isFirstAuthoredRosterImplicitMainUnset(params: {
  source: unknown;
  runtime: unknown;
  candidate: unknown;
  path: ConfigPath;
}): boolean {
  const implicitMainPath = ["agents", "entries", LEGACY_IMPLICIT_AGENT_ID];
  if (
    params.path.length !== implicitMainPath.length ||
    !params.path.every((segment, index) => segment === implicitMainPath[index]) ||
    configPathExists(params.source, ["agents", "entries"])
  ) {
    return false;
  }
  const runtimeEntries = readConfigPath(params.runtime, ["agents", "entries"]);
  const runtimeMain = readConfigPath(params.runtime, implicitMainPath);
  const candidateEntries = readConfigPath(params.candidate, ["agents", "entries"]);
  return (
    isWritePlainObject(runtimeEntries) &&
    Object.keys(runtimeEntries).length === 1 &&
    isWritePlainObject(runtimeMain) &&
    runtimeMain.default === true &&
    isWritePlainObject(candidateEntries) &&
    Object.keys(candidateEntries).some((agentId) => agentId !== LEGACY_IMPLICIT_AGENT_ID)
  );
}

function readConfigPath(root: unknown, path: ConfigPath): unknown {
  let current = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = parseConfigPathArrayIndex(segment);
      current = index === undefined ? undefined : current[index];
    } else if (isWritePlainObject(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Converts a complete candidate diff into explicit source operations. */
export function createConfigMutationOperations(
  base: unknown,
  target: unknown,
  path: ConfigPath = [],
): ConfigMutationOperation[] {
  const assertNoBlockedKeys = (value: unknown, valuePath: ConfigPath): void => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => assertNoBlockedKeys(child, [...valuePath, String(index)]));
      return;
    }
    if (!isWritePlainObject(value)) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (isBlockedObjectKey(key)) {
        throw new Error(`Blocked config key at ${[...valuePath, key].join(".")}.`);
      }
      assertNoBlockedKeys(child, [...valuePath, key]);
    }
  };
  assertNoBlockedKeys(target, path);
  if (isDeepStrictEqual(base, target)) {
    return [];
  }
  if (Array.isArray(base) && Array.isArray(target) && base.length === target.length) {
    return target.flatMap((value, index) =>
      createConfigMutationOperations(base[index], value, [...path, String(index)]),
    );
  }
  if (Array.isArray(base) && isWritePlainObject(target)) {
    return [{ kind: "set", path, value: structuredClone(target) }];
  }
  if (!isWritePlainObject(target)) {
    return [{ kind: "set", path, value: structuredClone(target) }];
  }
  const baseRecord = isWritePlainObject(base) ? base : {};
  const targetEntries = Object.entries(target);
  if (targetEntries.length === 0 && !isWritePlainObject(base)) {
    return [{ kind: "set", path, value: {} }];
  }
  return [
    ...Object.keys(baseRecord)
      .filter((key) => !Object.hasOwn(target, key))
      .map(
        (key): ConfigMutationOperation => ({
          kind: "unset",
          path: [...path, key],
          strictIncludeOwnership: true,
        }),
      ),
    ...targetEntries.flatMap(([key, value]) =>
      createConfigMutationOperations(baseRecord[key], value, [...path, key]),
    ),
  ];
}

/** Converts runtime-derived changes to source intent, rejecting lossy container replacement. */
export function createRuntimeConfigMutationOperations(params: {
  source: unknown;
  runtime: unknown;
  candidate: unknown;
}): ConfigMutationOperation[] {
  const assertArraysSafe = (
    source: unknown,
    runtime: unknown,
    candidate: unknown,
    path: ConfigPath = [],
  ): void => {
    if (Array.isArray(runtime) && Array.isArray(candidate)) {
      if (
        !isDeepStrictEqual(runtime, candidate) &&
        (!Array.isArray(source) ||
          source.length !== runtime.length ||
          runtime.length !== candidate.length) &&
        !isDeepStrictEqual(source, runtime)
      ) {
        throw new Error(
          `Config mutation cannot safely replace runtime-derived container at ${path.join(".") || "<root>"}; mutate the authored source instead.`,
        );
      }
      if (runtime.length === candidate.length) {
        const sourceArray = Array.isArray(source) ? source : [];
        for (let index = 0; index < candidate.length; index += 1) {
          assertArraysSafe(sourceArray[index], runtime[index], candidate[index], [
            ...path,
            String(index),
          ]);
        }
      }
      return;
    }
    if (!isWritePlainObject(runtime) || !isWritePlainObject(candidate)) {
      return;
    }
    const sourceRecord = isWritePlainObject(source) ? source : {};
    for (const key of new Set([...Object.keys(runtime), ...Object.keys(candidate)])) {
      assertArraysSafe(sourceRecord[key], runtime[key], candidate[key], [...path, key]);
    }
  };
  assertArraysSafe(params.source, params.runtime, params.candidate);
  const resolvedPaths: ConfigPath[] = [];
  const sensitiveResolvedValues: unknown[] = [];
  const recordResolvedLeaf = (value: unknown, path: ConfigPath, forceSensitive = false): void => {
    resolvedPaths.push(path);
    if (forceSensitive || isSensitiveConfigPath(path.join("."))) {
      sensitiveResolvedValues.push(value);
    }
  };
  const collectRuntimeLeafPaths = (value: unknown, path: ConfigPath): void => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => collectRuntimeLeafPaths(child, [...path, String(index)]));
    } else if (isWritePlainObject(value)) {
      Object.entries(value).forEach(([key, child]) =>
        collectRuntimeLeafPaths(child, [...path, key]),
      );
    } else if (value !== undefined) {
      recordResolvedLeaf(value, path);
    }
  };
  const collectResolvedPaths = (source: unknown, runtime: unknown, path: ConfigPath = []): void => {
    if (isDeepStrictEqual(source, runtime)) {
      return;
    }
    if ((typeof source === "string" && containsEnvVarReference(source)) || isSecretRef(source)) {
      if (runtime !== undefined) {
        recordResolvedLeaf(runtime, path, true);
      }
      return;
    }
    if (isWritePlainObject(source) && Object.hasOwn(source, "$include")) {
      collectRuntimeLeafPaths(runtime, path);
      return;
    }
    if (Array.isArray(source) && Array.isArray(runtime)) {
      const length = Math.max(source.length, runtime.length);
      for (let index = 0; index < length; index += 1) {
        collectResolvedPaths(source[index], runtime[index], [...path, String(index)]);
      }
      return;
    }
    if (isWritePlainObject(source) && isWritePlainObject(runtime)) {
      for (const key of new Set([...Object.keys(source), ...Object.keys(runtime)])) {
        collectResolvedPaths(source[key], runtime[key], [...path, key]);
      }
    }
  };
  const pathStartsWith = (path: ConfigPath, prefix: ConfigPath): boolean => {
    return prefix.every((segment, index) => path[index] === segment);
  };
  const setPersistsResolvedPath = (
    operation: Extract<ConfigMutationOperation, { kind: "set" }>,
    resolvedPath: ConfigPath,
  ): boolean => {
    if (pathStartsWith(resolvedPath, operation.path)) {
      const relativePath = resolvedPath.slice(operation.path.length);
      const candidateValue =
        relativePath.length === 0 ? operation.value : readConfigPath(operation.value, relativePath);
      return isDeepStrictEqual(candidateValue, readConfigPath(params.runtime, resolvedPath));
    }
    return pathStartsWith(operation.path, resolvedPath);
  };
  const containsSensitiveResolvedValue = (value: unknown): boolean => {
    if (sensitiveResolvedValues.some((resolved) => isDeepStrictEqual(value, resolved))) {
      return true;
    }
    if (Array.isArray(value)) {
      return value.some(containsSensitiveResolvedValue);
    }
    return isWritePlainObject(value) && Object.values(value).some(containsSensitiveResolvedValue);
  };
  collectResolvedPaths(params.source, params.runtime);
  const operations = createConfigMutationOperations(params.runtime, params.candidate);
  for (const operation of operations) {
    if (
      operation.kind === "unset" &&
      !configPathExists(params.source, operation.path) &&
      !configPathHasIncludeOwner(params.source, operation.path) &&
      !isFirstAuthoredRosterImplicitMainUnset({ ...params, path: operation.path })
    ) {
      throw new Error(
        `Config mutation cannot safely remove runtime-derived value at ${operation.path.join(".") || "<root>"}; mutate the authored source instead.`,
      );
    }
    if (operation.kind === "set" && containsSensitiveResolvedValue(operation.value)) {
      throw new Error(
        `Config mutation cannot safely persist a runtime-derived value at ${operation.path.join(".") || "<root>"}; mutate the authored source instead.`,
      );
    }
    if (
      operation.kind === "set" &&
      resolvedPaths.some((resolvedPath) => setPersistsResolvedPath(operation, resolvedPath))
    ) {
      throw new Error(
        `Config mutation cannot safely persist a runtime-derived value at ${operation.path.join(".") || "<root>"}; mutate the authored source instead.`,
      );
    }
    if (
      operation.kind === "set" &&
      operation.value !== null &&
      typeof operation.value === "object" &&
      !isDeepStrictEqual(
        readConfigPath(params.source, operation.path),
        readConfigPath(params.runtime, operation.path),
      )
    ) {
      throw new Error(
        `Config mutation cannot safely replace runtime-derived container at ${operation.path.join(".") || "<root>"}; mutate the authored source instead.`,
      );
    }
  }
  for (const operation of operations) {
    if (operation.kind !== "set") {
      continue;
    }
    const arrayContainerDepths = collectArrayContainerDepths(params.candidate, operation.path);
    if (arrayContainerDepths.length > 0) {
      operation.arrayContainerDepths = arrayContainerDepths;
    }
  }
  return operations;
}

const MANAGED_CONFIG_UNSET_PATHS = [["plugins", "installs"]] as const;
const WRITE_PRUNED_OBJECT = Symbol("write-pruned-object");

function isWritePlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function coerceConfig(value: unknown): OpenClawConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as OpenClawConfig;
}

function setPathValueCreatingParents(
  value: unknown,
  path: ConfigPath,
  nextValue: unknown,
  arrayContainerDepths: readonly number[] = [],
  depth = 0,
): unknown {
  if (path.length === 0) {
    return structuredClone(nextValue);
  }
  const head = expectDefined(path[0], "config path head");
  if (isBlockedObjectKey(head)) {
    return value;
  }
  const tail = path.slice(1);
  const index = parseConfigPathArrayIndex(head);
  if (Array.isArray(value) || arrayContainerDepths.includes(depth)) {
    if (index === undefined) {
      return value;
    }
    const next = Array.isArray(value) ? [...value] : [];
    next[index] = setPathValueCreatingParents(
      next[index],
      tail,
      nextValue,
      arrayContainerDepths,
      depth + 1,
    );
    return next;
  }
  const record = isWritePlainObject(value) ? value : {};
  return {
    ...record,
    [head]: setPathValueCreatingParents(
      record[head],
      tail,
      nextValue,
      arrayContainerDepths,
      depth + 1,
    ),
  };
}

export function collectArrayContainerDepths(root: unknown, path: ConfigPath): number[] {
  const depths: number[] = [];
  let current = root;
  for (let depth = 0; depth < path.length; depth += 1) {
    if (Array.isArray(current)) {
      depths.push(depth);
      const index = parseConfigPathArrayIndex(expectDefined(path[depth], "config path segment"));
      current = index === undefined ? undefined : current[index];
      continue;
    }
    if (!isWritePlainObject(current)) {
      current = undefined;
      continue;
    }
    current = current[expectDefined(path[depth], "config path segment")];
  }
  return depths;
}

function unsetPathForWriteAt(
  value: unknown,
  pathSegments: string[],
  depth: number,
): { changed: boolean; value: unknown } {
  if (depth >= pathSegments.length) {
    return { changed: false, value };
  }
  const segment = expectDefined(pathSegments[depth], "path segments entry at depth");
  const isLeaf = depth === pathSegments.length - 1;

  if (Array.isArray(value)) {
    const index = parseConfigPathArrayIndex(segment);
    if (index === undefined || index >= value.length) {
      return { changed: false, value };
    }
    if (isLeaf) {
      const next = value.slice();
      next.splice(index, 1);
      return { changed: true, value: next };
    }
    const child = unsetPathForWriteAt(value[index], pathSegments, depth + 1);
    if (!child.changed) {
      return { changed: false, value };
    }
    const next = value.slice();
    if (child.value === WRITE_PRUNED_OBJECT) {
      next.splice(index, 1);
    } else {
      next[index] = child.value;
    }
    return { changed: true, value: next };
  }

  if (isBlockedObjectKey(segment) || !isWritePlainObject(value) || !Object.hasOwn(value, segment)) {
    return { changed: false, value };
  }
  if (isLeaf) {
    const next: Record<string, unknown> = { ...value };
    delete next[segment];
    return {
      changed: true,
      value: Object.keys(next).length === 0 ? WRITE_PRUNED_OBJECT : next,
    };
  }

  const child = unsetPathForWriteAt(value[segment], pathSegments, depth + 1);
  if (!child.changed) {
    return { changed: false, value };
  }
  const next: Record<string, unknown> = { ...value };
  if (child.value === WRITE_PRUNED_OBJECT) {
    delete next[segment];
  } else {
    next[segment] = child.value;
  }
  return {
    changed: true,
    value: Object.keys(next).length === 0 ? WRITE_PRUNED_OBJECT : next,
  };
}

function unsetPathForWrite(
  root: OpenClawConfig,
  pathSegments: string[],
): { changed: boolean; next: OpenClawConfig } {
  if (pathSegments.length === 0) {
    return { changed: false, next: root };
  }
  const result = unsetPathForWriteAt(root, pathSegments, 0);
  if (!result.changed) {
    return { changed: false, next: root };
  }
  if (result.value === WRITE_PRUNED_OBJECT) {
    return { changed: true, next: {} };
  }
  if (isWritePlainObject(result.value)) {
    return { changed: true, next: coerceConfig(result.value) };
  }
  return { changed: false, next: root };
}

export function applyUnsetPathsForWrite(
  root: OpenClawConfig,
  unsetPaths: readonly string[][] | undefined,
): OpenClawConfig {
  let next = root;
  for (const unsetPath of unsetPaths ?? []) {
    if (!Array.isArray(unsetPath) || unsetPath.length === 0) {
      continue;
    }
    const unsetResult = unsetPathForWrite(next, unsetPath);
    if (unsetResult.changed) {
      next = unsetResult.next;
    }
  }
  return next;
}

export function applyConfigOperations(
  root: unknown,
  operations: readonly ConfigMutationOperation[],
): OpenClawConfig {
  let next: unknown = structuredClone(root);
  for (const operation of operations) {
    if (operation.kind === "merge") {
      next = applyMergePatch(next, operation.patch);
      continue;
    }
    if (operation.kind === "set") {
      next = setPathValueCreatingParents(
        next,
        operation.path,
        operation.value,
        operation.arrayContainerDepths,
      );
      continue;
    }
    next = unsetPathForWrite(coerceConfig(next), [...operation.path]).next;
  }
  return coerceConfig(next);
}

export function resolveManagedUnsetPathsForWrite(
  unsetPaths: readonly string[][] | undefined,
): string[][] {
  const next: string[][] = [];
  for (const managedPath of MANAGED_CONFIG_UNSET_PATHS) {
    next.push(Array.from(managedPath));
  }
  for (const unsetPath of unsetPaths ?? []) {
    if (!Array.isArray(unsetPath) || unsetPath.length === 0) {
      continue;
    }
    if (next.some((existing) => isDeepStrictEqual(existing, unsetPath))) {
      continue;
    }
    next.push([...unsetPath]);
  }
  return next;
}
