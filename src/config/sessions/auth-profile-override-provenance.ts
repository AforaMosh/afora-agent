import type { SessionEntry } from "./types.js";
type AuthProfileOverrideProvenance = Pick<
  SessionEntry,
  "authProfileOverride" | "authProfileOverrideSource" | "authProfileOverrideCompactionCount"
>;

export function resolveSessionAuthProfileOverrideSource(
  entry: AuthProfileOverrideProvenance | undefined,
): "auto" | "user" | undefined {
  if (!entry?.authProfileOverride?.trim()) {
    return undefined;
  }
  if (entry.authProfileOverrideSource) {
    return entry.authProfileOverrideSource;
  }
  return typeof entry.authProfileOverrideCompactionCount === "number" ? "auto" : "user";
}
