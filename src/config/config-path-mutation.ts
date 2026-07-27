// Applies immutable path removals to config-like objects.
import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import { applyMergePatch, createMergePatch } from "./merge-patch.js";
import type { OpenClawConfig } from "./types.js";

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

function collectExplicitNullSets(
  base: unknown,
  target: unknown,
  path: ConfigPath = [],
): ConfigMutationOperation[] {
  if (!isWritePlainObject(target)) {
    return [];
  }
  const baseRecord = isWritePlainObject(base) ? base : {};
  return Object.entries(target).flatMap(([key, value]) => {
    const childPath = [...path, key];
    if (value === null) {
      return baseRecord[key] === null ? [] : [{ kind: "set", path: childPath, value: null }];
    }
    return collectExplicitNullSets(baseRecord[key], value, childPath);
  });
}

export function collectConfigDeletionPaths(
  base: unknown,
  target: unknown,
  path: ConfigPath = [],
): ConfigPath[] {
  if (Array.isArray(base) && Array.isArray(target)) {
    if (base.length !== target.length) {
      return [];
    }
    return base.flatMap((value, index) =>
      collectConfigDeletionPaths(value, target[index], [...path, String(index)]),
    );
  }
  if (!isWritePlainObject(base) || !isWritePlainObject(target)) {
    return [];
  }
  return Object.entries(base).flatMap(([key, value]) => {
    const childPath = [...path, key];
    if (!Object.hasOwn(target, key)) {
      return [childPath];
    }
    return collectConfigDeletionPaths(value, target[key], childPath);
  });
}

function stripExplicitNullsFromMergePatch(
  patch: unknown,
  target: unknown,
): { patch: unknown; stripped: boolean } {
  if (!isWritePlainObject(patch) || !isWritePlainObject(target)) {
    return { patch, stripped: false };
  }
  const next = { ...patch };
  let stripped = false;
  for (const [key, targetValue] of Object.entries(target)) {
    if (targetValue === null) {
      delete next[key];
      stripped = true;
      continue;
    }
    if (Object.hasOwn(next, key)) {
      const child = stripExplicitNullsFromMergePatch(next[key], targetValue);
      if (
        child.stripped &&
        isWritePlainObject(child.patch) &&
        Object.keys(child.patch).length === 0
      ) {
        delete next[key];
      } else {
        next[key] = child.patch;
      }
      stripped = stripped || child.stripped;
    }
  }
  return { patch: next, stripped };
}

/** Converts a complete candidate diff into intent without losing explicit null values. */
export function createConfigMutationOperations(
  base: unknown,
  target: unknown,
  options: { strictDeletions?: boolean } = {},
): ConfigMutationOperation[] {
  const { patch } = stripExplicitNullsFromMergePatch(createMergePatch(base, target), target);
  const mergeOperations =
    isWritePlainObject(patch) && Object.keys(patch).length === 0
      ? []
      : [{ kind: "merge", patch } satisfies ConfigMutationOperation];
  return [
    ...mergeOperations,
    ...collectExplicitNullSets(base, target),
    ...(options.strictDeletions === false
      ? []
      : collectConfigDeletionPaths(base, target).map(
          (path): ConfigMutationOperation => ({
            kind: "unset",
            path,
            strictIncludeOwnership: true,
          }),
        )),
  ];
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
