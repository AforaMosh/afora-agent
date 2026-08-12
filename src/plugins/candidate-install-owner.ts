const PLUGIN_CANDIDATE_INSTALL_OWNER = Symbol.for("openclaw.pluginCandidateInstallOwner");
const PLUGIN_INSTALL_OWNER_LOOKUP = Symbol.for("openclaw.pluginInstallOwnerLookup");

type PluginCandidateInstallOwner = { installOwner?: string; ambiguous?: true };

export function recordPluginCandidateInstallOwner<T extends object>(
  candidate: T,
  installOwner: string | undefined,
  ambiguous = false,
): T {
  if (!installOwner && !ambiguous) {
    return candidate;
  }
  Object.defineProperty(candidate, PLUGIN_CANDIDATE_INSTALL_OWNER, {
    configurable: true,
    enumerable: true,
    value: ambiguous ? { ambiguous: true } : { installOwner },
  });
  return candidate;
}

function readPluginCandidateInstallOwner<TCandidate extends object>(
  candidate: TCandidate,
): PluginCandidateInstallOwner | undefined {
  return (candidate as { [PLUGIN_CANDIDATE_INSTALL_OWNER]?: PluginCandidateInstallOwner })[
    PLUGIN_CANDIDATE_INSTALL_OWNER
  ];
}

export function resolvePluginCandidateInstallOwner<TCandidate extends object>(
  candidate: TCandidate,
): string | undefined {
  return readPluginCandidateInstallOwner(candidate)?.installOwner;
}

export function isPluginCandidateInstallOwnerAmbiguous<TCandidate extends object>(
  candidate: TCandidate,
): boolean {
  return readPluginCandidateInstallOwner(candidate)?.ambiguous === true;
}

export function recordPluginInstallOwnerLookup<T extends object>(
  params: T,
  installOwnerByPluginId: ReadonlyMap<string, string>,
): T {
  Object.defineProperty(params, PLUGIN_INSTALL_OWNER_LOOKUP, {
    configurable: false,
    enumerable: true,
    value: installOwnerByPluginId,
  });
  return params;
}

export function resolvePluginInstallOwnerLookup<TParams extends object>(
  params: TParams,
): ReadonlyMap<string, string> | undefined {
  return (params as { [PLUGIN_INSTALL_OWNER_LOOKUP]?: ReadonlyMap<string, string> })[
    PLUGIN_INSTALL_OWNER_LOOKUP
  ];
}
