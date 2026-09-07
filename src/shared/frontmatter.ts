// Shared frontmatter helpers parse Markdown frontmatter blocks and body text.
import {
  normalizeOptionalLowercaseString,
  readStringValue,
} from "@afora/normalization-core/string-coerce";
import { normalizeCsvOrLooseStringList } from "@afora/normalization-core/string-normalization";
import JSON5 from "json5";
import { isManifestSection, readManifestSection } from "../compat/legacy-names.js";
import { parseBooleanValue } from "../utils/boolean.js";

/** Normalizes comma-delimited or loose array metadata fields into string lists. */
export function normalizeStringList(input: unknown): string[] {
  return normalizeCsvOrLooseStringList(input);
}

/** Reads a frontmatter field only when it is represented as a string value. */
export function getFrontmatterString(
  frontmatter: Record<string, unknown>,
  key: string,
): string | undefined {
  return readStringValue(frontmatter[key]);
}

/** Parses boolean frontmatter strings while preserving the caller's default for missing values. */
export function parseFrontmatterBool(value: string | undefined, fallback: boolean): boolean {
  const parsed = parseBooleanValue(value);
  return parsed === undefined ? fallback : parsed;
}

/** Parses the JSON5 Afora manifest block embedded inside a string frontmatter field. */
export function resolveAforaManifestBlock(params: {
  frontmatter: Record<string, unknown>;
  key?: string;
}): Record<string, unknown> | undefined {
  const raw = getFrontmatterString(params.frontmatter, params.key ?? "metadata");
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON5.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }

    // Prefer the current manifest key, but still read legacy names for existing skill/hook files.
    // Same resolver as the plugin loader and the deep scanner, so all three agree on which
    // section of a half-migrated manifest is the one that counts.
    const section = readManifestSection(parsed);
    return isManifestSection(section) ? section : undefined;
  } catch {
    return undefined;
  }
}

type AforaManifestRequires = {
  /** All binaries that must be available. */
  bins: string[];
  /** Alternative binaries where any one match is enough. */
  anyBins: string[];
  /** Environment variables required by the entry. */
  env: string[];
  /** Config paths required by the entry. */
  config: string[];
};

/** Extracts normalized runtime requirement lists from an Afora manifest block. */
export function resolveAforaManifestRequires(
  metadataObj: Record<string, unknown>,
): AforaManifestRequires | undefined {
  const requiresRaw =
    typeof metadataObj.requires === "object" && metadataObj.requires !== null
      ? (metadataObj.requires as Record<string, unknown>)
      : undefined;
  if (!requiresRaw) {
    return undefined;
  }
  return {
    bins: normalizeStringList(requiresRaw.bins),
    anyBins: normalizeStringList(requiresRaw.anyBins),
    env: normalizeStringList(requiresRaw.env),
    config: normalizeStringList(requiresRaw.config),
  };
}

/** Parses manifest install entries with a caller-owned parser and drops unsupported specs. */
export function resolveAforaManifestInstall<T>(
  metadataObj: Record<string, unknown>,
  parseInstallSpec: (input: unknown) => T | undefined,
): T[] {
  const installRaw = Array.isArray(metadataObj.install) ? (metadataObj.install as unknown[]) : [];
  return installRaw
    .map((entry) => parseInstallSpec(entry))
    .filter((entry): entry is T => Boolean(entry));
}

/** Extracts normalized OS allowlist entries from an Afora manifest block. */
export function resolveAforaManifestOs(metadataObj: Record<string, unknown>): string[] {
  return normalizeStringList(metadataObj.os);
}

type ParsedAforaManifestInstallBase = {
  /** Original install entry for caller-specific parsing. */
  raw: Record<string, unknown>;
  /** Normalized install kind accepted by the caller. */
  kind: string;
  /** Optional stable package/tool id from the manifest entry. */
  id?: string;
  /** Optional human-facing package/tool label. */
  label?: string;
  /** Optional binaries expected after installation. */
  bins?: string[];
};

/** Parses kind/type plus common install fields shared by package-manager install specs. */
export function parseAforaManifestInstallBase(
  input: unknown,
  allowedKinds: readonly string[],
): ParsedAforaManifestInstallBase | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const raw = input as Record<string, unknown>;
  const kindRaw =
    typeof raw.kind === "string" ? raw.kind : typeof raw.type === "string" ? raw.type : "";
  const kind = normalizeOptionalLowercaseString(kindRaw) ?? "";
  if (!allowedKinds.includes(kind)) {
    return undefined;
  }

  const spec: ParsedAforaManifestInstallBase = {
    raw,
    kind,
  };
  if (typeof raw.id === "string") {
    spec.id = raw.id;
  }
  if (typeof raw.label === "string") {
    spec.label = raw.label;
  }
  const bins = normalizeStringList(raw.bins);
  if (bins.length > 0) {
    spec.bins = bins;
  }
  return spec;
}

/** Copies optional common install fields onto a caller-specific install spec object. */
export function applyAforaManifestInstallCommonFields<
  T extends { id?: string; label?: string; bins?: string[] },
>(spec: T, parsed: Pick<ParsedAforaManifestInstallBase, "id" | "label" | "bins">): T {
  if (parsed.id) {
    spec.id = parsed.id;
  }
  if (parsed.label) {
    spec.label = parsed.label;
  }
  if (parsed.bins) {
    spec.bins = parsed.bins;
  }
  return spec;
}
