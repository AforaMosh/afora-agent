/**
 * The package.json `name` values that identify an Afora core package root on disk.
 *
 * Two live names, not a rename in progress: "afora-agent" is this repository's manifest name,
 * "afora" is the published/installed package and the bin entry. A core root can legitimately
 * present either, and a service installed before the rename still presents the legacy one.
 *
 * This lives in its own leaf module because every walker that answers "is this directory my own
 * package root?" must agree by construction. A second copy of the set drifts silently: the wrong
 * answer is an unresolved root rather than an error, so nothing fails loudly when it rots.
 */
const CORE_PACKAGE_NAMES = new Set(["afora-agent", "afora", "openclaw"]); // afora-compat: legacy npm package name still resolves as the core root

/**
 * True when a package.json `name` identifies an Afora core package root.
 *
 * The parameter is `unknown` because every caller feeds it a field parsed straight out of a
 * package.json on disk, where the type is a claim rather than a guarantee. Narrowing here means
 * a caller never has to write its own `typeof` check, which is the seam a private copy grows in.
 */
export function isCorePackageName(name: unknown): boolean {
  return typeof name === "string" && CORE_PACKAGE_NAMES.has(name);
}
