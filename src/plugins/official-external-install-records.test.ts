import { describe, expect, it } from "vitest";
import {
  resolveTrustedSourceLinkedOfficialClawHubInstall,
  resolveTrustedSourceLinkedOfficialNpmInstall,
  resolveTrustedSourceLinkedOfficialNpmSpec,
} from "./official-external-install-records.js";

describe("trusted official npm install records", () => {
  it("resolves an exact canonical catalog package", () => {
    const record = {
      source: "npm" as const,
      spec: "@afora/acpx@2026.7.2",
      resolvedName: "@afora/acpx",
      resolvedSpec: "@afora/acpx@2026.7.2",
    };

    expect(resolveTrustedSourceLinkedOfficialNpmSpec({ pluginId: "acpx", record })).toBe(
      "@afora/acpx",
    );
    expect(resolveTrustedSourceLinkedOfficialNpmInstall({ pluginId: "acpx", record })).toEqual({
      npmSpec: "@afora/acpx",
      pluginId: "acpx",
    });
  });

  it.each([
    {
      name: "missing requested spec",
      record: {
        source: "npm" as const,
        resolvedName: "@afora/acpx",
      },
    },
    {
      name: "resolved-spec-only evidence",
      record: {
        source: "npm" as const,
        resolvedSpec: "@afora/acpx@2026.7.2",
      },
    },
    {
      name: "resolved-name evidence with unrelated stale fields",
      record: {
        source: "npm" as const,
        spec: "@vendor/acpx@1.0.0",
        resolvedName: "@afora/acpx",
        resolvedSpec: "@vendor/acpx@1.0.0",
      },
    },
  ])("preserves canonical official updates for $name", ({ record }) => {
    expect(resolveTrustedSourceLinkedOfficialNpmSpec({ pluginId: "acpx", record })).toBe(
      "@afora/acpx",
    );
  });

  it("returns a replacement only for a catalog-declared legacy id", () => {
    const record = {
      source: "npm" as const,
      spec: "@afora/fish-audio-speech@2026.7.2-beta.7",
      resolvedName: "@afora/fish-audio-speech",
      resolvedSpec: "@afora/fish-audio-speech@2026.7.2-beta.7",
    };

    expect(
      resolveTrustedSourceLinkedOfficialNpmInstall({
        pluginId: "fish-audio",
        record,
      }),
    ).toEqual({
      npmSpec: "@afora/fish-audio-speech",
      pluginId: "fish-audio-speech",
      replacementPluginId: "fish-audio-speech",
    });
    expect(
      resolveTrustedSourceLinkedOfficialNpmInstall({
        pluginId: "unrelated-plugin",
        record,
      }),
    ).toBeUndefined();
  });

  it("fails closed when recorded npm identities disagree", () => {
    expect(
      resolveTrustedSourceLinkedOfficialNpmInstall({
        pluginId: "fish-audio",
        record: {
          source: "npm",
          spec: "@afora/fish-audio-speech@2026.7.2-beta.7",
          resolvedName: "@vendor/fish-audio-speech",
          resolvedSpec: "@afora/fish-audio-speech@2026.7.2-beta.7",
        },
      }),
    ).toBeUndefined();
  });

  it("never accepts the legacy Fish Audio id through ClawHub", () => {
    expect(
      resolveTrustedSourceLinkedOfficialClawHubInstall({
        pluginId: "fish-audio",
        record: {
          source: "clawhub",
          spec: "clawhub:@afora/fish-audio-speech",
          clawhubPackage: "@afora/fish-audio-speech",
          clawhubChannel: "official",
          clawhubUrl: "https://clawhub.ai",
        },
      }),
    ).toBeUndefined();
  });
});
