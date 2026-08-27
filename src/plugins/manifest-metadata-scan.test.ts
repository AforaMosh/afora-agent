// Verifies plugin manifest metadata scanning stays runtime-lazy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import { listAforaPluginManifestMetadata } from "./manifest-metadata-scan.js";
import { loadPluginManifest } from "./manifest.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "afora-manifest-metadata-"));
  tempRoots.push(root);
  return root;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

describe("listAforaPluginManifestMetadata", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearPluginMetadataLifecycleCaches();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps manifest metadata stable until explicit lifecycle invalidation", () => {
    const root = createTempRoot();
    const home = path.join(root, "home");
    const bundledRoot = path.join(root, "extensions");
    const pluginDir = path.join(bundledRoot, "lifecycle-catalog");
    const manifestPath = path.join(pluginDir, "afora.plugin.json");
    const env = {
      HOME: home,
      AFORA_HOME: home,
      AFORA_BUNDLED_PLUGINS_DIR: bundledRoot,
    };
    const writeManifest = (generation: string) =>
      writeJson(manifestPath, { id: "lifecycle-catalog", generation });

    writeManifest("first");
    clearPluginMetadataLifecycleCaches();
    const statSpy = vi.spyOn(fs, "statSync");
    const readdirSpy = vi.spyOn(fs, "readdirSync");

    expect(
      listAforaPluginManifestMetadata(env).find(
        (record) => record.manifest.id === "lifecycle-catalog",
      )?.manifest.generation,
    ).toBe("first");
    const firstStatCalls = statSpy.mock.calls.length;
    const firstReaddirCalls = readdirSpy.mock.calls.length;
    expect(firstReaddirCalls).toBeGreaterThan(0);

    writeManifest("second");
    expect(
      listAforaPluginManifestMetadata(env).find(
        (record) => record.manifest.id === "lifecycle-catalog",
      )?.manifest.generation,
    ).toBe("first");
    expect(statSpy).toHaveBeenCalledTimes(firstStatCalls);
    expect(readdirSpy).toHaveBeenCalledTimes(firstReaddirCalls);

    clearPluginMetadataLifecycleCaches();
    expect(
      listAforaPluginManifestMetadata(env).find(
        (record) => record.manifest.id === "lifecycle-catalog",
      )?.manifest.generation,
    ).toBe("second");
    expect(statSpy).toHaveBeenCalledTimes(firstStatCalls);
    expect(readdirSpy.mock.calls.length).toBeGreaterThan(firstReaddirCalls);
  });

  it("prefers the active bundled manifest over stale persisted bundled installs", () => {
    const root = createTempRoot();
    const home = path.join(root, "home");
    const bundledRoot = path.join(root, "extensions");
    const staleBundledRoot = path.join(root, "stale", "extensions");

    writeJson(path.join(bundledRoot, "openai", "afora.plugin.json"), {
      id: "openai",
      providerEndpoints: [{ endpointClass: "openai-public", hosts: ["api.openai.com"] }],
    });
    writeJson(path.join(staleBundledRoot, "openai", "afora.plugin.json"), {
      id: "openai",
      providers: ["openai"],
    });
    writePersistedInstalledPluginIndexSync(
      {
        version: 1,
        hostContractVersion: "test",
        compatRegistryVersion: "test",
        migrationVersion: 1,
        policyHash: "test",
        generatedAtMs: 1,
        installRecords: {},
        plugins: [
          {
            pluginId: "openai",
            manifestPath: path.join(staleBundledRoot, "openai", "afora.plugin.json"),
            manifestHash: "stale-openai",
            rootDir: path.join(staleBundledRoot, "openai"),
            origin: "bundled",
            enabled: true,
            startup: {
              sidecar: false,
              memory: false,
              agentHarnesses: [],
            },
            compat: [],
          },
        ],
        diagnostics: [],
      },
      { stateDir: path.join(home, ".afora") },
    );

    const records = listAforaPluginManifestMetadata({
      AFORA_HOME: home,
      AFORA_BUNDLED_PLUGINS_DIR: bundledRoot,
    });

    const openai = records.find((record) => record.manifest.id === "openai");
    expect(openai?.pluginDir).toBe(path.join(bundledRoot, "openai"));
    expect(openai?.manifest.providerEndpoints).toEqual([
      { endpointClass: "openai-public", hosts: ["api.openai.com"] },
    ]);
  });

  it("keeps source manifest metadata when the active bundled tree is partial", () => {
    const root = createTempRoot();
    const home = path.join(root, "home");
    const partialBundledRoot = path.join(root, "dist", "extensions");

    writeJson(path.join(partialBundledRoot, "qa-lab", "afora.plugin.json"), {
      id: "qa-lab",
      providers: ["qa-lab"],
    });

    const records = listAforaPluginManifestMetadata({
      AFORA_HOME: home,
      AFORA_BUNDLED_PLUGINS_DIR: partialBundledRoot,
    });

    const openai = records.find((record) => record.manifest.id === "openai");
    expect(openai?.origin).toBe("source");
    expect(openai?.pluginDir).toBe(path.join(process.cwd(), "extensions", "openai"));
    expect(openai?.manifest.providerEndpoints).toContainEqual({
      endpointClass: "openai-public",
      hosts: ["api.openai.com"],
      hostSuffixes: [".api.openai.com"],
    });
  });

  it("falls through a blank Afora home when scanning global manifests", () => {
    const root = createTempRoot();
    const home = path.join(root, "home");
    const pluginDir = path.join(home, ".afora", "extensions", "example");
    writeJson(path.join(pluginDir, "afora.plugin.json"), { id: "example" });

    const records = listAforaPluginManifestMetadata({
      AFORA_HOME: "   ",
      HOME: home,
      AFORA_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
    });

    expect(records).toContainEqual({
      pluginDir,
      manifest: { id: "example" },
      origin: "global",
    });
  });

  it("preserves identity, capabilities, and config schema without loading plugin runtime", () => {
    const root = createTempRoot();
    const home = path.join(root, "home");
    const pluginDir = path.join(home, ".afora", "extensions", "authoring-contract");
    const manifest = {
      id: "authoring-contract",
      name: "Authoring contract",
      channels: ["authoring-channel"],
      providers: ["authoring-provider"],
      contracts: {
        tools: ["authoring_lookup"],
      },
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          endpoint: { type: "string" },
        },
      },
    };
    writeJson(path.join(pluginDir, "afora.plugin.json"), manifest);

    const records = listAforaPluginManifestMetadata({
      AFORA_HOME: home,
      AFORA_BUNDLED_PLUGINS_DIR: path.join(root, "empty-bundled"),
    });

    expect(records).toContainEqual({
      pluginDir,
      manifest,
      origin: "global",
    });
  });

  it.each([
    {
      name: "missing identity",
      manifest: { configSchema: { type: "object" } },
      error: "plugin manifest requires id",
    },
    {
      name: "missing config schema",
      manifest: { id: "missing-schema" },
      error: "plugin manifest requires configSchema",
    },
  ])("fails fast on $name", ({ manifest, error }) => {
    const pluginDir = createTempRoot();
    writeJson(path.join(pluginDir, "afora.plugin.json"), manifest);

    const result = loadPluginManifest(pluginDir, false);

    expect(result).toMatchObject({ ok: false, error });
  });

  it("skips oversized plugin manifests to prevent OOM during metadata scan", () => {
    const root = createTempRoot();
    const home = path.join(root, "home");

    const goodPluginDir = path.join(home, ".afora", "extensions", "good-plugin");
    writeJson(path.join(goodPluginDir, "afora.plugin.json"), { id: "good-plugin" });

    const oversizedDir = path.join(home, ".afora", "extensions", "big-plugin");
    const oversizedPath = path.join(oversizedDir, "afora.plugin.json");
    fs.mkdirSync(oversizedDir, { recursive: true });
    fs.writeFileSync(
      oversizedPath,
      JSON.stringify({ id: "big-plugin", pad: "x".repeat(256 * 1024) }),
      "utf8",
    );
    expect(fs.statSync(oversizedPath).size).toBeGreaterThan(256 * 1024);

    const records = listAforaPluginManifestMetadata({
      AFORA_HOME: home,
      AFORA_BUNDLED_PLUGINS_DIR: path.join(root, "empty-bundled"),
    });

    // "good-plugin" is present; "big-plugin" is skipped due to oversized manifest.
    expect(records.find((record) => record.manifest.id === "good-plugin")).toBeTruthy();
    expect(records.find((record) => record.manifest.id === "big-plugin")).toBeUndefined();
  });

  it("accepts plugin manifests at the exact byte limit", () => {
    const root = createTempRoot();
    const home = path.join(root, "home");

    const exactDir = path.join(home, ".afora", "extensions", "exact-plugin");
    fs.mkdirSync(exactDir, { recursive: true });

    // Write a compact JSON manifest padded to exactly the byte limit.
    const exactPath = path.join(exactDir, "afora.plugin.json");
    const exactManifest = { id: "exact-plugin", pad: "" };
    const compactJson = JSON.stringify(exactManifest);
    const requiredPadding = 256 * 1024 - Buffer.byteLength(compactJson, "utf8");
    exactManifest.pad = "x".repeat(requiredPadding);
    fs.writeFileSync(exactPath, JSON.stringify(exactManifest), "utf8");
    expect(Buffer.byteLength(fs.readFileSync(exactPath), "utf8")).toBe(256 * 1024);

    const records = listAforaPluginManifestMetadata({
      AFORA_HOME: home,
      AFORA_BUNDLED_PLUGINS_DIR: path.join(root, "empty-bundled"),
    });

    expect(records.find((record) => record.manifest.id === "exact-plugin")).toBeTruthy();
  });
});
