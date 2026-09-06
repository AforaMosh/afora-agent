import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import type { ChannelSetupMetadata } from "../channels/plugins/setup-contract.js";
import { LEGACY_MANIFEST_KEYS, MANIFEST_KEY } from "../compat/legacy-names.js";
import { isRecord } from "../utils.js";
import type { PluginManifestChannelCommandDefaults } from "./manifest-types.js";

/** package.json Afora metadata used for plugin setup and catalog discovery. */
type PluginPackageChannelApprovalFlag = "native";

export type PluginPackageChannel = {
  id?: string;
  label?: string;
  selectionLabel?: string;
  detailLabel?: string;
  docsPath?: string;
  docsLabel?: string;
  blurb?: string;
  order?: number;
  aliases?: readonly string[];
  preferOver?: readonly string[];
  systemImage?: string;
  selectionDocsPrefix?: string;
  selectionDocsOmitLabel?: boolean;
  selectionExtras?: readonly string[];
  markdownCapable?: boolean;
  /** Closed manifest flags for approval behavior available before the channel runtime loads. */
  approvalFlags?: readonly PluginPackageChannelApprovalFlag[];
  exposure?: {
    configured?: boolean;
    setup?: boolean;
    docs?: boolean;
  };
  quickstartAllowFrom?: boolean;
  forceAccountBinding?: boolean;
  preferSessionLookupForAnnounceTarget?: boolean;
  commands?: PluginManifestChannelCommandDefaults;
  configuredState?: {
    specifier?: string;
    exportName?: string;
    env?: {
      allOf?: readonly string[];
      anyOf?: readonly string[];
    };
  };
  persistedAuthState?: {
    specifier?: string;
    exportName?: string;
  };
  doctorCapabilities?: PluginPackageChannelDoctorCapabilities;
  /** Typed, serializable setup fields available before plugin runtime load. */
  setup?: ChannelSetupMetadata;
  /** @deprecated Use setup.fields. */
  cliAddOptions?: readonly PluginPackageChannelCliOption[];
};

export type PluginPackageChannelDoctorCapabilities = {
  dmAllowFromMode?: "topOnly" | "topOrNested" | "nestedOnly";
  /** Whether dmPolicy="open" requires an explicit "*" in allowFrom. Defaults to true. */
  openDmRequiresAllowFromWildcard?: boolean;
  groupModel?: "sender" | "route" | "hybrid";
  groupAllowFromFallbackToAllowFrom?: boolean;
  warnOnEmptyGroupSenderAllowlist?: boolean;
};

export type PluginPackageChannelCliOption = {
  flags: string;
  negatedFlags?: string;
  description: string;
  defaultValue?: boolean | string;
  valueType?: "int" | "list";
};

export type PluginPackageInstall = {
  clawhubSpec?: string;
  npmSpec?: string;
  localPath?: string;
  defaultChoice?: "clawhub" | "npm" | "local";
  minHostVersion?: string;
  expectedIntegrity?: string;
  allowInvalidConfigRecovery?: boolean;
  requiredPlatformPackages?: string[];
};

type AforaPackageSetupFeatures = {
  configPromotion?: boolean;
  /**
   * @deprecated Declare doctorContract.stateMigrations in afora.plugin.json instead.
   * Removal plan: remove the setup-entry adapter after the 2027.1 external-plugin migration window.
   */
  legacyStateMigrations?: boolean;
  legacySessionSurfaces?: boolean;
};

type AforaPackageCompat = {
  pluginApi?: string;
  minGatewayVersion?: string;
};

export type AforaPackageBuild = {
  bundledDist?: boolean;
  aforaVersion?: string;
  pluginSdkVersion?: string;
};

export type AforaPackageManifest = {
  extensions?: string[];
  runtimeExtensions?: string[];
  setupEntry?: string;
  runtimeSetupEntry?: string;
  setupFeatures?: AforaPackageSetupFeatures;
  plugin?: {
    id?: string;
    label?: string;
  };
  channel?: PluginPackageChannel;
  compat?: AforaPackageCompat;
  install?: PluginPackageInstall;
  build?: AforaPackageBuild;
};

export const DEFAULT_PLUGIN_ENTRY_CANDIDATES = [
  "index.ts",
  "index.js",
  "index.mjs",
  "index.cjs",
] as const;

export type PackageExtensionResolution =
  | { status: "ok"; entries: string[] }
  | { status: "missing"; entries: [] }
  | { status: "empty"; entries: [] }
  | { status: "invalid"; entries: []; error: string };

type ManifestKey = typeof MANIFEST_KEY | (typeof LEGACY_MANIFEST_KEYS)[number];

const MANIFEST_KEYS = [MANIFEST_KEY, ...LEGACY_MANIFEST_KEYS] as const;

export type PackageManifest = {
  name?: string;
  version?: string;
  description?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
} & Partial<Record<ManifestKey, AforaPackageManifest>>;

// afora-compat: read `afora` first, then the legacy `openclaw` spelling that every plugin
// package published before the rename still declares. Canonical-first keeps anything this
// repository authors authoritative; without the fallback an external plugin resolves to
// "missing" and `plugins install` rejects it as having no extensions at all.
function readPackageManifestSection(
  manifest: PackageManifest | undefined,
): AforaPackageManifest | undefined {
  for (const key of MANIFEST_KEYS) {
    const candidate = manifest?.[key];
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

export function getPackageManifestMetadata(
  manifest: PackageManifest | undefined,
): AforaPackageManifest | undefined {
  return readPackageManifestSection(manifest);
}

export function resolvePackageExtensionEntries(
  manifest: PackageManifest | undefined,
): PackageExtensionResolution {
  const rawAfora = readPackageManifestSection(manifest) as unknown;
  if (rawAfora === undefined || rawAfora === null) {
    return { status: "missing", entries: [] };
  }
  if (!isRecord(rawAfora)) {
    return {
      status: "invalid",
      entries: [],
      error: "package.json afora must be an object",
    };
  }
  const raw = rawAfora.extensions;
  if (raw === undefined || raw === null) {
    return { status: "missing", entries: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      status: "invalid",
      entries: [],
      error: "package.json afora.extensions must be an array",
    };
  }
  const entries: string[] = [];
  for (const [index, entry] of raw.entries()) {
    const normalized = normalizeOptionalString(entry);
    if (!normalized) {
      return {
        status: "invalid",
        entries: [],
        error: `package.json afora.extensions[${index}] must be a non-empty string`,
      };
    }
    entries.push(normalized);
  }
  if (entries.length === 0) {
    return { status: "empty", entries: [] };
  }
  return { status: "ok", entries };
}
