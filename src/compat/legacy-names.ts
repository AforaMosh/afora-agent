// Product/package naming constants that bridge current Afora manifests with
// legacy keys still seen in older configs and packages.
const PROJECT_NAME = "afora" as const;

// afora-compat: preserves the `openclaw` package.json / frontmatter manifest key. Every plugin,
// skill and hook authored before the rename declares its metadata under it, and nothing outside
// this repository has been republished under `afora`, so dropping it makes those packages
// undiscoverable rather than merely misnamed (D5). Read side only: MANIFEST_KEY is still what we
// write, so a manifest this repository authors says `afora`.
const LEGACY_PROJECT_NAMES = ["openclaw", "clawdbot"] as const;

export const MANIFEST_KEY = PROJECT_NAME;

/** Manifest keys accepted only for legacy compatibility. */
export const LEGACY_MANIFEST_KEYS = LEGACY_PROJECT_NAMES;

/** Every key a package on disk may declare its metadata under, canonical first. */
export const MANIFEST_KEYS = [MANIFEST_KEY, ...LEGACY_MANIFEST_KEYS] as const;

/** The one acceptance predicate: a manifest section is a plain object, never an array or null. */
export function isManifestSection(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a package's metadata section under the canonical key or one of its legacy spellings.
 *
 * Canonical-first, so anything this repository authors stays authoritative. `carries` names the
 * field the caller actually needs, and a canonical section that does not carry it must not
 * shadow a legacy section that does: `{"afora":{"plugin":{...}},"openclaw":{"extensions":[...]}}`
 * is a shape half-migrated packages really ship, and returning on the first *defined* key turns
 * it into "missing" while both keys are sitting right there.
 *
 * Two fallbacks keep the diagnostics a caller already emits: the first section-shaped value, and
 * then the first defined value, so a malformed manifest is still reported as malformed rather
 * than as absent.
 *
 * Every reader goes through this one function on purpose. Three call sites previously used three
 * different predicates (`!== undefined`, `&& typeof === "object"`, `Array.isArray(.extensions)`),
 * which meant the plugin loader and the deep-scan scanner could select different sections of the
 * same package.json. That divergence is a security hole in the one direction where the loader is
 * broader than the scanner, and it agreed by luck rather than by construction.
 */
export function readManifestSection(
  manifest: unknown,
  carries?: (section: Record<string, unknown>) => boolean,
): unknown {
  if (!isManifestSection(manifest)) {
    return undefined;
  }
  let firstSection: Record<string, unknown> | undefined;
  let firstDefined: unknown;
  let sawDefined = false;
  for (const key of MANIFEST_KEYS) {
    const candidate = manifest[key];
    if (candidate === undefined) {
      continue;
    }
    if (!sawDefined) {
      firstDefined = candidate;
      sawDefined = true;
    }
    if (!isManifestSection(candidate)) {
      continue;
    }
    if (!carries || carries(candidate)) {
      return candidate;
    }
    firstSection ??= candidate;
  }
  return firstSection ?? firstDefined;
}

/** `carries` predicate for readers that need one named field to be present at all. */
export function manifestSectionDeclares(field: string) {
  return (section: Record<string, unknown>): boolean => section[field] !== undefined;
}
