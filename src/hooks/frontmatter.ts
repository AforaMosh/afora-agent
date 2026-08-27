// Hook frontmatter helpers parse metadata blocks from hook files.
import { readStringValue } from "@afora/normalization-core/string-coerce";
import { parseFrontmatterBlock } from "../../packages/markdown-core/src/frontmatter.js";
import {
  applyAforaManifestInstallCommonFields,
  getFrontmatterString,
  normalizeStringList,
  parseAforaManifestInstallBase,
  parseFrontmatterBool,
  resolveAforaManifestBlock,
  resolveAforaManifestInstall,
  resolveAforaManifestOs,
  resolveAforaManifestRequires,
} from "../shared/frontmatter.js";
import type {
  AforaHookMetadata,
  HookEntry,
  HookInstallSpec,
  HookInvocationPolicy,
  ParsedHookFrontmatter,
} from "./types.js";

/** Parse HOOK.md frontmatter into the generic hook frontmatter record. */
export function parseHookFrontmatter(content: string): ParsedHookFrontmatter {
  return parseFrontmatterBlock(content);
}

function parseInstallSpec(input: unknown): HookInstallSpec | undefined {
  const parsed = parseAforaManifestInstallBase(input, ["bundled", "npm", "git"]);
  if (!parsed) {
    return undefined;
  }
  const { raw } = parsed;
  const spec = applyAforaManifestInstallCommonFields<HookInstallSpec>(
    {
      kind: parsed.kind as HookInstallSpec["kind"],
    },
    parsed,
  );
  if (typeof raw.package === "string") {
    spec.package = raw.package;
  }
  if (typeof raw.repository === "string") {
    spec.repository = raw.repository;
  }

  return spec;
}

/** Resolve Afora hook metadata from the manifest block in HOOK.md frontmatter. */
export function resolveHookManifestMetadata(
  frontmatter: ParsedHookFrontmatter,
): AforaHookMetadata | undefined {
  const metadataObj = resolveAforaManifestBlock({ frontmatter });
  if (!metadataObj) {
    return undefined;
  }
  const requires = resolveAforaManifestRequires(metadataObj);
  const install = resolveAforaManifestInstall(metadataObj, parseInstallSpec);
  const osRaw = resolveAforaManifestOs(metadataObj);
  const eventsRaw = normalizeStringList(metadataObj.events);
  return {
    always: typeof metadataObj.always === "boolean" ? metadataObj.always : undefined,
    emoji: readStringValue(metadataObj.emoji),
    homepage: readStringValue(metadataObj.homepage),
    hookKey: readStringValue(metadataObj.hookKey),
    export: readStringValue(metadataObj.export),
    os: osRaw.length > 0 ? osRaw : undefined,
    events: eventsRaw.length > 0 ? eventsRaw : [],
    requires,
    install: install.length > 0 ? install : undefined,
  };
}

/** Resolve invocation policy from top-level hook frontmatter flags. */
export function resolveHookInvocationPolicy(
  frontmatter: ParsedHookFrontmatter,
): HookInvocationPolicy {
  return {
    enabled: parseFrontmatterBool(getFrontmatterString(frontmatter, "enabled"), true),
  };
}

/** Resolve the config key for a hook, honoring metadata hookKey overrides. */
export function resolveHookKey(hookName: string, entry?: HookEntry): string {
  return entry?.metadata?.hookKey ?? hookName;
}
