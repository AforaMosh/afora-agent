// Openai tests cover provider runtime.contract plugin behavior.
import { describeOpenAIProviderRuntimeContract } from "afora-agent/plugin-sdk/provider-test-contracts";
import manifest from "./afora.plugin.json" with { type: "json" };

describeOpenAIProviderRuntimeContract(
  () => import("./index.js"),
  manifest.modelCatalog.providers.openai,
);
