// Covers plugin discovery threading and concurrency behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginDiscoveryResult } from "./discovery.js";
import * as installedPluginIndexRecordReader from "./installed-plugin-index-record-reader.js";

const discoverAforaPluginsMock = vi.fn();

vi.mock("./discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./discovery.js")>();
  return {
    ...actual,
    discoverAforaPlugins: (...args: unknown[]) => discoverAforaPluginsMock(...args),
  };
});

const { loadPluginManifestRegistryCore } = await import("./manifest-registry.js");
const { loadInstalledPluginIndexWithDiscovery } = await import("./installed-plugin-index.js");

const emptyDiscovery: PluginDiscoveryResult = { candidates: [], diagnostics: [] };

describe("discovery threading", () => {
  beforeEach(() => {
    discoverAforaPluginsMock.mockReset();
    discoverAforaPluginsMock.mockReturnValue(emptyDiscovery);
  });

  it("skips internal discoverAforaPlugins when discovery is supplied", () => {
    loadPluginManifestRegistryCore({ discovery: emptyDiscovery });
    expect(discoverAforaPluginsMock).not.toHaveBeenCalled();

    discoverAforaPluginsMock.mockClear();
    loadInstalledPluginIndexWithDiscovery({ discovery: emptyDiscovery, installRecords: {} });
    expect(discoverAforaPluginsMock).not.toHaveBeenCalled();
  });

  it("calls discoverAforaPlugins when neither discovery nor candidates supplied", () => {
    loadPluginManifestRegistryCore({});
    expect(discoverAforaPluginsMock).toHaveBeenCalledTimes(1);

    discoverAforaPluginsMock.mockClear();
    loadInstalledPluginIndexWithDiscovery({ installRecords: {} });
    expect(discoverAforaPluginsMock).toHaveBeenCalledTimes(1);
  });

  it("prefers explicit candidates over discovery when both are supplied", () => {
    loadPluginManifestRegistryCore({ candidates: [], diagnostics: [], discovery: emptyDiscovery });
    expect(discoverAforaPluginsMock).not.toHaveBeenCalled();

    discoverAforaPluginsMock.mockClear();
    loadInstalledPluginIndexWithDiscovery({
      candidates: [],
      discovery: emptyDiscovery,
      installRecords: {},
    });
    expect(discoverAforaPluginsMock).not.toHaveBeenCalled();
  });

  it("preserves explicit candidate diagnostics without loading persisted install records", () => {
    const readInstallRecords = vi.spyOn(
      installedPluginIndexRecordReader,
      "loadInstalledPluginIndexInstallRecordsSync",
    );
    const diagnostics = [{ level: "warn" as const, message: "explicit candidate diagnostic" }];

    const result = loadInstalledPluginIndexWithDiscovery({
      candidates: [],
      diagnostics,
      installRecords: {},
    });

    expect(result.manifestRegistry.diagnostics).toEqual(diagnostics);
    expect(result.discovery).toBeUndefined();
    expect(readInstallRecords).not.toHaveBeenCalled();
    expect(discoverAforaPluginsMock).not.toHaveBeenCalled();
  });
});
