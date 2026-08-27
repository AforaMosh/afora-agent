// Venice tests cover provider runtime.contract plugin behavior.
import { describeVeniceProviderRuntimeContract } from "afora-agent/plugin-sdk/provider-test-contracts";
import manifest from "./afora.plugin.json" with { type: "json" };

describeVeniceProviderRuntimeContract(
  () => import("./index.js"),
  manifest.modelCatalog.providers.venice,
);
