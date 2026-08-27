// Guards config writes that are disallowed in Nix-managed installs.
import { resolveIsNixMode } from "./paths.js";

/** Agent-first Nix install docs shown when runtime config writes are blocked. */
const NIX_AFORA_AGENT_FIRST_URL = "https://github.com/afora/nix-afora#quick-start";
/** Public Afora Nix overview shown with immutable-config errors. */
const AFORA_NIX_OVERVIEW_URL = "https://docs.afora.ai/install/nix";

/** Error thrown when a mutating config path is attempted while Nix owns config state. */
export class NixModeConfigMutationError extends Error {
  readonly code = "AFORA_NIX_MODE_CONFIG_IMMUTABLE";

  constructor(params: { configPath?: string } = {}) {
    super(formatNixModeConfigMutationMessage(params));
    this.name = "NixModeConfigMutationError";
  }
}

/** Build the operator-facing immutable-config message for Nix-managed installs. */
function formatNixModeConfigMutationMessage(params: { configPath?: string } = {}): string {
  return [
    "Config is managed by Nix (`AFORA_NIX_MODE=1`), so Afora treats afora.json as immutable.",
    "This usually means nix-afora, the first-party Nix distribution, or another Nix-managed package set this mode.",
    ...(params.configPath ? [`Config path: ${params.configPath}`] : []),
    "Do not run setup, onboarding, afora update, plugin install/update/uninstall/enable, doctor repair/token-generation, or config set against this file.",
    "Edit the Nix source for this install instead. For nix-afora, edit `programs.afora.config` or `instances.<name>.config`, then rebuild with Home Manager or NixOS.",
    `Agent-first Nix setup: ${NIX_AFORA_AGENT_FIRST_URL}`,
    `Afora Nix overview: ${AFORA_NIX_OVERVIEW_URL}`,
  ].join("\n");
}

/** Throw when the current environment marks Afora config as Nix-managed and immutable. */
export function assertConfigWriteAllowedInCurrentMode(
  params: {
    configPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): void {
  if (!resolveIsNixMode(params.env)) {
    return;
  }
  // In Nix mode, all writes must happen in the declarative source and then rebuild.
  throw new NixModeConfigMutationError({ configPath: params.configPath });
}
