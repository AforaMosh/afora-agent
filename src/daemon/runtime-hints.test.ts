// Daemon runtime hint tests cover platform-specific daemon guidance.
import { describe, expect, it } from "vitest";
import { buildPlatformRuntimeLogHints, buildPlatformServiceStartHints } from "./runtime-hints.js";

describe("buildPlatformRuntimeLogHints", () => {
  it("renders launchd log hints on darwin", () => {
    expect(
      buildPlatformRuntimeLogHints({
        platform: "darwin",
        env: {
          HOME: "/Users/test",
          AFORA_STATE_DIR: "/tmp/afora-state",
          AFORA_LOG_PREFIX: "gateway",
        },
        systemdServiceName: "afora-gateway",
        windowsTaskName: "Afora Gateway",
      }),
    ).toEqual([
      "Launchd stdout (if installed): /Users/test/Library/Logs/afora/gateway.log",
      "Launchd stderr (if installed): suppressed",
      "Restart attempts: /tmp/afora-state/logs/gateway-restart.log",
    ]);
  });

  it("renders systemd and windows hints by platform", () => {
    expect(
      buildPlatformRuntimeLogHints({
        platform: "linux",
        env: {
          AFORA_STATE_DIR: "/tmp/afora-state",
        },
        systemdServiceName: "afora-gateway",
        windowsTaskName: "Afora Gateway",
      }),
    ).toEqual([
      "Logs: journalctl --user -u afora-gateway.service -n 200 --no-pager",
      "Restart attempts: /tmp/afora-state/logs/gateway-restart.log",
    ]);
    expect(
      buildPlatformRuntimeLogHints({
        platform: "win32",
        env: {
          AFORA_STATE_DIR: "/tmp/afora-state",
        },
        systemdServiceName: "afora-gateway",
        windowsTaskName: "Afora Gateway",
      }),
    ).toEqual([
      'Logs: schtasks /Query /TN "Afora Gateway" /V /FO LIST',
      "Restart attempts: /tmp/afora-state/logs/gateway-restart.log",
    ]);
  });
});

describe("buildPlatformServiceStartHints", () => {
  it("builds platform-specific service start hints", () => {
    expect(
      buildPlatformServiceStartHints({
        platform: "darwin",
        installCommand: "afora gateway install",
        startCommand: "afora gateway",
        launchAgentPlistPath: "~/Library/LaunchAgents/com.afora.gateway.plist",
        systemdServiceName: "afora-gateway",
        windowsTaskName: "Afora Gateway",
      }),
    ).toEqual([
      "afora gateway install",
      "afora gateway",
      "launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.afora.gateway.plist",
    ]);
    expect(
      buildPlatformServiceStartHints({
        platform: "linux",
        installCommand: "afora gateway install",
        startCommand: "afora gateway",
        launchAgentPlistPath: "~/Library/LaunchAgents/com.afora.gateway.plist",
        systemdServiceName: "afora-gateway",
        windowsTaskName: "Afora Gateway",
      }),
    ).toEqual([
      "afora gateway install",
      "afora gateway",
      "systemctl --user start afora-gateway.service",
    ]);
  });
});
