import "./auth-plan.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import type { RunEmbeddedAgentParams } from "./params.js";

type EmbeddedRunAuthPlanTestApi = {
  loadEmbeddedRunAuthProfileStore(params: {
    agentDir: string;
    config: RunEmbeddedAgentParams["config"];
    externalCliProviderIds: Iterable<string>;
  }): AuthProfileStore;
  resolveEmbeddedRunPreferredProfileId(params: {
    provider: string;
    modelId: string;
    preparedModelRuntime?: PreparedModelRuntimeSnapshot;
    requestedProfileId?: string;
    lockedProfileId?: string;
    ignoreAutoPreferredProfile: boolean;
  }): string | undefined;
};

function getTestApi(): EmbeddedRunAuthPlanTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.embeddedRunAuthPlanTestApi")
  ] as EmbeddedRunAuthPlanTestApi;
}

export const testing: EmbeddedRunAuthPlanTestApi = {
  loadEmbeddedRunAuthProfileStore: (params) => getTestApi().loadEmbeddedRunAuthProfileStore(params),
  resolveEmbeddedRunPreferredProfileId: (params) =>
    getTestApi().resolveEmbeddedRunPreferredProfileId(params),
};
