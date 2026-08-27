import type { AforaConfig } from "../../config/types.afora.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import "./model-config.helpers.js";

type ModelConfigHelpersTestApi = {
  hasDirectProviderApiKeyAuthForTool(params: {
    provider: string;
    cfg?: AforaConfig;
    workspaceDir?: string;
    agentDir?: string;
    authStore?: AuthProfileStore;
    modelApi?: string;
  }): boolean;
};

function getTestApi(): ModelConfigHelpersTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("afora.modelConfigHelpersTestApi")
  ] as ModelConfigHelpersTestApi;
}

export const hasDirectProviderApiKeyAuthForTool: ModelConfigHelpersTestApi["hasDirectProviderApiKeyAuthForTool"] =
  (params) => getTestApi().hasDirectProviderApiKeyAuthForTool(params);
