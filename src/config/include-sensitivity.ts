import { isRecord } from "../utils.js";
import { containsEnvVarReference } from "./env-substitution.js";
import type { ConfigFileSnapshot } from "./types.js";
import { isSecretRef } from "./types.secrets.js";

type ConfigPath = readonly string[];
function mergeValues(current: unknown, value: unknown): unknown {
  if (Array.isArray(current) && Array.isArray(value)) {
    return [...structuredClone(current), ...structuredClone(value)];
  }
  if (isRecord(current) && isRecord(value)) {
    const result = structuredClone(current);
    for (const [key, child] of Object.entries(value)) {
      Object.defineProperty(result, key, {
        value: mergeValues(result[key], child),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
  return structuredClone(value);
}

function collectPaths(value: unknown, path: ConfigPath, output: ConfigPath[]): void {
  if (typeof value === "string") {
    if (containsEnvVarReference(value)) {
      output.push(path);
    }
    return;
  }
  if (isSecretRef(value)) {
    output.push(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectPaths(child, [...path, String(index)], output));
  } else if (isRecord(value)) {
    Object.entries(value).forEach(([key, child]) => collectPaths(child, [...path, key], output));
  }
}

/** Resolves the winning env/SecretRef-backed paths from include provenance. */
export function collectSensitiveIncludeSourcePaths(
  snapshot: Pick<ConfigFileSnapshot, "includeProvenance">,
): ConfigPath[] {
  const sensitivePaths = new Map<string, ConfigPath>();
  for (const entry of snapshot.includeProvenance ?? []) {
    if (entry.sourceContributions?.length) {
      for (const [key, sensitivePath] of sensitivePaths) {
        if (
          entry.path.length <= sensitivePath.length &&
          entry.path.every((segment, index) => sensitivePath[index] === segment)
        ) {
          sensitivePaths.delete(key);
        }
      }
      let merged: unknown = {};
      for (const source of entry.sourceContributions) {
        merged = mergeValues(merged, source.value);
      }
      const mergedPaths: ConfigPath[] = [];
      collectPaths(merged, entry.path, mergedPaths);
      mergedPaths.forEach((path) => sensitivePaths.set(JSON.stringify(path), path));
      continue;
    }
    for (const terminalPath of entry.terminalContributedPaths ??
      entry.sensitiveContributedPaths ??
      []) {
      for (const [key, sensitivePath] of sensitivePaths) {
        if (
          terminalPath.length <= sensitivePath.length &&
          terminalPath.every((segment, index) => sensitivePath[index] === segment)
        ) {
          sensitivePaths.delete(key);
        }
      }
    }
    for (const sensitivePath of entry.sensitiveContributedPaths ?? []) {
      sensitivePaths.set(JSON.stringify(sensitivePath), sensitivePath.slice());
    }
  }
  return [...sensitivePaths.values()];
}
