// External code plugin package.json compatibility and validation contracts.
import { isRecord } from "../../normalization-core/src/record-coerce.js";
import { normalizeOptionalString } from "../../normalization-core/src/string-coerce.js";

/** JSON object shape accepted by package contract helpers. */
export type JsonObject = Record<string, unknown>;

/** Compatibility metadata extracted from an external plugin package. */
export type ExternalPluginCompatibility = {
  pluginApiRange?: string;
  builtWithAforaVersion?: string;
  pluginSdkVersion?: string;
  minGatewayVersion?: string;
};

/** One validation issue for an external plugin package. */
export type ExternalPluginValidationIssue = {
  fieldPath: string;
  message: string;
};

/** Validation result plus any normalized compatibility metadata. */
export type ExternalCodePluginValidationResult = {
  compatibility?: ExternalPluginCompatibility;
  issues: ExternalPluginValidationIssue[];
};

/** Required package.json field paths for external code plugin packages. */
export const EXTERNAL_CODE_PLUGIN_REQUIRED_FIELD_PATHS = [
  "afora.compat.pluginApi",
  "afora.build.aforaVersion",
] as const;

/** Read Afora package.json blocks without trusting caller input shape. */
function readAforaBlock(packageJson: unknown) {
  const root = isRecord(packageJson) ? packageJson : undefined;
  const afora = isRecord(root?.afora) ? root.afora : undefined;
  const compat = isRecord(afora?.compat) ? afora.compat : undefined;
  const build = isRecord(afora?.build) ? afora.build : undefined;
  const install = isRecord(afora?.install) ? afora.install : undefined;
  return { root, afora, compat, build, install };
}

/** Normalize compatibility metadata from an external plugin package.json. */
export function normalizeExternalPluginCompatibility(
  packageJson: unknown,
): ExternalPluginCompatibility | undefined {
  const { root, compat, build, install } = readAforaBlock(packageJson);
  const version = normalizeOptionalString(root?.version);
  const minHostVersion = normalizeOptionalString(install?.minHostVersion);
  const compatibility: ExternalPluginCompatibility = {};

  const pluginApi = normalizeOptionalString(compat?.pluginApi);
  if (pluginApi) {
    compatibility.pluginApiRange = pluginApi;
  }

  const minGatewayVersion = normalizeOptionalString(compat?.minGatewayVersion) ?? minHostVersion;
  if (minGatewayVersion) {
    compatibility.minGatewayVersion = minGatewayVersion;
  }

  const builtWithAforaVersion = normalizeOptionalString(build?.aforaVersion) ?? version;
  if (builtWithAforaVersion) {
    compatibility.builtWithAforaVersion = builtWithAforaVersion;
  }

  const pluginSdkVersion = normalizeOptionalString(build?.pluginSdkVersion);
  if (pluginSdkVersion) {
    compatibility.pluginSdkVersion = pluginSdkVersion;
  }

  return Object.keys(compatibility).length > 0 ? compatibility : undefined;
}

/** List missing required field paths for an external code plugin package.json. */
export function listMissingExternalCodePluginFieldPaths(packageJson: unknown): string[] {
  const { compat, build } = readAforaBlock(packageJson);
  const missing: string[] = [];
  if (!normalizeOptionalString(compat?.pluginApi)) {
    missing.push("afora.compat.pluginApi");
  }
  if (!normalizeOptionalString(build?.aforaVersion)) {
    missing.push("afora.build.aforaVersion");
  }
  return missing;
}

/** Validate an external code plugin package.json against required compatibility fields. */
export function validateExternalCodePluginPackageJson(
  packageJson: unknown,
): ExternalCodePluginValidationResult {
  const issues = listMissingExternalCodePluginFieldPaths(packageJson).map((fieldPath) => ({
    fieldPath,
    message: `${fieldPath} is required for external code plugin packages.`,
  }));
  return {
    compatibility: normalizeExternalPluginCompatibility(packageJson),
    issues,
  };
}
