// Covers the managed-npm recovery path's manifest reads.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withAforaTestState } from "../test-utils/afora-test-state.js";
import { listRecoveredManagedNpmInstallCandidates } from "./installed-plugin-index-record-reader.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

function recoveredPluginIds(stateDir: string): string[] {
  return listRecoveredManagedNpmInstallCandidates({ stateDir }).map(
    (candidate) => candidate.pluginId,
  );
}

// afora-compat: this is how a tenant's installed-plugin index is rebuilt from the managed npm
// root when the index file is lost. Both of its manifest reads were hardcoded to the canonical
// spellings while the loader that installed the package already dual-read, so a pre-rename
// package could be installed and then never be recovered.
describe("managed npm install recovery reads legacy manifests", () => {
  it("recovers a package that declares its extensions under the legacy manifest key", async () => {
    await withAforaTestState({ label: "recovery-legacy-manifest-key" }, async (state) => {
      writeManagedNpmPlugin({
        stateDir: state.stateDir,
        packageName: "@afora/legacy-key-demo",
        pluginId: "legacy-key-demo",
        version: "1.0.0",
        manifestKey: "openclaw",
      });

      expect(recoveredPluginIds(state.stateDir)).toContain("legacy-key-demo");
    });
  });

  it("recovers a package whose plugin manifest still uses the legacy filename", async () => {
    await withAforaTestState({ label: "recovery-legacy-manifest-file" }, async (state) => {
      writeManagedNpmPlugin({
        stateDir: state.stateDir,
        packageName: "@afora/legacy-file-demo",
        pluginId: "legacy-file-demo",
        version: "1.0.0",
        pluginManifestFilename: "openclaw.plugin.json",
      });

      // Without the filename fallback the id falls back to the package name, so the plugin is
      // recovered under the wrong id rather than not at all. Assert the id that must come back.
      expect(recoveredPluginIds(state.stateDir)).toContain("legacy-file-demo");
    });
  });

  it("recovers a package that is legacy on both axes at once", async () => {
    await withAforaTestState({ label: "recovery-legacy-both" }, async (state) => {
      writeManagedNpmPlugin({
        stateDir: state.stateDir,
        packageName: "@afora/legacy-both-demo",
        pluginId: "legacy-both-demo",
        version: "1.0.0",
        manifestKey: "openclaw",
        pluginManifestFilename: "openclaw.plugin.json",
      });

      expect(recoveredPluginIds(state.stateDir)).toContain("legacy-both-demo");
    });
  });

  it("prefers the canonical plugin manifest when a package ships both filenames", async () => {
    await withAforaTestState({ label: "recovery-both-filenames" }, async (state) => {
      const packageDir = writeManagedNpmPlugin({
        stateDir: state.stateDir,
        packageName: "@afora/both-files-demo",
        pluginId: "canonical-id",
        version: "1.0.0",
      });
      fs.writeFileSync(
        path.join(packageDir, "openclaw.plugin.json"),
        JSON.stringify({ id: "legacy-id", configSchema: { type: "object" } }),
        "utf8",
      );

      const ids = recoveredPluginIds(state.stateDir);
      expect(ids).toContain("canonical-id");
      expect(ids).not.toContain("legacy-id");
    });
  });
});
