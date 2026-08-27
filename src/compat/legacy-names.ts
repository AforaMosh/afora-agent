// Product/package naming constants that bridge current Afora manifests with
// legacy Clawdbot keys still seen in older configs and packages.
const PROJECT_NAME = "afora" as const;

const LEGACY_PROJECT_NAMES = ["clawdbot"] as const;

export const MANIFEST_KEY = PROJECT_NAME;

/** Manifest keys accepted only for legacy compatibility. */
export const LEGACY_MANIFEST_KEYS = LEGACY_PROJECT_NAMES;
