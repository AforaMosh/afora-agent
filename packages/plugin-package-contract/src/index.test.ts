// Plugin Package Contract tests cover index behavior.
import { describe, expect, it } from "vitest";
import {
  EXTERNAL_CODE_PLUGIN_REQUIRED_FIELD_PATHS,
  listMissingExternalCodePluginFieldPaths,
  normalizeExternalPluginCompatibility,
  validateExternalCodePluginPackageJson,
} from "./index.js";

describe("@afora/plugin-package-contract", () => {
  it("normalizes the Afora compatibility block for external plugins", () => {
    expect(
      normalizeExternalPluginCompatibility({
        version: "1.2.3",
        afora: {
          compat: {
            pluginApi: ">=2026.3.24-beta.2",
            minGatewayVersion: "2026.3.24-beta.2",
          },
          build: {
            aforaVersion: "2026.3.24-beta.2",
            pluginSdkVersion: "0.9.0",
          },
        },
      }),
    ).toEqual({
      pluginApiRange: ">=2026.3.24-beta.2",
      builtWithAforaVersion: "2026.3.24-beta.2",
      pluginSdkVersion: "0.9.0",
      minGatewayVersion: "2026.3.24-beta.2",
    });
  });

  it("falls back to install.minHostVersion and package version when compatible", () => {
    expect(
      normalizeExternalPluginCompatibility({
        version: "1.2.3",
        afora: {
          compat: {
            pluginApi: ">=1.0.0",
          },
          install: {
            minHostVersion: "2026.3.24-beta.2",
          },
        },
      }),
    ).toEqual({
      pluginApiRange: ">=1.0.0",
      builtWithAforaVersion: "1.2.3",
      minGatewayVersion: "2026.3.24-beta.2",
    });
  });

  it("lists the required external code-plugin fields", () => {
    expect(EXTERNAL_CODE_PLUGIN_REQUIRED_FIELD_PATHS).toEqual([
      "afora.compat.pluginApi",
      "afora.build.aforaVersion",
    ]);
  });

  it("reports missing required fields with stable field paths", () => {
    const packageJson = {
      afora: {
        compat: {},
        build: {},
      },
    };

    expect(listMissingExternalCodePluginFieldPaths(packageJson)).toEqual([
      "afora.compat.pluginApi",
      "afora.build.aforaVersion",
    ]);
    expect(validateExternalCodePluginPackageJson(packageJson).issues).toEqual([
      {
        fieldPath: "afora.compat.pluginApi",
        message: "afora.compat.pluginApi is required for external code plugin packages.",
      },
      {
        fieldPath: "afora.build.aforaVersion",
        message: "afora.build.aforaVersion is required for external code plugin packages.",
      },
    ]);
  });
});
