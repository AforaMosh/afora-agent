// Rejects source mutations that cross authored $include ownership.
import { isDeepStrictEqual } from "node:util";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import { isRecord } from "../utils.js";
import {
  applyConfigOperations,
  collectArrayContainerDepths,
  type ConfigMutationOperation,
  type ConfigPath,
} from "./config-path-mutation.js";
import type { ConfigFileSnapshot } from "./types.js";

export type IncludeOwnedWriteRejection = {
  code: "include-owned";
  path: ConfigPath;
  filePath: string;
};

function pathStartsWith(path: ConfigPath, prefix: ConfigPath): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

function includeContributionOwnsAgentRosterPath(path: ConfigPath): boolean {
  if (path[0] !== "agents") {
    return false;
  }
  if (path[1] === "entries") {
    return path.length <= 3 || path[3] === "default";
  }
  if (path[1] === "list") {
    return path.length <= 3 || path[3] === "id" || path[3] === "default";
  }
  return false;
}

export function configIncludeOwnsAgentRoster(
  snapshot: Pick<ConfigFileSnapshot, "includeProvenance">,
): boolean {
  return Boolean(
    snapshot.includeProvenance?.some((entry) =>
      (entry.contributedPaths ?? [entry.path]).some(includeContributionOwnsAgentRosterPath),
    ),
  );
}

type ConfigOperationTouch = {
  path: ConfigPath;
  kind: "set" | "unset";
  value?: unknown;
  arrayContainerDepths?: readonly number[];
  strictIncludeOwnership?: boolean;
};

function collectMergePatchTouches(value: unknown, path: ConfigPath = []): ConfigOperationTouch[] {
  if (!isRecord(value)) {
    return [{ path, kind: value === null ? "unset" : "set", value }];
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    // An empty object still owns this path: applying it to a scalar or absent
    // value materializes an object, so include checks must not treat it as no-op.
    return [{ path, kind: "set" }];
  }
  return entries.flatMap(([key, child]) =>
    child === null || !isRecord(child)
      ? [{ path: [...path, key], kind: child === null ? "unset" : "set", value: child } as const]
      : collectMergePatchTouches(child, [...path, key]),
  );
}

function collectSetValueTouches(value: unknown, path: ConfigPath): ConfigOperationTouch[] {
  if (!isRecord(value)) {
    return [{ path, kind: "set", value }];
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return [{ path, kind: "set", value }];
  }
  return [
    { path, kind: "set", value },
    ...entries.flatMap(([key, child]) => collectSetValueTouches(child, [...path, key])),
  ];
}

function collectConfigOperationTouches(
  operations: readonly ConfigMutationOperation[],
  runtimeConfig?: unknown,
): ConfigOperationTouch[] {
  return operations.flatMap((operation) =>
    operation.kind === "merge"
      ? collectMergePatchTouches(operation.patch)
      : operation.kind === "set"
        ? collectSetValueTouches(operation.value, operation.path).map((touch) => ({
            ...touch,
            arrayContainerDepths: [
              ...new Set([
                ...(operation.arrayContainerDepths ?? []),
                ...collectArrayContainerDepths(runtimeConfig, touch.path),
              ]),
            ],
          }))
        : [
            {
              path: operation.path,
              kind: operation.kind,
              ...(operation.kind === "unset" && operation.strictIncludeOwnership
                ? { strictIncludeOwnership: true }
                : {}),
            },
          ],
  );
}

export function collectConfigOperationPaths(
  operations: readonly ConfigMutationOperation[],
): ConfigPath[] {
  return collectConfigOperationTouches(operations).map((touch) => touch.path);
}

function readAuthoredPath(root: unknown, path: ConfigPath): { found: boolean; value?: unknown } {
  let current = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = parseConfigPathArrayIndex(segment);
      if (index === undefined || index >= current.length) {
        return { found: false };
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return { found: false };
    }
    current = current[segment];
  }
  return { found: true, value: current };
}

function hasAuthoredPath(root: unknown, path: ConfigPath): boolean {
  return readAuthoredPath(root, path).found;
}

function includeEntryContributesAtOrBelow(
  entry: NonNullable<ConfigFileSnapshot["includeProvenance"]>[number],
  targetPath: ConfigPath,
): boolean {
  return (entry.contributedPaths ?? [entry.path]).some((path) => pathStartsWith(path, targetPath));
}

function remapPathAfterArrayChanges(
  path: ConfigPath,
  before: unknown,
  after: unknown,
): ConfigPath | undefined {
  const next = [...path];
  for (let depth = 0; depth < next.length; depth += 1) {
    const parentPath = next.slice(0, depth);
    const beforeContainer = readAuthoredPath(before, parentPath);
    const afterContainer = readAuthoredPath(after, parentPath);
    if (!Array.isArray(beforeContainer.value) || !Array.isArray(afterContainer.value)) {
      continue;
    }
    const oldIndex = parseConfigPathArrayIndex(next[depth]!);
    if (oldIndex === undefined || oldIndex >= beforeContainer.value.length) {
      continue;
    }
    const oldValue = beforeContainer.value[oldIndex];
    let matches = afterContainer.value.flatMap((value, index) =>
      isDeepStrictEqual(value, oldValue) ? [index] : [],
    );
    if (matches.length !== 1) {
      const relativePath = next.slice(depth + 1);
      if (relativePath.length > 0) {
        const identity = readAuthoredPath(oldValue, relativePath);
        if (identity.found) {
          matches = afterContainer.value.flatMap((value, index) =>
            isDeepStrictEqual(readAuthoredPath(value, relativePath).value, identity.value)
              ? [index]
              : [],
          );
        }
      }
    }
    if (matches.length !== 1) {
      // A descendant edit changes the enclosing element byte-for-byte without
      // moving it. Structural ambiguity instead broadens ownership to the array.
      if (beforeContainer.value.length === afterContainer.value.length) {
        continue;
      }
      return parentPath;
    }
    next[depth] = String(matches[0]!);
  }
  return next;
}

function shiftProvenanceAfterOperation(params: {
  provenance: NonNullable<ConfigFileSnapshot["includeProvenance"]>;
  before: unknown;
  after: unknown;
}): NonNullable<ConfigFileSnapshot["includeProvenance"]> {
  return params.provenance.flatMap((entry) => {
    const shiftedPath = remapPathAfterArrayChanges(entry.path, params.before, params.after);
    if (!shiftedPath) {
      return [];
    }
    const contributedPaths = (entry.contributedPaths ?? []).flatMap((path) => {
      const shifted = remapPathAfterArrayChanges(path, params.before, params.after);
      return shifted ? [shifted] : [];
    });
    return [
      {
        ...entry,
        path: shiftedPath,
        ...(entry.contributedPaths ? { contributedPaths } : {}),
      },
    ];
  });
}

function replacementRetainsInclude(params: {
  entry: NonNullable<ConfigFileSnapshot["includeProvenance"]>[number];
  touch: ConfigOperationTouch;
  parsed: unknown;
}): boolean {
  if (
    params.touch.kind !== "set" ||
    !Array.isArray(params.touch.value) ||
    !pathStartsWith(params.entry.path, params.touch.path) ||
    params.entry.path.length <= params.touch.path.length
  ) {
    return false;
  }
  const authoredArray = readAuthoredPath(params.parsed, params.touch.path).value;
  const index = parseConfigPathArrayIndex(params.entry.path[params.touch.path.length]!);
  if (!Array.isArray(authoredArray) || index === undefined || index >= authoredArray.length) {
    return false;
  }
  const relativePath = params.entry.path.slice(params.touch.path.length + 1);
  const includeNode = readAuthoredPath(authoredArray[index], relativePath).value;
  const authoredCount = authoredArray.filter((value) =>
    isDeepStrictEqual(readAuthoredPath(value, relativePath).value, includeNode),
  ).length;
  const replacementCount = params.touch.value.filter((value) =>
    isDeepStrictEqual(readAuthoredPath(value, relativePath).value, includeNode),
  ).length;
  return authoredCount > 0 && replacementCount >= authoredCount;
}

function recordSetOmitsIncludeContribution(params: {
  entry: NonNullable<ConfigFileSnapshot["includeProvenance"]>[number];
  touch: ConfigOperationTouch;
}): boolean {
  if (params.touch.kind !== "set" || !isRecord(params.touch.value)) {
    return false;
  }
  return (params.entry.contributedPaths ?? [params.entry.path]).some((contributedPath) => {
    if (!pathStartsWith(contributedPath, params.touch.path)) {
      return false;
    }
    const relativePath = contributedPath.slice(params.touch.path.length);
    return relativePath.length === 0 || !readAuthoredPath(params.touch.value, relativePath).found;
  });
}

export function checkConfigIncludeOwnership(params: {
  snapshot: Pick<ConfigFileSnapshot, "path" | "parsed" | "runtimeConfig" | "includeProvenance">;
  operations: readonly ConfigMutationOperation[];
}): Result<void, IncludeOwnedWriteRejection> {
  const provenance = params.snapshot.includeProvenance;
  if (!provenance || provenance.length === 0) {
    return ok(undefined);
  }
  let currentParsed = params.snapshot.parsed;
  let currentRuntime = params.snapshot.runtimeConfig;
  let currentProvenance = provenance.map((entry) => ({
    ...entry,
    path: [...entry.path],
    ...(entry.contributedPaths
      ? { contributedPaths: entry.contributedPaths.map((path) => [...path]) }
      : {}),
  }));
  for (const operation of params.operations) {
    for (const touch of collectConfigOperationTouches([operation], currentRuntime)) {
      let ownership: (typeof currentProvenance)[number] | undefined;
      for (const entry of currentProvenance) {
        const matches =
          (pathStartsWith(entry.path, touch.path) &&
            !replacementRetainsInclude({ entry, touch, parsed: currentParsed })) ||
          (touch.kind === "set" &&
            pathStartsWith(touch.path, entry.path) &&
            (recordSetOmitsIncludeContribution({ entry, touch }) ||
              (Array.isArray(touch.value) &&
                includeEntryContributesAtOrBelow(entry, touch.path) &&
                !Array.isArray(readAuthoredPath(currentParsed, touch.path).value)) ||
              touch.arrayContainerDepths?.some((depth) => {
                if (depth < entry.path.length) {
                  return false;
                }
                const authoredContainer = readAuthoredPath(
                  currentParsed,
                  touch.path.slice(0, depth),
                );
                return (
                  includeEntryContributesAtOrBelow(entry, touch.path.slice(0, depth)) &&
                  (!authoredContainer.found || !Array.isArray(authoredContainer.value))
                );
              }) === true)) ||
          (touch.kind === "unset" &&
            pathStartsWith(touch.path, entry.path) &&
            includeEntryContributesAtOrBelow(entry, touch.path) &&
            (touch.strictIncludeOwnership === true || !hasAuthoredPath(currentParsed, touch.path)));
        if (matches && (!ownership || entry.path.length > ownership.path.length)) {
          ownership = entry;
        }
      }
      if (ownership) {
        return err({
          code: "include-owned",
          path: [...ownership.path],
          filePath: ownership.targetPath ?? params.snapshot.path,
        });
      }
    }
    const nextParsed = applyConfigOperations(currentParsed, [operation]);
    currentProvenance = shiftProvenanceAfterOperation({
      provenance: currentProvenance,
      before: currentParsed,
      after: nextParsed,
    });
    currentParsed = nextParsed;
    currentRuntime = applyConfigOperations(currentRuntime, [operation]);
  }
  return ok(undefined);
}
