// Daemon inspect tests cover service inspection and diagnostic output.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectMarkerLineWithGateway,
  findExtraGatewayServices,
  renderGatewayServiceCleanupHints,
} from "./inspect.js";

const { execSchtasksMock } = vi.hoisted(() => ({
  execSchtasksMock: vi.fn(),
}));

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: (...args: unknown[]) => execSchtasksMock(...args),
}));

// Real content from the afora-gateway.service unit file (the canonical gateway unit).
const GATEWAY_SERVICE_CONTENTS = `\
[Unit]
Description=Afora Gateway
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /home/afora/.npm-global/lib/node_modules/afora/dist/entry.js gateway --port 18789
Restart=always
Environment=AFORA_SERVICE_MARKER=afora
Environment=AFORA_SERVICE_KIND=gateway

[Install]
WantedBy=default.target
`;

// Real content from the afora-test.service unit file (a non-gateway afora service).
const TEST_SERVICE_CONTENTS = `\
[Unit]
Description=Afora test service
After=default.target

[Service]
Type=simple
ExecStart=/bin/sh -c 'while true; do sleep 60; done'
Restart=on-failure

[Install]
WantedBy=default.target
`;

const CLAWDBOT_GATEWAY_CONTENTS = `\
[Unit]
Description=Clawdbot Gateway
[Service]
ExecStart=/usr/bin/node /opt/clawdbot/dist/entry.js gateway --port 18789
Environment=HOME=/home/clawdbot
`;

const COMPANION_SERVICE_CONTENTS = `\
[Unit]
Description=Afora companion worker
After=afora-gateway.service
Requires=afora-gateway.service

[Service]
ExecStart=/usr/bin/node /opt/afora-worker/dist/index.js worker
`;

const CUSTOM_AFORA_GATEWAY_CONTENTS = `\
[Unit]
Description=Custom Afora gateway

[Service]
ExecStart=/usr/bin/node /opt/afora/dist/entry.js gateway --port 18888
`;

describe("detectMarkerLineWithGateway", () => {
  it("returns null for afora-test.service (afora only in description, no gateway on same line)", () => {
    expect(detectMarkerLineWithGateway(TEST_SERVICE_CONTENTS)).toBeNull();
  });

  it("returns afora for the canonical gateway unit (ExecStart has both afora and gateway)", () => {
    expect(detectMarkerLineWithGateway(GATEWAY_SERVICE_CONTENTS)).toBe("afora");
  });

  it("returns clawdbot for a clawdbot gateway unit", () => {
    expect(detectMarkerLineWithGateway(CLAWDBOT_GATEWAY_CONTENTS)).toBe("clawdbot");
  });

  it("handles line continuations — marker and gateway split across physical lines", () => {
    const contents = `[Service]\nExecStart=/usr/bin/node /opt/afora/dist/entry.js \\\n  gateway --port 18789\n`;
    expect(detectMarkerLineWithGateway(contents)).toBe("afora");
  });

  it("ignores dependency-only references to the gateway unit", () => {
    expect(detectMarkerLineWithGateway(COMPANION_SERVICE_CONTENTS)).toBeNull();
  });

  it("ignores non-gateway ExecStart commands that only pass gateway-named options", () => {
    const contents = `[Service]\nExecStart=/usr/bin/afora-helper --gateway-url http://127.0.0.1:18789 sync\n`;
    expect(detectMarkerLineWithGateway(contents)).toBeNull();
  });
});

describe("renderGatewayServiceCleanupHints", () => {
  it("does not suggest removing a gateway when no extra service was detected", () => {
    expect(renderGatewayServiceCleanupHints([])).toEqual([]);
  });

  it.each([
    {
      title: "targets the detected macOS LaunchAgent instead of the active gateway",
      platform: "darwin",
      serviceName: "com.example.afora-gateway",
      source: "plist: /Users/test/Library/LaunchAgents/com.example.afora-gateway.plist",
      scope: "user",
      stopCommand: "launchctl bootout gui/$UID/com.example.afora-gateway",
      removeCommand: "rm /Users/test/Library/LaunchAgents/com.example.afora-gateway.plist",
    },
    {
      title: "uses the system domain for a detected macOS LaunchDaemon",
      platform: "darwin",
      serviceName: "com.example.afora-gateway",
      source: "plist: /Library/LaunchDaemons/com.example.afora-gateway.plist",
      scope: "system",
      stopCommand: "sudo launchctl bootout system/com.example.afora-gateway",
      removeCommand: "sudo rm /Library/LaunchDaemons/com.example.afora-gateway.plist",
    },
    {
      title: "keeps global macOS LaunchAgents in the GUI domain",
      platform: "darwin",
      serviceName: "com.example.afora-gateway",
      source: "plist: /Library/LaunchAgents/com.example.afora-gateway.plist",
      scope: "system",
      stopCommand: "launchctl bootout gui/$UID/com.example.afora-gateway",
      removeCommand: "sudo rm /Library/LaunchAgents/com.example.afora-gateway.plist",
    },
    {
      title: "targets the detected user-level systemd unit",
      platform: "linux",
      serviceName: "custom-gateway.service",
      source: "unit: /home/test/.config/systemd/user/custom-gateway.service",
      scope: "user",
      stopCommand: "systemctl --user disable --now -- custom-gateway.service",
      removeCommand: "rm /home/test/.config/systemd/user/custom-gateway.service",
    },
    {
      title: "targets the detected system-level systemd unit",
      platform: "linux",
      serviceName: "custom-gateway.service",
      source: "unit: /etc/systemd/system/custom-gateway.service",
      scope: "system",
      stopCommand: "sudo systemctl disable --now -- custom-gateway.service",
      removeCommand: "sudo rm /etc/systemd/system/custom-gateway.service",
    },
    {
      title: "terminates systemctl options before a detected unit that begins with a dash",
      platform: "linux",
      serviceName: "-custom-gateway.service",
      source: "unit: /home/test/.config/systemd/user/-custom-gateway.service",
      scope: "user",
      stopCommand: "systemctl --user disable --now -- -custom-gateway.service",
      removeCommand: "rm /home/test/.config/systemd/user/-custom-gateway.service",
    },
    {
      title: "shell-quotes detected POSIX service labels and paths",
      platform: "darwin",
      serviceName: "com.example.gateway; touch injected",
      source: "plist: /Users/test/Launch Agents/example's gateway.plist",
      scope: "user",
      stopCommand: "launchctl bootout gui/$UID/'com.example.gateway; touch injected'",
      removeCommand: "rm '/Users/test/Launch Agents/example'\\''s gateway.plist'",
    },
  ] as const)("$title", ({ platform, serviceName, source, scope, stopCommand, removeCommand }) => {
    expect(
      renderGatewayServiceCleanupHints([
        {
          platform,
          label: serviceName,
          detail: source,
          scope,
        },
      ]),
    ).toEqual([stopCommand, removeCommand]);
  });

  it("targets the detected Windows scheduled task", () => {
    expect(
      renderGatewayServiceCleanupHints([
        {
          platform: "win32",
          label: "\\Afora Gateway Backup",
          detail: "task: \\Afora Gateway Backup",
          scope: "system",
        },
      ]),
    ).toEqual(['schtasks /Delete /TN "\\Afora Gateway Backup" /F']);
  });

  it.each(["$(Start-Process calc)", "%AFORA_GATEWAY_TASK%", "unsafe&task", "task`name"])(
    "does not render a Windows task name expandable by cmd.exe or PowerShell: %s",
    (label) => {
      expect(
        renderGatewayServiceCleanupHints([
          {
            platform: "win32",
            label,
            detail: `task: ${label}`,
            scope: "system",
          },
        ]),
      ).toEqual([]);
    },
  );

  it("does not invent a removal path when service metadata omits it", () => {
    expect(
      renderGatewayServiceCleanupHints([
        {
          platform: "darwin",
          label: "com.example.afora-gateway",
          detail: "loaded",
          scope: "user",
        },
      ]),
    ).toEqual(["launchctl bootout gui/$UID/com.example.afora-gateway"]);
  });
});

describe("findExtraGatewayServices (linux / scanSystemdDir) — real filesystem", () => {
  // These tests write real .service files to a temp dir and call findExtraGatewayServices
  // with that dir as HOME. No platform mocking or fs mocking needed.
  // Only runs on Linux/macOS where the linux branch of findExtraGatewayServices is active.
  const isLinux = process.platform === "linux";

  it.skipIf(!isLinux)("does not report afora-test.service as a gateway service", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "afora-test-"));
    const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
    try {
      await fs.mkdir(systemdDir, { recursive: true });
      await fs.writeFile(path.join(systemdDir, "afora-test.service"), TEST_SERVICE_CONTENTS);
      const result = await findExtraGatewayServices({ HOME: tmpHome });
      expect(result).toStrictEqual([]);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });

  it.skipIf(!isLinux)(
    "does not report the canonical afora-gateway.service as an extra service",
    async () => {
      const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "afora-test-"));
      const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
      try {
        await fs.mkdir(systemdDir, { recursive: true });
        await fs.writeFile(
          path.join(systemdDir, "afora-gateway.service"),
          GATEWAY_SERVICE_CONTENTS,
        );
        const result = await findExtraGatewayServices({ HOME: tmpHome });
        expect(result).toStrictEqual([]);
      } finally {
        await fs.rm(tmpHome, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!isLinux)(
    "reports a legacy clawdbot-gateway service as an extra gateway service",
    async () => {
      const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "afora-test-"));
      const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
      const unitPath = path.join(systemdDir, "clawdbot-gateway.service");
      try {
        await fs.mkdir(systemdDir, { recursive: true });
        await fs.writeFile(unitPath, CLAWDBOT_GATEWAY_CONTENTS);
        const result = await findExtraGatewayServices({ HOME: tmpHome });
        expect(result).toEqual([
          {
            platform: "linux",
            label: "clawdbot-gateway.service",
            detail: `unit: ${unitPath}`,
            scope: "user",
            marker: "clawdbot",
            legacy: true,
          },
        ]);
      } finally {
        await fs.rm(tmpHome, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!isLinux)(
    "does not report companion units that only depend on the gateway",
    async () => {
      const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "afora-test-"));
      const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
      try {
        await fs.mkdir(systemdDir, { recursive: true });
        await fs.writeFile(
          path.join(systemdDir, "afora-companion.service"),
          COMPANION_SERVICE_CONTENTS,
        );
        const result = await findExtraGatewayServices({ HOME: tmpHome });
        expect(result).toStrictEqual([]);
      } finally {
        await fs.rm(tmpHome, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!isLinux)(
    "reports custom-named gateway units that execute afora gateway",
    async () => {
      const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "afora-test-"));
      const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
      const unitPath = path.join(systemdDir, "custom-afora.service");
      try {
        await fs.mkdir(systemdDir, { recursive: true });
        await fs.writeFile(unitPath, CUSTOM_AFORA_GATEWAY_CONTENTS);
        const result = await findExtraGatewayServices({ HOME: tmpHome });
        expect(result).toEqual([
          {
            platform: "linux",
            label: "custom-afora.service",
            detail: `unit: ${unitPath}`,
            scope: "user",
            marker: "afora",
            legacy: false,
          },
        ]);
      } finally {
        await fs.rm(tmpHome, { recursive: true, force: true });
      }
    },
  );
});

describe("findExtraGatewayServices (darwin / scanLaunchdDir) — real filesystem", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("does not report LaunchAgent companions that only mention the gateway label", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "afora-test-"));
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    try {
      await fs.mkdir(launchdDir, { recursive: true });
      await fs.writeFile(
        path.join(launchdDir, "com.example.companion.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.example.companion</string>
<key>KeepAlive</key><dict><key>OtherJobEnabled</key><dict><key>ai.afora.gateway</key><true/></dict></dict>
<key>ProgramArguments</key><array><string>/usr/local/bin/afora-helper</string><string>sync</string></array>
</dict></plist>`,
      );
      const result = await findExtraGatewayServices({ HOME: tmpHome });
      expect(result).toStrictEqual([]);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("does not report LaunchAgent companions that only pass gateway-named options", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "afora-test-"));
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    try {
      await fs.mkdir(launchdDir, { recursive: true });
      await fs.writeFile(
        path.join(launchdDir, "com.example.companion-options.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.example.companion-options</string>
<key>ProgramArguments</key><array><string>/usr/local/bin/afora-helper</string><string>--gateway-url</string><string>http://127.0.0.1:18789</string><string>sync</string></array>
</dict></plist>`,
      );
      const result = await findExtraGatewayServices({ HOME: tmpHome });
      expect(result).toStrictEqual([]);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("does not report non-gateway LaunchAgents that mention clawdbot in environment values", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "afora-test-"));
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    try {
      await fs.mkdir(launchdDir, { recursive: true });
      await fs.writeFile(
        path.join(launchdDir, "com.github.facebook.watchman.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.github.facebook.watchman</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/Users/test/Projects/clawdbot2/node_modules/.bin:/opt/homebrew/bin</string></dict>
<key>ProgramArguments</key><array><string>/opt/homebrew/bin/watchman</string><string>--foreground</string></array>
</dict></plist>`,
      );
      const result = await findExtraGatewayServices({ HOME: tmpHome });
      expect(result).toStrictEqual([]);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("reports custom LaunchAgents that execute afora gateway", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "afora-test-"));
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    const plistPath = path.join(launchdDir, "com.example.afora-gateway.plist");
    try {
      await fs.mkdir(launchdDir, { recursive: true });
      await fs.writeFile(
        plistPath,
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.example.afora-gateway</string>
<key>ProgramArguments</key><array><string>/usr/local/bin/afora</string><string>gateway</string><string>--port</string><string>18888</string></array>
</dict></plist>`,
      );
      const result = await findExtraGatewayServices({ HOME: tmpHome });
      expect(result).toEqual([
        {
          platform: "darwin",
          label: "com.example.afora-gateway",
          detail: `plist: ${plistPath}`,
          scope: "user",
          marker: "afora",
          legacy: false,
        },
      ]);
      expect(renderGatewayServiceCleanupHints(result)).toEqual([
        "launchctl bootout gui/$UID/com.example.afora-gateway",
        `rm ${plistPath}`,
      ]);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });
});

describe("findExtraGatewayServices (win32)", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    execSchtasksMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("skips schtasks queries unless deep mode is enabled", async () => {
    const result = await findExtraGatewayServices({});
    expect(result).toStrictEqual([]);
    expect(execSchtasksMock).not.toHaveBeenCalled();
  });

  it("returns empty results when schtasks query fails", async () => {
    execSchtasksMock.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "error",
    });

    const result = await findExtraGatewayServices({}, { deep: true });
    expect(result).toStrictEqual([]);
  });

  it("collects only non-afora marker tasks from schtasks output", async () => {
    // Real schtasks /Query /FO LIST /V output prefixes root-folder task
    // names with a backslash (e.g. TaskName:\Afora Gateway).
    execSchtasksMock.mockResolvedValueOnce({
      code: 0,
      stdout: [
        "TaskName:\\Afora Gateway",
        "Task To Run: C:\\Program Files\\Afora\\afora.exe gateway run",
        "",
        "TaskName: Clawdbot Legacy",
        "Task To Run: C:\\clawdbot\\clawdbot.exe run",
        "",
        "TaskName: Other Task",
        "Task To Run: C:\\tools\\helper.exe",
        "",
      ].join("\n"),
      stderr: "",
    });

    const result = await findExtraGatewayServices({}, { deep: true });
    // The \Afora Gateway task is the live launcher — it must be skipped.
    // Only the unrelated clawdbot task should be flagged.
    expect(result).toEqual([
      {
        platform: "win32",
        label: "Clawdbot Legacy",
        detail: "task: Clawdbot Legacy, run: C:\\clawdbot\\clawdbot.exe run",
        scope: "system",
        marker: "clawdbot",
        legacy: true,
      },
    ]);
  });

  it("reports duplicate root tasks that only share the gateway task prefix", async () => {
    execSchtasksMock.mockResolvedValueOnce({
      code: 0,
      stdout: [
        "TaskName:\\Afora Gateway",
        "Task To Run: C:\\Program Files\\Afora\\afora.exe gateway run",
        "",
        "TaskName:\\Afora Gateway (dev)",
        "Task To Run: C:\\Program Files\\Afora\\afora.exe gateway run --profile dev",
        "",
        "TaskName:\\Afora Gateway Backup",
        "Task To Run: C:\\Program Files\\Afora\\afora.exe gateway run",
        "",
      ].join("\n"),
      stderr: "",
    });

    const result = await findExtraGatewayServices({}, { deep: true });
    expect(result).toEqual([
      {
        platform: "win32",
        label: "\\Afora Gateway Backup",
        detail:
          "task: \\Afora Gateway Backup, run: C:\\Program Files\\Afora\\afora.exe gateway run",
        scope: "system",
        marker: "afora",
        legacy: false,
      },
    ]);
  });
});
