// Normalizes config version metadata and compatibility comparisons.
import { parse as parseSemver, type SemVer } from "semver";
import {
  compareAforaSemver,
  isAforaCorrectionSemver,
  normalizeLegacyDotBetaVersion,
} from "../infra/semver.js";

/** Parses stable, prerelease, and legacy dot-beta Afora versions. */
function parseAforaVersion(raw: string | null | undefined): SemVer | null {
  if (!raw) {
    return null;
  }
  const normalized = normalizeLegacyDotBetaVersion(raw.trim());
  return parseSemver(normalized);
}

export function normalizeAforaVersionBase(raw: string | null | undefined): string | null {
  const parsed = parseAforaVersion(raw);
  if (!parsed) {
    return null;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

export function compareAforaVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): number | null {
  const parsedA = parseAforaVersion(a);
  const parsedB = parseAforaVersion(b);
  if (!parsedA || !parsedB) {
    return null;
  }
  return compareAforaSemver(parsedA, parsedB);
}

export function shouldWarnOnTouchedVersion(
  current: string | null | undefined,
  touched: string | null | undefined,
): boolean {
  const parsedCurrent = parseAforaVersion(current);
  const parsedTouched = parseAforaVersion(touched);
  if (parsedCurrent && parsedTouched && parsedCurrent.compareMain(parsedTouched) === 0) {
    if (parsedTouched.prerelease.length === 0 || isAforaCorrectionSemver(parsedTouched)) {
      return false;
    }
  }
  return parsedCurrent !== null && parsedTouched !== null
    ? compareAforaSemver(parsedCurrent, parsedTouched) < 0
    : false;
}
