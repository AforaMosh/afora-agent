// Rejects source mutations that cross authored $include ownership.
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import { isRecord } from "../utils.js";
import type { ConfigMutationOperation, ConfigPath } from "./config-path-mutation.js";
import type { ConfigFileSnapshot } from "./types.js";

export type IncludeOwnedWriteRejection = {
  code: "include-owned";
  path: ConfigPath;
  filePath: string;
};

function pathStartsWith(path: ConfigPath, prefix: ConfigPath): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

function pathsOverlap(left: ConfigPath, right: ConfigPath): boolean {
  return pathStartsWith(left, right) || pathStartsWith(right, left);
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

function collectMergePatchPaths(value: unknown, path: ConfigPath = []): ConfigPath[] {
  if (!isRecord(value)) {
    return [path];
  }
  const entries = Object.entries(value);
  return entries.length === 0
    ? [path]
    : entries.flatMap(([key, child]) => collectMergePatchPaths(child, [...path, key]));
}

function collectOperationPaths(operation: ConfigMutationOperation): ConfigPath[] {
  if (operation.kind === "merge") {
    return collectMergePatchPaths(operation.patch);
  }
  return [operation.path];
}

function readAuthoredPath(root: unknown, path: ConfigPath): unknown {
  let current = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = parseConfigPathArrayIndex(segment);
      current = index === undefined ? undefined : current[index];
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function structuralArrayPath(
  operation: ConfigMutationOperation,
  parsed: unknown,
): ConfigPath | undefined {
  if (
    operation.kind !== "unset" ||
    operation.path.length === 0 ||
    parseConfigPathArrayIndex(operation.path.at(-1)!) === undefined
  ) {
    return undefined;
  }
  const parentPath = operation.path.slice(0, -1);
  return Array.isArray(readAuthoredPath(parsed, parentPath)) ? parentPath : undefined;
}

export function checkConfigIncludeOwnership(params: {
  snapshot: Pick<ConfigFileSnapshot, "path" | "parsed" | "includeProvenance">;
  operations: readonly ConfigMutationOperation[];
}): Result<void, IncludeOwnedWriteRejection> {
  for (const operation of params.operations) {
    const arrayPath = structuralArrayPath(operation, params.snapshot.parsed);
    const coercedArrayPaths =
      operation.kind === "set"
        ? (operation.arrayContainerDepths ?? [])
            .map((depth) => operation.path.slice(0, depth))
            .filter((path) => !Array.isArray(readAuthoredPath(params.snapshot.parsed, path)))
        : [];
    for (const operationPath of [...collectOperationPaths(operation), ...coercedArrayPaths]) {
      const owner = params.snapshot.includeProvenance?.find((entry) =>
        [entry.path, ...(entry.contributedPaths ?? [])].some(
          (ownedPath) =>
            pathsOverlap(operationPath, ownedPath) ||
            (arrayPath !== undefined &&
              pathStartsWith(ownedPath, arrayPath) &&
              parseConfigPathArrayIndex(ownedPath[arrayPath.length] ?? "") !== undefined),
        ),
      );
      if (owner) {
        return err({
          code: "include-owned",
          path: [...owner.path],
          filePath: owner.targetPath ?? params.snapshot.path,
        });
      }
    }
  }
  return ok(undefined);
}
