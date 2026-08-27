// Qianfan plugin entrypoint registers its Afora integration.
import { defineSingleProviderPluginEntry } from "afora-agent/plugin-sdk/provider-entry";
import { applyQianfanConfig, QIANFAN_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./afora.plugin.json" with { type: "json" };

const PROVIDER_ID = "qianfan";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Qianfan Provider",
  description: "Bundled Qianfan provider plugin",
  manifest,
  provider: {
    label: "Qianfan",
    docsPath: "/providers/qianfan",
    manifestAuth: {
      defaultModel: QIANFAN_DEFAULT_MODEL_REF,
      applyConfig: applyQianfanConfig,
    },
    catalog: { liveModelDiscovery: true },
  },
});
