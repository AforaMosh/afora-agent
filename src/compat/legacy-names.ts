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
