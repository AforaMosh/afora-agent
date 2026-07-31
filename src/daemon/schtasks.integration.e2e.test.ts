import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveGatewayWindowsTaskName } from "./constants.js";
import { execSchtasks } from "./schtasks-exec.js";
import { resolveStartupEntryPaths } from "./schtasks-layout.js";
import { readWindowsProcessSnapshot } from "./schtasks-process.js";
import { probeScheduledTaskExists } from "./schtasks-runtime.js";
import { resolveTaskScriptPath } from "./schtasks.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type { GatewayServiceEnv } from "./service-types.js";
import { resolveGatewayService } from "./service.js";

const WAIT_INTERVAL_MS = 200;
const WAIT_TIMEOUT_MS = 30_000;
const TASK_LOGON_INTERACTIVE_TOKEN = 3;
const TASK_RUNLEVEL_LEAST_PRIVILEGE = 0;

type ScheduledTaskPrincipal = {
  logonType: number;
  runLevel: number;
};

async function sleep(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, WAIT_INTERVAL_MS);
  });
}

async function readRunPids(eventsPath: string): Promise<number[]> {
  const content = await fs.readFile(eventsPath, "utf8").catch(() => "");
  return content
    .split(/\r?\n/u)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 1);
}

async function waitForRunCount(eventsPath: string, expected: number): Promise<number[]> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let pids: number[] = [];
  while (Date.now() < deadline) {
    pids = await readRunPids(eventsPath);
    if (pids.length >= expected) {
      return pids;
    }
    await sleep();
  }
  throw new Error(`Timed out waiting for ${expected} Scheduled Task runs; observed ${pids.length}`);
}

function requireRunPid(pids: number[], index: number): number {
  const pid = pids[index];
  if (pid === undefined) {
    throw new Error(`Scheduled Task run ${index + 1} did not record a process id`);
  }
  return pid;
}

async function waitForRuntimeStatus(
  readRuntime: () => Promise<GatewayServiceRuntime>,
  expected: "running" | "stopped",
): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let lastStatus = "unknown";
  let lastDetail = "";
  while (Date.now() < deadline) {
    const runtime = await readRuntime();
    lastStatus = runtime.status ?? "unknown";
    lastDetail = runtime.detail ?? "";
    if (runtime.status === expected) {
      return;
    }
    await sleep();
  }
  throw new Error(
    `Timed out waiting for Scheduled Task status=${expected}; observed ${lastStatus}: ${lastDetail}`,
  );
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await sleep();
  }
  throw new Error(`Timed out waiting for Scheduled Task process ${pid} to exit`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readTaskXml(taskName: string): Promise<string | null> {
  const result = await execSchtasks(["/Query", "/TN", taskName, "/XML"]);
  return result.code === 0
    ? result.stdout.replace(/^\uFEFF/u, "").replaceAll(String.fromCharCode(0), "")
    : null;
}

function readTaskPrincipal(taskName: string): ScheduledTaskPrincipal {
  const encodedTaskName = Buffer.from(taskName, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$taskName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTaskName}'))`,
    "$service=New-Object -ComObject 'Schedule.Service'",
    "$service.Connect()",
    "$principal=$service.GetFolder('\\').GetTask($taskName).Definition.Principal",
    "$result=@{logonType=[int]$principal.LogonType;runLevel=[int]$principal.RunLevel}",
    "[Console]::Out.Write(($result | ConvertTo-Json -Compress))",
  ].join("; ");
  const result = spawnSync(
    getWindowsPowerShellExePath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", timeout: 5_000, windowsHide: true },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Could not inspect Scheduled Task principal for ${taskName}: ${
        result.stderr.trim() || `PowerShell exited ${result.status ?? "without status"}`
      }`,
    );
  }
  const parsed = JSON.parse(result.stdout.trim()) as Partial<ScheduledTaskPrincipal>;
  if (
    typeof parsed.logonType !== "number" ||
    !Number.isInteger(parsed.logonType) ||
    typeof parsed.runLevel !== "number" ||
    !Number.isInteger(parsed.runLevel)
  ) {
    throw new Error(`Scheduled Task principal returned invalid data for ${taskName}`);
  }
  return {
    logonType: parsed.logonType,
    runLevel: parsed.runLevel,
  };
}

function assertInteractiveLeastPrivilegeTask(params: {
  principal: ScheduledTaskPrincipal;
  taskXml: string;
}): void {
  expect(params.taskXml).toContain("<LogonType>InteractiveToken</LogonType>");
  expect(params.principal.logonType).toBe(TASK_LOGON_INTERACTIVE_TOKEN);
  expect(params.principal.runLevel).toBe(TASK_RUNLEVEL_LEAST_PRIVILEGE);
  const exportedRunLevel = params.taskXml.match(/<RunLevel>([^<]+)<\/RunLevel>/u)?.[1];
  // Task Scheduler may omit the default LeastPrivilege node when exporting XML.
  // If present, it must agree with the effective COM principal checked above.
  expect(exportedRunLevel === undefined || exportedRunLevel === "LeastPrivilege").toBe(true);
}

async function clearActivePid(activePidPath: string, pid: number): Promise<void> {
  const activePid = Number.parseInt(await fs.readFile(activePidPath, "utf8").catch(() => ""), 10);
  if (activePid === pid) {
    await fs.rm(activePidPath, { force: true });
  }
}

async function forceKillActiveProcess(params: {
  activePidPath: string;
  eventsPath: string;
  probePath: string;
}): Promise<void> {
  await sleep();
  let activePidText: string;
  try {
    activePidText = await fs.readFile(params.activePidPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const activePid = Number.parseInt(activePidText.trim(), 10);
  if (!Number.isSafeInteger(activePid) || activePid <= 1) {
    throw new Error(`Invalid Scheduled Task active process id: ${activePidText.trim() || "empty"}`);
  }
  if (!isProcessAlive(activePid)) {
    await fs.rm(params.activePidPath, { force: true });
    return;
  }
  const normalizedProbePath = params.probePath.replaceAll("/", "\\").toLowerCase();
  const normalizedEventsPath = params.eventsPath.replaceAll("/", "\\").toLowerCase();
  const snapshot = readWindowsProcessSnapshot();
  if (!snapshot) {
    throw new Error("Could not verify Scheduled Task probe ownership during cleanup");
  }
  const activeProcess = snapshot.find((entry) => entry.ProcessId === activePid);
  const commandLine = (activeProcess?.CommandLine ?? "").replaceAll("/", "\\").toLowerCase();
  if (!commandLine.includes(normalizedProbePath) || !commandLine.includes(normalizedEventsPath)) {
    throw new Error(
      `Refused to kill reused or unverifiable Scheduled Task process id ${activePid}`,
    );
  }
  try {
    process.kill(activePid, "SIGKILL");
  } catch {}
  await waitForProcessExit(activePid);
  await fs.rm(params.activePidPath, { force: true });
}

async function cleanupNativeTask(params: {
  activePidPath: string;
  eventsPath: string;
  preserveEvidence: boolean;
  probePath: string;
  rootDir: string;
  stateDir: string;
  taskName: string;
}): Promise<void> {
  const cleanupErrors: unknown[] = [];
  await execSchtasks(["/End", "/TN", params.taskName]).catch(() => undefined);
  try {
    await forceKillActiveProcess({
      activePidPath: params.activePidPath,
      eventsPath: params.eventsPath,
      probePath: params.probePath,
    });
  } catch (error) {
    cleanupErrors.push(error);
  }
  const deletion = await execSchtasks(["/Delete", "/F", "/TN", params.taskName]).catch(
    (error: unknown) => {
      cleanupErrors.push(error);
      return null;
    },
  );
  const taskExists = probeScheduledTaskExists(params.taskName);
  if (taskExists === null) {
    cleanupErrors.push(new Error(`Could not verify Scheduled Task cleanup for ${params.taskName}`));
  } else if (taskExists) {
    const detail = deletion ? (deletion.stderr || deletion.stdout).trim() : "";
    cleanupErrors.push(
      new Error(
        `Scheduled Task cleanup left ${params.taskName} registered${detail ? `: ${detail}` : ""}`,
      ),
    );
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Native Scheduled Task process or task cleanup failed");
  }
  if (params.preserveEvidence) {
    return;
  }
  for (const cleanupPath of [params.stateDir, params.rootDir]) {
    try {
      await fs.rm(cleanupPath, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Native Scheduled Task path cleanup failed");
  }
}

function expectProbeProcessAlive(pid: number): void {
  expect(isProcessAlive(pid), `Expected Scheduled Task probe process ${pid} to remain alive`).toBe(
    true,
  );
}

function resolveTestId(): string {
  const configured = process.env.CI_WINDOWS_SCHTASKS_TEST_ID?.trim();
  if (!configured) {
    return randomUUID().slice(0, 8);
  }
  if (!/^[a-z0-9-]{1,48}$/u.test(configured)) {
    throw new Error("CI_WINDOWS_SCHTASKS_TEST_ID must use lowercase letters, digits, or -");
  }
  return configured;
}

describe("schtasks Windows integration principal assertion", () => {
  it("accepts omitted default run level when COM reports least privilege", () => {
    expect(() =>
      assertInteractiveLeastPrivilegeTask({
        taskXml: "<LogonType>InteractiveToken</LogonType>",
        principal: {
          logonType: TASK_LOGON_INTERACTIVE_TOKEN,
          runLevel: TASK_RUNLEVEL_LEAST_PRIVILEGE,
        },
      }),
    ).not.toThrow();
  });

  it("rejects an elevated effective run level", () => {
    expect(() =>
      assertInteractiveLeastPrivilegeTask({
        taskXml: "<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>",
        principal: {
          logonType: TASK_LOGON_INTERACTIVE_TOKEN,
          runLevel: 1,
        },
      }),
    ).toThrow();
  });
});

const nativeIntegrationEnabled =
  process.platform === "win32" && process.env.CI_WINDOWS_SCHTASKS_INTEGRATION === "1";

describe.runIf(nativeIntegrationEnabled)("schtasks Windows integration", () => {
  it("isolates and completes the native Scheduled Task lifecycle", async () => {
    const id = resolveTestId();
    const configuredRoot = process.env.CI_WINDOWS_SCHTASKS_ROOT?.trim();
    const rootDir = configuredRoot
      ? path.resolve(configuredRoot)
      : await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-schtasks-int-${id}-`));
    if (configuredRoot) {
      await fs.rm(rootDir, { recursive: true, force: true });
      await fs.mkdir(rootDir, { recursive: true });
    }
    const accountHome = os.userInfo().homedir;
    const profile = `schtasks-int-${id}`;
    const stateDir = path.join(accountHome, `.openclaw-${profile}`);
    const activePidPath = path.join(rootDir, "active-pid.txt");
    const eventsPath = path.join(rootDir, "runs.txt");
    const probePath = path.join(rootDir, "probe.cjs");
    const taskName = resolveGatewayWindowsTaskName(profile);
    const stdout = new PassThrough();
    const env: GatewayServiceEnv = {
      ...process.env,
      APPDATA: path.join(rootDir, "appdata"),
      HOME: accountHome,
      USERPROFILE: accountHome,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_HOME: undefined,
      OPENCLAW_PROFILE: profile,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TASK_SCRIPT: undefined,
      OPENCLAW_TASK_SCRIPT_NAME: undefined,
      OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: undefined,
      OPENCLAW_WINDOWS_TASK_NAME: undefined,
    };
    const defaultTaskXml = await readTaskXml("OpenClaw Gateway");
    const scriptPath = resolveTaskScriptPath(env);

    await fs.writeFile(
      probePath,
      [
        'const fs = require("node:fs");',
        "const activePidPath = process.argv[3];",
        "const activePidTempPath = `${activePidPath}.${process.pid}.tmp`;",
        "fs.writeFileSync(activePidTempPath, String(process.pid));",
        "fs.renameSync(activePidTempPath, activePidPath);",
        "fs.appendFileSync(process.argv[2], `${process.pid}\\n`);",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      "utf8",
    );

    let testFailed = false;
    let testError: unknown;
    let lifecyclePids: number[] = [];
    try {
      await withEnvAsync(env, async () => {
        const service = resolveGatewayService();
        const readRuntime = () => service.readRuntime(env);

        expect((await execSchtasks(["/Query", "/TN", taskName])).code).not.toBe(0);
        expect(path.relative(stateDir, scriptPath)).not.toMatch(/^\.\.(?:[\\/]|$)/u);

        await service.install({
          env,
          stdout,
          programArguments: [process.execPath, probePath, eventsPath, activePidPath],
          workingDirectory: rootDir,
          description: `OpenClaw CI Scheduled Task integration ${id}`,
        });

        expect((await execSchtasks(["/Query", "/TN", taskName])).code).toBe(0);
        const taskXml = await readTaskXml(taskName);
        if (!taskXml) {
          throw new Error(`Could not export Scheduled Task XML for ${taskName}`);
        }
        expect(taskXml).toContain("<UserId>");
        assertInteractiveLeastPrivilegeTask({
          taskXml,
          principal: readTaskPrincipal(taskName),
        });
        for (const startupEntryPath of resolveStartupEntryPaths(env)) {
          await expect(fs.access(startupEntryPath)).rejects.toThrow();
        }
        const command = await service.readCommand(env);
        expect(command?.programArguments).toEqual([
          process.execPath,
          probePath,
          eventsPath,
          activePidPath,
        ]);
        const installedPid = requireRunPid(await waitForRunCount(eventsPath, 1), 0);
        expectProbeProcessAlive(installedPid);
        await waitForRuntimeStatus(readRuntime, "running");

        const stopMutations: string[] = [];
        await service.stop({
          env,
          stdout,
          onMutation: (mutation) => stopMutations.push(mutation.mode),
        });
        expect(stopMutations).toEqual(["schtasks-stop"]);
        await waitForProcessExit(installedPid);
        await clearActivePid(activePidPath, installedPid);
        await waitForRuntimeStatus(readRuntime, "stopped");
        expect((await execSchtasks(["/Query", "/TN", taskName])).code).toBe(0);

        const startMutations: string[] = [];
        await service.start({
          env,
          stdout,
          onMutation: (mutation) => startMutations.push(mutation.mode),
        });
        expect(startMutations).toEqual(["schtasks-start"]);
        const startedPid = requireRunPid(await waitForRunCount(eventsPath, 2), 1);
        expect(startedPid).not.toBe(installedPid);
        expectProbeProcessAlive(startedPid);
        await waitForRuntimeStatus(readRuntime, "running");

        const restartMutations: string[] = [];
        const restartResult = await service.restart({
          env,
          stdout,
          onMutation: (mutation) => restartMutations.push(mutation.mode),
        });
        expect(restartResult).toEqual({ outcome: "completed" });
        expect(restartMutations).toEqual(["schtasks-end", "schtasks-restart"]);
        const restartedPid = requireRunPid(await waitForRunCount(eventsPath, 3), 2);
        lifecyclePids = [installedPid, startedPid, restartedPid];
        expect(restartedPid).not.toBe(startedPid);
        expectProbeProcessAlive(restartedPid);
        await waitForProcessExit(startedPid);
        await clearActivePid(activePidPath, startedPid);
        await waitForRuntimeStatus(readRuntime, "running");

        await service.stop({ env, stdout });
        await waitForProcessExit(restartedPid);
        await clearActivePid(activePidPath, restartedPid);
        await waitForRuntimeStatus(readRuntime, "stopped");

        await service.uninstall({ env, stdout });
        expect((await execSchtasks(["/Query", "/TN", taskName])).code).not.toBe(0);
        await expect(fs.access(scriptPath)).rejects.toThrow();
        expect(await readTaskXml("OpenClaw Gateway")).toBe(defaultTaskXml);

        const proofPath = process.env.CI_WINDOWS_SCHTASKS_PROOF_PATH?.trim();
        if (proofPath) {
          const proofHead = process.env.CI_WINDOWS_SCHTASKS_HEAD?.trim();
          if (!proofHead || !/^[0-9a-f]{40}$/u.test(proofHead)) {
            throw new Error(
              "CI_WINDOWS_SCHTASKS_HEAD must identify the exact 40-character checkout SHA",
            );
          }
          await fs.mkdir(path.dirname(proofPath), { recursive: true });
          await fs.writeFile(
            proofPath,
            `${JSON.stringify(
              {
                result: "pass",
                head: proofHead,
                profile,
                taskName,
                lifecycle: ["install", "stop", "start", "restart", "stop", "uninstall"],
                pids: lifecyclePids,
                startupFallback: false,
                defaultTaskUnchanged: true,
                taskXml: {
                  interactiveToken: true,
                  leastPrivilege: true,
                },
              },
              null,
              2,
            )}\n`,
            "utf8",
          );
        }
      });
    } catch (error) {
      testFailed = true;
      testError = error;
    }

    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
      await cleanupNativeTask({
        activePidPath,
        eventsPath,
        preserveEvidence: testFailed,
        probePath,
        rootDir,
        stateDir,
        taskName,
      });
    } catch (error) {
      cleanupFailed = true;
      cleanupError = error;
    }
    if (cleanupFailed) {
      throw new AggregateError(
        testFailed ? [testError, cleanupError] : [cleanupError],
        "Native Scheduled Task cleanup failed",
      );
    }
    if (testFailed) {
      throw testError;
    }
  }, 180_000);
});
