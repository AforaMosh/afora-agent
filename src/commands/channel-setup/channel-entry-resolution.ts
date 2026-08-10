// Canonical channel setup target resolution shared by CLI and interactive setup flows.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

type ChannelEntry = {
  id: string;
  meta: { aliases?: readonly string[] };
};

function findExactChannelEntry<T extends ChannelEntry>(
  raw: string,
  entries: readonly T[],
): T | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  return normalized
    ? entries.find((entry) => normalizeOptionalLowercaseString(entry.id) === normalized)
    : undefined;
}

function findAliasChannelEntry<T extends ChannelEntry>(
  raw: string,
  entries: readonly T[],
): T | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  return normalized
    ? entries.find((entry) =>
        (entry.meta.aliases ?? []).some(
          (candidate) => normalizeOptionalLowercaseString(candidate) === normalized,
        ),
      )
    : undefined;
}

/** Resolve one coherent channel id/catalog fact from user input and the active registry. */
export function resolveChannelTarget<T extends ChannelEntry>(params: {
  raw: string;
  entries: readonly T[];
  registeredId?: string | null;
}): { id: string; entry?: T } | undefined {
  const exact = findExactChannelEntry(params.raw, params.entries);
  if (exact) {
    return { id: exact.id, entry: exact };
  }
  if (params.registeredId) {
    const entry = findExactChannelEntry(params.registeredId, params.entries);
    return {
      id: params.registeredId,
      ...(entry ? { entry } : {}),
    };
  }
  const alias = findAliasChannelEntry(params.raw, params.entries);
  return alias ? { id: alias.id, entry: alias } : undefined;
}
