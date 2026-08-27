// iOS release signing tests cover checked-in Fastlane-managed profile pinning.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "ios-release-signing.mjs");

function runSigningResult(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    const e = error as { stdout?: unknown; stderr?: unknown };
    return {
      ok: false,
      stdout: formatProcessOutput(e.stdout),
      stderr: formatProcessOutput(e.stderr),
    };
  }
}

function formatProcessOutput(value: unknown): string {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return typeof value === "string" ? value : "";
}

function runSigning(mode: string): string {
  return execFileSync(process.execPath, [SCRIPT, "--mode", mode], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("scripts/ios-release-signing.mjs", () => {
  it.each([
    ["--mode"],
    ["--mode", "--manifest"],
    ["--mode", "-h"],
    ["--manifest"],
    ["--manifest", "-h"],
  ])("rejects missing values for %s before reading signing manifests", (...args) => {
    const result = runSigningResult(args);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain(`Missing value for ${args[0]}.`);
    expect(result.stderr).not.toContain("ENOENT");
    expect(result.stdout).toBe("");
  });

  it("emits manual App Store profile settings for every signed target", () => {
    const output = runSigning("xcconfig");

    expect(output).toContain("AFORA_CODE_SIGN_STYLE = Manual");
    expect(output).toContain("AFORA_CODE_SIGN_IDENTITY = Apple Distribution");
    expect(output).toContain("AFORA_APP_GROUP_ID = group.ai.aforafoundation.app.shared");
    expect(output).toContain("AFORA_APP_PROFILE = Afora App Store ai.aforafoundation.app");
    expect(output).toContain(
      "AFORA_SHARE_PROFILE = Afora App Store ai.aforafoundation.app.share",
    );
    expect(output).toContain(
      "AFORA_ACTIVITY_WIDGET_PROFILE = Afora App Store ai.aforafoundation.app.activitywidget",
    );
    expect(output).toContain(
      "AFORA_WATCH_APP_PROFILE = Afora App Store ai.aforafoundation.app.watchkitapp",
    );
    expect(output).not.toContain("AFORA_WATCH_EXTENSION_PROFILE");
  });

  it("documents the canonical release signing plan", () => {
    const output = runSigning("plan");

    expect(output).toContain("Team ID: FWJYW4S8P8");
    expect(output).toContain("Signing repo: git@github.com:afora/apps-signing.git");
    expect(output).toContain("Signing branch: main");
    expect(output).toContain("Signing setup and sync: Fastlane match");
    expect(output).not.toContain("AforaWatchExtension");
    expect(output).toContain(
      "capabilities: PUSH_NOTIFICATIONS, APP_GROUPS, APP_ATTEST, HEALTH_KIT",
    );
    expect(output).toContain("app groups: group.ai.aforafoundation.app.shared");
  });
});
