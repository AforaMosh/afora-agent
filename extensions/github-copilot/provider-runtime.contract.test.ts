// Github Copilot tests cover provider runtime.contract plugin behavior.
import { describeGithubCopilotProviderRuntimeContract } from "afora-agent/plugin-sdk/provider-test-contracts";
import manifest from "./afora.plugin.json" with { type: "json" };

describeGithubCopilotProviderRuntimeContract(
  () => import("./index.js"),
  manifest.modelCatalog.providers["github-copilot"],
);
