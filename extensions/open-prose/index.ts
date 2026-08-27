// Open Prose plugin entrypoint registers its Afora integration.
import { definePluginEntry, type AforaPluginApi } from "./runtime-api.js";

export default definePluginEntry({
  id: "open-prose",
  name: "OpenProse",
  description: "Plugin-shipped prose skills bundle",
  register(_api: AforaPluginApi) {
    // OpenProse is delivered via plugin-shipped skills.
  },
});
