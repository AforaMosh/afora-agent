import { describe, expect, it } from "vitest";
import {
  resolveClawHubInstallSpecsForUpdateChannel,
  resolveNpmInstallSpecsForUpdateChannel,
} from "./install-channel-specs.js";

describe("resolveNpmInstallSpecsForUpdateChannel", () => {
  it.each(["@afora/discord", "@afora/discord@latest"])(
    "targets the exact core version for official extended-stable intent %s",
    (spec) => {
      expect(
        resolveNpmInstallSpecsForUpdateChannel({
          spec,
          updateChannel: "extended-stable",
          officialPackageName: "@afora/discord",
          coreVersion: "2026.7.33",
        }),
      ).toEqual({
        installSpec: "@afora/discord@2026.7.33",
        recordSpec: spec,
      });
    },
  );

  it.each([
    "@afora/discord@2026.6.33",
    "@afora/discord@next",
    "@afora/discord@beta",
    "@afora/discord@^2026.6.0",
    "https://registry.example.test/discord.tgz",
  ])("preserves explicit extended-stable intent %s", (spec) => {
    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec,
        updateChannel: "extended-stable",
        officialPackageName: "@afora/discord",
        coreVersion: "2026.7.33",
      }),
    ).toEqual({ installSpec: spec, recordSpec: spec });
  });

  it("does not rewrite a third-party package", () => {
    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@acme/discord",
        updateChannel: "extended-stable",
        officialPackageName: "@afora/discord",
        coreVersion: "2026.7.33",
      }),
    ).toEqual({ installSpec: "@acme/discord", recordSpec: "@acme/discord" });
  });

  it("fails closed without an authoritative extended-stable core version", () => {
    expect(() =>
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@afora/discord",
        updateChannel: "extended-stable",
        officialPackageName: "@afora/discord",
      }),
    ).toThrow("requires an exact core version");
  });

  it("targets the exact core version for a stable version-bound plugin", () => {
    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@afora/codex",
        updateChannel: "stable",
        officialPackageName: "@afora/codex",
        coreVersion: "2026.8.1",
        versionBoundToCore: true,
      }),
    ).toEqual({
      installSpec: "@afora/codex@2026.8.1",
      recordSpec: "@afora/codex",
    });
  });

  it("preserves beta behavior for a version-bound plugin", () => {
    expect(
      resolveNpmInstallSpecsForUpdateChannel({
        spec: "@afora/codex@latest",
        updateChannel: "beta",
        officialPackageName: "@afora/codex",
        coreVersion: "2026.8.1-beta.3",
        versionBoundToCore: true,
      }),
    ).toEqual({
      installSpec: "@afora/codex@beta",
      recordSpec: "@afora/codex@latest",
      fallbackSpec: "@afora/codex@latest",
      fallbackLabel: "@afora/codex@beta",
    });
  });
});

describe("resolveClawHubInstallSpecsForUpdateChannel", () => {
  it("does not rewrite ClawHub on extended-stable", () => {
    expect(
      resolveClawHubInstallSpecsForUpdateChannel({
        spec: "clawhub:@afora/discord",
        updateChannel: "extended-stable",
      }),
    ).toEqual({
      installSpec: "clawhub:@afora/discord",
      recordSpec: "clawhub:@afora/discord",
    });
  });
});
