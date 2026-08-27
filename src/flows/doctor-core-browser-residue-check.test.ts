// Browser residue doctor tests cover detection of stale browser state.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AforaConfig } from "../config/types.afora.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";
import type { HealthRepairContext } from "./health-checks.js";

const browserMocks = vi.hoisted(() => ({
  detectLegacyClawdBrowserProfileResidue: vi.fn(),
  maybeArchiveLegacyClawdBrowserProfileResidue: vi.fn(),
  maybeRepairOwnedChromeExtensionNativeHosts: vi.fn().mockResolvedValue({
    changes: [],
    warnings: [],
  }),
  noteChromeMcpBrowserReadiness: vi.fn(),
}));

vi.mock("../commands/doctor-browser.js", () => ({
  detectLegacyClawdBrowserProfileResidue: browserMocks.detectLegacyClawdBrowserProfileResidue,
  maybeArchiveLegacyClawdBrowserProfileResidue:
    browserMocks.maybeArchiveLegacyClawdBrowserProfileResidue,
  maybeRepairOwnedChromeExtensionNativeHosts:
    browserMocks.maybeRepairOwnedChromeExtensionNativeHosts,
  noteChromeMcpBrowserReadiness: browserMocks.noteChromeMcpBrowserReadiness,
}));

const residue = {
  legacyProfileDir: "/tmp/afora-home/browser/clawd",
  legacyUserDataDir: "/tmp/afora-home/browser/clawd/user-data",
  canonicalUserDataDir: "/tmp/afora-home/browser/afora/user-data",
};

function runtime() {
  return { log() {}, error() {}, exit() {} };
}

function requireBrowserResidueCheck() {
  const check = CORE_HEALTH_CHECKS.find(
    (entry) => entry.id === "core/doctor/browser-clawd-profile-residue",
  );
  if (!check) {
    throw new Error("expected browser clawd profile residue health check");
  }
  return check;
}

describe("browser clawd profile residue health check", () => {
  beforeEach(() => {
    browserMocks.detectLegacyClawdBrowserProfileResidue.mockReset();
    browserMocks.maybeArchiveLegacyClawdBrowserProfileResidue.mockReset();
    browserMocks.noteChromeMcpBrowserReadiness.mockReset();
  });

  it("reports legacy clawd profile residue through doctor lint", async () => {
    browserMocks.detectLegacyClawdBrowserProfileResidue.mockResolvedValueOnce(residue);
    const cfg: AforaConfig = { browser: { profiles: { afora: { color: "#FF4500" } } } };
    const check = requireBrowserResidueCheck();

    const findings = await check.detect({
      mode: "lint",
      runtime: runtime(),
      cfg,
      configPath: "/tmp/afora-home/afora.json",
    });

    expect(browserMocks.detectLegacyClawdBrowserProfileResidue).toHaveBeenCalledWith(cfg, {
      configDir: "/tmp/afora-home",
    });
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/browser-clawd-profile-residue",
        severity: "warning",
        path: residue.legacyProfileDir,
        ocPath: "oc://state/browser/clawd",
      }),
    ]);
  });

  it("archives legacy clawd profile residue through structured repair", async () => {
    browserMocks.detectLegacyClawdBrowserProfileResidue.mockResolvedValue(residue);
    browserMocks.maybeArchiveLegacyClawdBrowserProfileResidue.mockResolvedValueOnce({
      changes: ["Archived legacy clawd managed browser profile residue."],
      warnings: [],
    });
    const cfg: AforaConfig = { browser: { profiles: { afora: { color: "#FF4500" } } } };
    const check = requireBrowserResidueCheck();
    const ctx: HealthRepairContext = {
      mode: "fix",
      runtime: runtime(),
      cfg,
      configPath: "/tmp/afora-home/afora.json",
    };

    const result = await check.repair?.(ctx, []);

    expect(browserMocks.maybeArchiveLegacyClawdBrowserProfileResidue).toHaveBeenCalledWith(cfg, {
      configDir: "/tmp/afora-home",
    });
    expect(result).toMatchObject({
      changes: ["Archived legacy clawd managed browser profile residue."],
      effects: [
        {
          kind: "state",
          action: "archive-legacy-browser-profile-residue",
          target: residue.legacyProfileDir,
          dryRunSafe: false,
        },
      ],
    });
  });

  it("supports dry-run repair without archiving the profile", async () => {
    browserMocks.detectLegacyClawdBrowserProfileResidue.mockResolvedValue(residue);
    const check = requireBrowserResidueCheck();

    const result = await check.repair?.(
      {
        mode: "fix",
        runtime: runtime(),
        cfg: {},
        configPath: "/tmp/afora-home/afora.json",
        dryRun: true,
      },
      [],
    );

    expect(browserMocks.maybeArchiveLegacyClawdBrowserProfileResidue).not.toHaveBeenCalled();
    expect(result?.changes.join("\n")).toContain("Would archive legacy clawd");
    expect(result?.effects).toEqual([
      expect.objectContaining({
        action: "would-archive-legacy-browser-profile-residue",
        target: residue.legacyProfileDir,
      }),
    ]);
  });
});
