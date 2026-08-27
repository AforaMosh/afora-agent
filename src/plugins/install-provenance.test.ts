import { describe, expect, it } from "vitest";
import type { BundledPluginSource } from "./bundled-sources.js";
import { isAforaTrustedPluginInstallSpec } from "./install-provenance.js";

const bundledSources = new Map<string, BundledPluginSource>([
  [
    "discord",
    {
      pluginId: "discord",
      localPath: "/opt/afora/extensions/discord",
      npmSpec: "@afora/discord",
    },
  ],
]);

describe("plugin install provenance", () => {
  it.each([
    "discord",
    "@afora/discord",
    "npm:@afora/discord",
    "/opt/afora/extensions/discord",
    "brave",
    "npm:@afora/brave-plugin",
    "clawhub:afora-demo",
  ])("trusts Afora-owned install source %s", (spec) => {
    expect(isAforaTrustedPluginInstallSpec(spec, bundledSources)).toBe(true);
  });

  it.each(["npm:discord", "npm:@example/plugin", "/tmp/example-plugin"])(
    "keeps arbitrary install source %s untrusted",
    (spec) => {
      expect(isAforaTrustedPluginInstallSpec(spec, bundledSources)).toBe(false);
    },
  );
});
