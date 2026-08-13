import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";

export type ProviderCatalogOutcome = {
  provider: string;
  /** Auth profile tested by discovery; omission means provider-wide auth. */
  profileId?: string;
  status: "ready" | "auth-rejected" | "unavailable";
  /** Models the tested profile's authoritative catalog allowed in this generation. */
  modelIds?: readonly string[];
};

/** Profiles whose authoritative live catalog included this exact model. */
export function listProviderModelAuthorizingProfileIds(params: {
  outcomes: readonly ProviderCatalogOutcome[] | undefined;
  provider: string;
  modelId: string;
}): string[] {
  const provider = normalizeProviderId(params.provider);
  const modelId = params.modelId.trim().toLowerCase();
  return (params.outcomes ?? []).flatMap((outcome) =>
    normalizeProviderId(outcome.provider) === provider &&
    outcome.status === "ready" &&
    outcome.profileId &&
    outcome.modelIds?.some((candidate) => candidate.trim().toLowerCase() === modelId)
      ? [outcome.profileId]
      : [],
  );
}
