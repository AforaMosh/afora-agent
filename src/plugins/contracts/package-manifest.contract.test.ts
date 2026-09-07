import { describe, expect, it } from "vitest";
import { describePackageManifestContract } from "../../plugin-sdk/test-helpers/package-manifest-contract.js";
import { validatePackageExtensionEntriesForInstall } from "../package-entry-resolution.js";
import {
  getPackageManifestMetadata,
  resolvePackageExtensionEntries,
  type PackageManifest,
} from "../package-manifest.js";

// Package manifest contract tests cover plugin package manifest requirements.
type PackageManifestContractParams = Parameters<typeof describePackageManifestContract>[0];

const packageManifestContractTests: PackageManifestContractParams[] = [
  {
    pluginId: "buzz",
    pluginLocalRuntimeDeps: ["nostr-tools"],
    minHostVersionBaseline: "2026.7.2",
  },
  {
    pluginId: "discord",
    pluginLocalRuntimeDeps: ["@discordjs/voice", "discord-api-types", "libopus-wasm"],
    minHostVersionBaseline: "2026.3.22",
  },
  {
    pluginId: "feishu",
    pluginLocalRuntimeDeps: ["@larksuiteoapi/node-sdk"],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "google" },
  { pluginId: "google-meet" },
  {
    pluginId: "googlechat",
    pluginLocalRuntimeDeps: ["google-auth-library"],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "irc", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "line", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "amazon-bedrock" },
  { pluginId: "amazon-bedrock-mantle" },
  {
    pluginId: "diffs",
    pluginLocalRuntimeDeps: ["@pierre/diffs"],
  },
  { pluginId: "file-transfer" },
  {
    pluginId: "matrix",
    pluginLocalRuntimeDeps: [
      "@matrix-org/matrix-sdk-crypto-nodejs",
      "@matrix-org/matrix-sdk-crypto-wasm",
      "fake-indexeddb",
      "matrix-js-sdk",
      "music-metadata",
    ],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "mattermost", minHostVersionBaseline: "2026.3.22" },
  {
    pluginId: "memory-lancedb",
    pluginLocalRuntimeDeps: ["@lancedb/lancedb", "apache-arrow"],
    minHostVersionBaseline: "2026.3.22",
  },
  {
    pluginId: "msteams",
    pluginLocalRuntimeDeps: ["@azure/identity", "@microsoft/teams.apps"],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "nextcloud-talk", minHostVersionBaseline: "2026.3.22" },
  {
    pluginId: "nostr",
    pluginLocalRuntimeDeps: ["nostr-tools"],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "openshell" },
  { pluginId: "slack" },
  { pluginId: "synology-chat", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "telegram" },
  { pluginId: "tlon", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "tokenjuice", pluginLocalRuntimeDeps: ["tokenjuice"] },
  { pluginId: "twitch", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "voice-call", minHostVersionBaseline: "2026.3.22" },
  {
    pluginId: "whatsapp",
    pluginLocalRuntimeDeps: ["audio-decode", "baileys"],
    minHostVersionBaseline: "2026.3.22",
  },
  { pluginId: "xiaomi", minHostVersionBaseline: "2026.7.2" },
  { pluginId: "zalo", minHostVersionBaseline: "2026.3.22" },
  { pluginId: "zalouser", minHostVersionBaseline: "2026.3.22" },
];

for (const params of packageManifestContractTests) {
  describePackageManifestContract(params);
}

describe("plugin package authoring metadata", () => {
  it("exposes the declared discovery and release entrypoints", () => {
    const manifest: PackageManifest = {
      name: "@afora/example",
      version: "1.2.3",
      afora: {
        extensions: ["./src/index.ts"],
        runtimeExtensions: ["./dist/index.js"],
        setupEntry: "./src/setup.ts",
        runtimeSetupEntry: "./dist/setup.js",
        plugin: {
          id: "example",
          label: "Example",
        },
        compat: {
          pluginApi: ">=1",
          minGatewayVersion: "2026.8.1",
        },
        install: {
          npmSpec: "@afora/example",
          minHostVersion: "2026.8.1",
        },
      },
    };

    expect(getPackageManifestMetadata(manifest)).toEqual(manifest.afora);
    expect(resolvePackageExtensionEntries(manifest)).toEqual({
      status: "ok",
      entries: ["./src/index.ts"],
    });
  });

  // afora-compat: every plugin published before the rename declares `openclaw`, not `afora`.
  // Without the fallback `plugins install` rejects all of them as declaring no extensions.
  it("reads plugin metadata from the legacy manifest key", () => {
    const manifest = {
      name: "legacy-example",
      openclaw: { extensions: ["./dist/index.js"], plugin: { id: "legacy-example" } },
    } as PackageManifest;

    expect(getPackageManifestMetadata(manifest)).toEqual(manifest.openclaw);
    expect(resolvePackageExtensionEntries(manifest)).toEqual({
      status: "ok",
      entries: ["./dist/index.js"],
    });
  });

  it("prefers the canonical manifest key when a package declares both", () => {
    const manifest = {
      name: "both-example",
      afora: { extensions: ["./dist/current.js"] },
      openclaw: { extensions: ["./dist/legacy.js"] },
    } as PackageManifest;

    expect(getPackageManifestMetadata(manifest)).toEqual(manifest.afora);
    expect(resolvePackageExtensionEntries(manifest)).toEqual({
      status: "ok",
      entries: ["./dist/current.js"],
    });
  });

  // The half-migrated shapes. A package that has been given an `afora` section for something
  // else, or an empty one, or a null one, still declares its entrypoints under the old key.
  // Returning on the first DEFINED key read all three as "no extensions" and answered
  // `package.json missing afora.extensions`, which tells an operator to go and edit a third
  // party's package.json to fix a problem this repository created.
  it.each([
    { name: "a canonical section carrying something else", afora: { plugin: { id: "half" } } },
    { name: "an empty canonical section", afora: {} },
    { name: "a null canonical section", afora: null },
  ])("does not let $name shadow the legacy entrypoints", ({ afora }) => {
    const manifest = {
      name: "half-migrated",
      afora,
      openclaw: { extensions: ["./dist/legacy.js"] },
    } as unknown as PackageManifest;

    expect(resolvePackageExtensionEntries(manifest)).toEqual({
      status: "ok",
      entries: ["./dist/legacy.js"],
    });
  });

  it("keeps an explicitly empty canonical extensions list authoritative", () => {
    // An empty array is the package saying "no entrypoints", not the key being absent, so the
    // legacy section must NOT be reached. Without this the shadowing fix would quietly resurrect
    // entrypoints a package deliberately removed when it migrated.
    const manifest = {
      name: "deliberately-empty",
      afora: { extensions: [] },
      openclaw: { extensions: ["./dist/legacy.js"] },
    } as PackageManifest;

    expect(resolvePackageExtensionEntries(manifest)).toEqual({ status: "empty", entries: [] });
  });

  it("reports missing when a package declares no manifest key at all", () => {
    const manifest = { name: "bare-example" } as PackageManifest;

    expect(getPackageManifestMetadata(manifest)).toBeUndefined();
    expect(resolvePackageExtensionEntries(manifest)).toEqual({ status: "missing", entries: [] });
  });

  it.each([
    {
      name: "non-object afora metadata",
      manifest: { afora: "invalid" } as unknown as PackageManifest,
      error: "package.json afora must be an object",
    },
    {
      name: "non-array extension metadata",
      manifest: { afora: { extensions: "./index.js" } } as unknown as PackageManifest,
      error: "package.json afora.extensions must be an array",
    },
    {
      name: "blank extension metadata",
      manifest: { afora: { extensions: [" "] } } as PackageManifest,
      error: "package.json afora.extensions[0] must be a non-empty string",
    },
  ])("fails fast on $name", ({ manifest, error }) => {
    expect(resolvePackageExtensionEntries(manifest)).toEqual({
      status: "invalid",
      entries: [],
      error,
    });
  });

  it("rejects inconsistent source and runtime extension metadata", async () => {
    const result = await validatePackageExtensionEntriesForInstall({
      packageDir: process.cwd(),
      extensions: ["./src/one.ts", "./src/two.ts"],
      manifest: {
        afora: {
          extensions: ["./src/one.ts", "./src/two.ts"],
          runtimeExtensions: ["./dist/one.js"],
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      error:
        "package.json afora.runtimeExtensions length (1) must match afora.extensions length (2)",
    });
  });

  it("rejects a runtime setup entry without a source setup entry", async () => {
    const result = await validatePackageExtensionEntriesForInstall({
      packageDir: process.cwd(),
      extensions: [],
      manifest: {
        afora: {
          extensions: [],
          runtimeSetupEntry: "./dist/setup.js",
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      error: "package.json afora.runtimeSetupEntry requires afora.setupEntry",
    });
  });
});
