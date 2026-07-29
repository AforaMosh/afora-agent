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
  filePaths?: readonly string[];
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
    ? path.length === 0
      ? []
      : [path]
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

type IncludeOwnerNode =
  | { kind: "value"; owner: IncludeOwner }
  | { kind: "array"; owners: IncludeOwner[] }
  | { kind: "object"; owner?: IncludeOwner; children: Map<string, IncludeOwnerNode> };

type IncludeOwner = { targetPath: string; sequence: number };

function mergeIncludeOwnerNode(
  current: IncludeOwnerNode | undefined,
  value: unknown,
  owner: IncludeOwner,
): IncludeOwnerNode {
  if (Array.isArray(value)) {
    if (current?.kind === "array") {
      return {
        kind: "array",
        owners: value.length > 0 ? [...current.owners, owner] : [...current.owners],
      };
    }
    return { kind: "array", owners: [owner] };
  }
  if (!isRecord(value)) {
    return { kind: "value", owner };
  }
  const entries = Object.entries(value);
  if (entries.length === 0 && current?.kind === "object") {
    return current;
  }
  const result: Extract<IncludeOwnerNode, { kind: "object" }> = {
    kind: "object",
    ...(entries.length === 0 ? { owner } : {}),
    children: current?.kind === "object" ? new Map(current.children) : new Map(),
  };
  for (const [key, child] of entries) {
    result.children.set(key, mergeIncludeOwnerNode(result.children.get(key), child, owner));
  }
  return result;
}

function mergeIncludeOwnerAtPath(
  current: IncludeOwnerNode | undefined,
  path: ConfigPath,
  value: unknown,
  owner: IncludeOwner,
): IncludeOwnerNode {
  if (path.length === 0) {
    return mergeIncludeOwnerNode(current, value, owner);
  }
  const [head, ...tail] = path;
  const result: Extract<IncludeOwnerNode, { kind: "object" }> = {
    kind: "object",
    children: current?.kind === "object" ? new Map(current.children) : new Map(),
  };
  result.children.set(
    head!,
    mergeIncludeOwnerAtPath(result.children.get(head!), tail, value, owner),
  );
  return result;
}

function collectIncludeOwnerTargets(
  node: IncludeOwnerNode,
  operationPath: ConfigPath,
  nodePath: ConfigPath = [],
  targets = new Map<string, number>(),
): Map<string, number> {
  if (!pathsOverlap(operationPath, nodePath)) {
    return targets;
  }
  if (node.kind === "value") {
    targets.set(
      node.owner.targetPath,
      Math.max(targets.get(node.owner.targetPath) ?? -1, node.owner.sequence),
    );
    return targets;
  }
  if (node.kind === "array") {
    node.owners.forEach((owner) =>
      targets.set(owner.targetPath, Math.max(targets.get(owner.targetPath) ?? -1, owner.sequence)),
    );
    return targets;
  }
  if (node.owner) {
    targets.set(
      node.owner.targetPath,
      Math.max(targets.get(node.owner.targetPath) ?? -1, node.owner.sequence),
    );
  }
  for (const [key, child] of node.children) {
    collectIncludeOwnerTargets(child, operationPath, [...nodePath, key], targets);
  }
  return targets;
}

function resolveIncludeOwnerTargetPaths(
  owner: NonNullable<ConfigFileSnapshot["includeProvenance"]>[number],
  operationPath: ConfigPath,
): string[] {
  if (!owner.sourceContributions?.length) {
    return [...(owner.targetPaths ?? (owner.targetPath ? [owner.targetPath] : []))];
  }
  // Sibling overrides remain read-only by contract, so they do not subtract
  // include ownership even when they currently shadow a contributed value.
  let ownership: IncludeOwnerNode | undefined;
  for (const [sequence, source] of owner.sourceContributions.entries()) {
    ownership = mergeIncludeOwnerAtPath(ownership, owner.path, source.value, {
      targetPath: source.targetPath,
      sequence,
    });
  }
  if (!ownership) {
    return [...(owner.targetPaths ?? owner.sourceContributions.map((source) => source.targetPath))];
  }
  const survivingTargets = collectIncludeOwnerTargets(ownership, operationPath);
  if (survivingTargets.size === 0) {
    return [...(owner.targetPaths ?? owner.sourceContributions.map((source) => source.targetPath))];
  }
  return [...survivingTargets.entries()]
    .toSorted((left, right) => left[1] - right[1])
    .map(([targetPath]) => targetPath);
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
      const owners = params.snapshot.includeProvenance?.filter((entry) =>
        [entry.path, ...(entry.contributedPaths ?? [])].some(
          (ownedPath) =>
            pathsOverlap(operationPath, ownedPath) ||
            (arrayPath !== undefined &&
              pathStartsWith(ownedPath, arrayPath) &&
              parseConfigPathArrayIndex(ownedPath[arrayPath.length] ?? "") !== undefined),
        ),
      );
      if (owners?.length) {
        const ownerTargetPaths = [
          ...new Set(
            owners.flatMap((owner) => resolveIncludeOwnerTargetPaths(owner, operationPath)),
          ),
        ];
        return err({
          code: "include-owned",
          path: [...owners[0]!.path],
          filePath: ownerTargetPaths.at(-1) ?? params.snapshot.path,
          ...(ownerTargetPaths.length > 1 ? { filePaths: ownerTargetPaths } : {}),
        });
      }
    }
  }
  return ok(undefined);
}
