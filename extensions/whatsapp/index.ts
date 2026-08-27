// Whatsapp plugin entrypoint registers its Afora integration.
import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "afora-agent/plugin-sdk/channel-entry-contract";
import type { AforaPluginApi } from "afora-agent/plugin-sdk/channel-entry-contract";

function registerWhatsAppCallTool(api: AforaPluginApi): void {
  const registerTool = loadBundledEntryExportSync<(api: AforaPluginApi) => void>(
    import.meta.url,
    {
      specifier: "./call-tool-api.js",
      exportName: "registerWhatsAppCallTool",
    },
  );
  registerTool(api);
}

export default defineBundledChannelEntry({
  id: "whatsapp",
  name: "WhatsApp",
  description: "WhatsApp channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "whatsappPlugin",
  },
  runtime: {
    specifier: "./runtime-setter-api.js",
    exportName: "setWhatsAppRuntime",
  },
  registerFull: registerWhatsAppCallTool,
});
