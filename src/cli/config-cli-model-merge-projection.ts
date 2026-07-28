import { isRecord } from "../utils.js";
import { getAtPath, type PathSegment } from "./config-cli-path.js";

function isProviderModelListPath(path: readonly PathSegment[]): boolean {
  return (
    path.length === 4 && path[0] === "models" && path[1] === "providers" && path[3] === "models"
  );
}

export function projectSubmittedProviderModelIdsToAuthored(params: {
  path: PathSegment[];
  value: unknown;
  authoredRoot: unknown;
  resolvedRoot: unknown;
}): unknown {
  if (!isProviderModelListPath(params.path)) {
    if (Array.isArray(params.value)) {
      return params.value.map((value, index) =>
        projectSubmittedProviderModelIdsToAuthored({
          ...params,
          path: [...params.path, String(index)],
          value,
        }),
      );
    }
    if (isRecord(params.value)) {
      return Object.fromEntries(
        Object.entries(params.value).map(([key, value]) => [
          key,
          projectSubmittedProviderModelIdsToAuthored({
            ...params,
            path: [...params.path, key],
            value,
          }),
        ]),
      );
    }
    return params.value;
  }
  if (!Array.isArray(params.value)) {
    return params.value;
  }
  const authored = getAtPath(params.authoredRoot, params.path);
  const resolved = getAtPath(params.resolvedRoot, params.path);
  if (
    !authored.found ||
    !resolved.found ||
    !Array.isArray(authored.value) ||
    !Array.isArray(resolved.value)
  ) {
    return params.value;
  }
  const authoredEntries = authored.value;
  const resolvedEntries = resolved.value;
  return params.value.map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") {
      return entry;
    }
    const matches = resolvedEntries.flatMap((candidate, index) =>
      isRecord(candidate) && candidate.id === entry.id ? [index] : [],
    );
    if (matches.length > 1) {
      throw new Error(`Ambiguous provider model ID ${entry.id} at ${params.path.join(".")}.`);
    }
    if (matches.length === 0) {
      return entry;
    }
    const authoredEntry = authoredEntries[matches[0]!];
    return isRecord(authoredEntry) && typeof authoredEntry.id === "string"
      ? { ...entry, id: authoredEntry.id }
      : entry;
  });
}
