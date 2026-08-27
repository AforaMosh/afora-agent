// Covers managed plugin install path generation.
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveDefaultPluginExtensionsDir,
  resolveDefaultPluginGitDir,
  resolveDefaultPluginNpmDir,
  resolvePluginNpmGenerationProjectDir,
  resolvePluginNpmGenerationProjectDirPrefix,
} from "./install-paths.js";
import { resolvePluginInstallRoots, withPluginInstallRoots } from "./install-root-context.js";
import {
  resolveInstalledPluginIndexStateDatabaseOptions,
  resolveInstalledPluginIndexStorePath,
} from "./installed-plugin-index-store-path.js";

describe("plugin install root context", () => {
  it("keeps discovery roots on the operator install while runtime state is redirected", async () => {
    const operatorRoots = resolvePluginInstallRoots(
      { AFORA_STATE_DIR: "/operator/afora" },
      () => "/unused-home",
    );
    const redirectedEnv = { AFORA_STATE_DIR: "/tmp/ephemeral-run" };

    await withPluginInstallRoots(operatorRoots, async () => {
      await Promise.resolve();
      expect(resolveDefaultPluginExtensionsDir(redirectedEnv)).toBe(
        "/operator/afora/extensions",
      );
      expect(resolveDefaultPluginNpmDir(redirectedEnv)).toBe("/operator/afora/npm");
      expect(resolveDefaultPluginGitDir(redirectedEnv)).toBe("/operator/afora/git");
      expect(resolveInstalledPluginIndexStorePath({ env: redirectedEnv })).toBe(
        "/operator/afora/state/afora.sqlite",
      );
      expect(
        resolveInstalledPluginIndexStateDatabaseOptions({ env: redirectedEnv }).env
          ?.AFORA_STATE_DIR,
      ).toBe("/operator/afora");
    });

    expect(resolveDefaultPluginExtensionsDir(redirectedEnv)).toBe("/tmp/ephemeral-run/extensions");
    expect(resolveInstalledPluginIndexStorePath({ env: redirectedEnv })).toBe(
      "/tmp/ephemeral-run/state/afora.sqlite",
    );
    expect(
      resolveInstalledPluginIndexStateDatabaseOptions({ env: redirectedEnv }).env
        ?.AFORA_STATE_DIR,
    ).toBe("/tmp/ephemeral-run");
  });

  it("isolates concurrent install-root scopes", async () => {
    const resolveScopedRoot = async (stateDir: string) => {
      const roots = resolvePluginInstallRoots({ AFORA_STATE_DIR: stateDir });
      return await withPluginInstallRoots(roots, async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        return resolveDefaultPluginExtensionsDir({ AFORA_STATE_DIR: "/redirected" });
      });
    };

    await expect(
      Promise.all([resolveScopedRoot("/operator/one"), resolveScopedRoot("/operator/two")]),
    ).resolves.toEqual(["/operator/one/extensions", "/operator/two/extensions"]);
  });
});

describe("managed npm plugin install paths", () => {
  it("keeps generation project names compact for nested Windows runtime binaries", () => {
    const packageName = "@afora/codex";
    const generationKey = [
      packageName,
      "2026.6.10",
      `${packageName}@2026.6.10`,
      "sha512-test-integrity",
      "codexshasum",
    ].join("\n");
    const projectDir = resolvePluginNpmGenerationProjectDir({
      npmDir: String.raw`C:\Users\Administrator\.afora\npm`,
      packageName,
      generationKey,
    });
    const projectName = path.basename(projectDir);

    expect(projectName).toMatch(
      /^afora-codex-[a-f0-9]{10}__afora-generation__g-[a-f0-9]{16}$/u,
    );
    expect(projectName.length).toBeLessThanOrEqual(66);

    const nestedCodexBinaryPath = path.win32.join(
      String.raw`C:\Users\Administrator\.afora\npm\projects`,
      projectName,
      "node_modules",
      "@afora",
      "codex",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
      "codex.exe",
    );
    expect(nestedCodexBinaryPath.length).toBeLessThan(260);
  });

  it("keeps generation project names under the recoverable package prefix", () => {
    const packageName = "@afora/codex";
    const projectDir = resolvePluginNpmGenerationProjectDir({
      npmDir: "/tmp/afora/npm",
      packageName,
      generationKey: "codex-v2",
    });

    expect(path.basename(projectDir)).toMatch(
      new RegExp(`^${resolvePluginNpmGenerationProjectDirPrefix(packageName)}`, "u"),
    );
  });
});
