// OC Path module implements cli metadata behavior.
import { definePluginEntry } from "afora-agent/plugin-sdk/plugin-entry";
import { registerOcPathCli } from "./cli-registration.js";

export default definePluginEntry({
  id: "oc-path",
  name: "OC Path",
  description: "Adds the afora path CLI for oc:// workspace file addressing.",
  register(api) {
    registerOcPathCli(api);
  },
});
