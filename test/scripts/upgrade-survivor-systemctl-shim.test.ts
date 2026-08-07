import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const SHIM_HELPER_PATH = "scripts/e2e/lib/upgrade-survivor/systemctl-shim.sh";
const SYSTEMD_UNIT_PATH = "src/daemon/systemd-unit.ts";
const PUBLISHED_RUNNER_PATH = "scripts/e2e/lib/upgrade-survivor/run.sh";
const UPDATE_RESTART_AUTH_PATH = "scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh";

type Fixture = {
  childPidFile: string;
  envFile: string;
  gatewayRunsFile: string;
  shim: string;
  shimEnv: NodeJS.ProcessEnv;
  supervisorPidFile: string;
  workerAliveAtRestartFile: string;
  workerPidFile: string;
  workerTermFile: string;
};

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error(message);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).stdout.trim();
    return state !== "" && !state.startsWith("Z");
  } catch {
    return false;
  }
}

function readLines(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
}

function createFixture(
  mode:
    | "stay-running"
    | "with-descendant"
    | "restart-with-stubborn-descendant"
    | "restart-once"
    | "always-fail"
    | "exit-78",
): Fixture {
  const root = tempDirs.make("openclaw-systemctl-shim-");
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  const state = join(root, "state");
  const unitDir = join(home, ".config/systemd/user");
  const gateway = join(root, "gateway.sh");
  const envFile = join(root, "service.env");
  const gatewayRunsFile = join(root, "gateway-runs.log");
  const workerAliveAtRestartFile = join(root, "worker-alive-at-restart");
  const workerPidFile = join(root, "worker.pid");
  const workerTermFile = join(root, "worker-term");
  const childPidFile = join(state, "gateway.pid");
  const supervisorPidFile = `${childPidFile}.supervisor.pid`;
  const daemonLog = join(state, "gateway.log");
  mkdirSync(unitDir, { recursive: true });
  mkdirSync(state, { recursive: true });

  writeFileSync(
    gateway,
    `#!/usr/bin/env bash
set -euo pipefail
count_file="$TEST_RUN_DIR/count"
count=0
[ ! -f "$count_file" ] || count="$(cat "$count_file")"
count=$((count + 1))
printf '%s\\n' "$count" >"$count_file"
printf '%s|%s|%s\\n' "$$" "\${OPENCLAW_UPDATE_IN_PROGRESS-unset}" "\${OPENCLAW_UPDATE_UNIT_DEFINED-unset}" >>"$TEST_RUN_DIR/gateway-runs.log"
case "$TEST_MODE" in
  stay-running)
    trap 'exit 0' INT TERM
    while true; do sleep 1; done
    ;;
  with-descendant)
    (
      trap 'exit 0' INT TERM
      while true; do sleep 1; done
    ) &
    printf '%s\\n' "$!" >"$TEST_RUN_DIR/worker.pid"
    trap 'exit 0' INT TERM
    while true; do sleep 1; done
    ;;
  restart-with-stubborn-descendant)
    if [ "$count" -eq 1 ]; then
      (
        trap 'printf "%s\\n" TERM >"$TEST_RUN_DIR/worker-term"' TERM
        while true; do sleep 1; done
      ) &
      printf '%s\\n' "$!" >"$TEST_RUN_DIR/worker.pid"
      sleep 0.05
      exit 1
    fi
    old_worker_pid="$(cat "$TEST_RUN_DIR/worker.pid")"
    old_worker_state="$(ps -o stat= -p "$old_worker_pid" 2>/dev/null | cut -c1 || true)"
    if kill -0 "$old_worker_pid" >/dev/null 2>&1 &&
      [ -n "$old_worker_state" ] &&
      [ "$old_worker_state" != "Z" ]; then
      printf '%s\\n' "$old_worker_pid" >"$TEST_RUN_DIR/worker-alive-at-restart"
    fi
    trap 'exit 0' INT TERM
    while true; do sleep 1; done
    ;;
  restart-once)
    if [ "$count" -eq 1 ]; then sleep 0.2; exit 1; fi
    trap 'exit 0' INT TERM
    while true; do sleep 1; done
    ;;
  always-fail)
    sleep 0.05
    exit 1
    ;;
  exit-78)
    sleep 0.05
    exit 78
    ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    envFile,
    `TEST_RUN_DIR=${root}
TEST_MODE=${mode}
OPENCLAW_UPDATE_UNIT_DEFINED=unit-one
`,
  );
  writeFileSync(
    join(unitDir, "openclaw-gateway.service"),
    `[Unit]
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
ExecStart=${gateway}
Restart=always
RestartSec=5
RestartPreventExitStatus=78
EnvironmentFile=-${envFile}
`,
  );

  const installEnv = {
    ...process.env,
    HOME: home,
    npm_config_prefix: prefix,
    OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG: join(state, "systemctl.log"),
    OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE: childPidFile,
    OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG: daemonLog,
  };
  execFileSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `source "$1"; install_update_restart_systemctl_shim`,
      "install-systemctl-shim",
      SHIM_HELPER_PATH,
    ],
    { env: installEnv },
  );

  return {
    childPidFile,
    envFile,
    gatewayRunsFile,
    shim: join(prefix, "bin/systemctl"),
    shimEnv: {
      ...installEnv,
      OPENCLAW_UPDATE_IN_PROGRESS: "caller-update",
      OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_RESTART_SEC_MS: "50",
      OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_START_LIMIT_BURST: "5",
      OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_START_LIMIT_INTERVAL_MS: "2000",
      OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_STOP_TIMEOUT_MS: "500",
    },
    supervisorPidFile,
    workerAliveAtRestartFile,
    workerPidFile,
    workerTermFile,
  };
}

function runSystemctl(fixture: Fixture, args: string[]): string {
  return execFileSync(fixture.shim, args, {
    encoding: "utf8",
    env: fixture.shimEnv,
  });
}

function runSystemctlResult(fixture: Fixture, args: string[]) {
  return spawnSync(fixture.shim, args, {
    encoding: "utf8",
    env: fixture.shimEnv,
  });
}

describe("upgrade survivor systemctl shim", () => {
  it("is the single supervisor implementation used by both package paths", () => {
    const helper = readFileSync(SHIM_HELPER_PATH, "utf8");
    const productionUnit = readFileSync(SYSTEMD_UNIT_PATH, "utf8");
    for (const file of [PUBLISHED_RUNNER_PATH, UPDATE_RESTART_AUTH_PATH]) {
      const script = readFileSync(file, "utf8");
      expect(script).toContain("source scripts/e2e/lib/upgrade-survivor/systemctl-shim.sh");
      expect(script).not.toContain('cat >"$shim_dir/systemctl"');
    }
    for (const contract of [
      ["Restart=always", "5_000"],
      ["RestartSec=5", "5_000"],
      ["RestartPreventExitStatus=78", "code === 78"],
      ["StartLimitBurst=5", "5"],
      ["StartLimitIntervalSec=60", "60_000"],
      ["TimeoutStopSec=30", "30_000"],
      ["KillMode=control-group", "detached: true"],
    ]) {
      expect(productionUnit).toContain(contract[0]);
      expect(helper).toContain(contract[1]);
    }
  });

  it("restarts failures with fresh unit env and reports the gateway child as MainPID", async () => {
    const fixture = createFixture("restart-once");
    fixture.shimEnv.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_RESTART_SEC_MS = "1000";
    runSystemctl(fixture, ["--user", "start", "openclaw-gateway.service"]);

    await waitFor(
      () => readLines(fixture.gatewayRunsFile).length === 1,
      "first gateway did not run",
    );
    const supervisorPid = Number(readFileSync(fixture.supervisorPidFile, "utf8").trim());
    await waitFor(
      () => !existsSync(fixture.childPidFile),
      "gateway child PID remained during restart delay",
    );
    const inactive = runSystemctlResult(fixture, [
      "--user",
      "is-active",
      "openclaw-gateway.service",
    ]);
    expect(inactive.status).toBe(3);
    const delayedShow = runSystemctl(fixture, [
      "--user",
      "show",
      "--property=MainPID",
      "openclaw-gateway.service",
    ]);
    expect(delayedShow).toContain("ActiveState=inactive");
    expect(delayedShow).toContain("MainPID=0");
    expect(processIsAlive(supervisorPid)).toBe(true);
    expect(existsSync(fixture.supervisorPidFile)).toBe(true);

    writeFileSync(
      fixture.envFile,
      `${readFileSync(fixture.envFile, "utf8").replace("unit-one", "unit-two")}`,
    );
    await waitFor(
      () => readLines(fixture.gatewayRunsFile).length === 2,
      "failed gateway was not restarted",
    );

    const runs = readLines(fixture.gatewayRunsFile);
    expect(runs[0]?.split("|").slice(1)).toEqual(["unset", "unit-one"]);
    expect(runs[1]?.split("|").slice(1)).toEqual(["unset", "unit-two"]);

    const show = runSystemctl(fixture, [
      "--user",
      "show",
      "--property=MainPID",
      "openclaw-gateway.service",
    ]);
    const mainPid = Number(/^MainPID=(\d+)$/mu.exec(show)?.[1]);
    expect(mainPid).toBe(Number(runs[1]?.split("|")[0]));
    expect(mainPid).not.toBe(supervisorPid);
    expect(processIsAlive(mainPid)).toBe(true);
    expect(processIsAlive(supervisorPid)).toBe(true);

    runSystemctl(fixture, ["--user", "stop", "openclaw-gateway.service"]);
    await waitFor(
      () => !processIsAlive(mainPid) && !processIsAlive(supervisorPid),
      "stop left the supervisor or gateway alive",
    );
    expect(existsSync(fixture.childPidFile)).toBe(false);
    expect(existsSync(fixture.supervisorPidFile)).toBe(false);
    expect(existsSync(`${fixture.childPidFile}.supervisor.mjs`)).toBe(false);
  });

  it("returns from start only after a live child is visible as MainPID", () => {
    const fixture = createFixture("stay-running");
    runSystemctl(fixture, ["--user", "start", "openclaw-gateway.service"]);

    const childPid = Number(readFileSync(fixture.childPidFile, "utf8").trim());
    const show = runSystemctl(fixture, [
      "--user",
      "show",
      "--property=MainPID",
      "openclaw-gateway.service",
    ]);
    expect(show).toContain("ActiveState=active");
    expect(show).toContain(`MainPID=${childPid}`);
    expect(processIsAlive(childPid)).toBe(true);

    runSystemctl(fixture, ["--user", "stop", "openclaw-gateway.service"]);
    expect(processIsAlive(childPid)).toBe(false);
  });

  it("stops descendants in the managed gateway process group", async () => {
    const fixture = createFixture("with-descendant");
    runSystemctl(fixture, ["--user", "start", "openclaw-gateway.service"]);
    await waitFor(() => existsSync(fixture.workerPidFile), "gateway worker did not start");

    const childPid = Number(readFileSync(fixture.childPidFile, "utf8").trim());
    const workerPid = Number(readFileSync(fixture.workerPidFile, "utf8").trim());
    expect(processIsAlive(childPid)).toBe(true);
    expect(processIsAlive(workerPid)).toBe(true);

    runSystemctl(fixture, ["--user", "stop", "openclaw-gateway.service"]);
    await waitFor(
      () => !processIsAlive(childPid) && !processIsAlive(workerPid),
      "stop left the gateway or descendant worker alive",
    );
  });

  it("drains a failed leader's process group before restarting", async () => {
    const fixture = createFixture("restart-with-stubborn-descendant");
    fixture.shimEnv.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_RESTART_SEC_MS = "50";
    fixture.shimEnv.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_STOP_TIMEOUT_MS = "100";
    runSystemctl(fixture, ["--user", "start", "openclaw-gateway.service"]);

    await waitFor(() => existsSync(fixture.workerPidFile), "gateway worker did not start");
    const workerPid = Number(readFileSync(fixture.workerPidFile, "utf8").trim());
    await waitFor(
      () => readLines(fixture.gatewayRunsFile).length === 2,
      "gateway did not restart after draining its old process group",
    );

    expect(readFileSync(fixture.workerTermFile, "utf8").trim()).toBe("TERM");
    expect(processIsAlive(workerPid)).toBe(false);
    expect(existsSync(fixture.workerAliveAtRestartFile)).toBe(false);

    runSystemctl(fixture, ["--user", "stop", "openclaw-gateway.service"]);
  });

  it("returns nonzero when supervisor timing validation fails", () => {
    const fixture = createFixture("stay-running");
    fixture.shimEnv.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_RESTART_SEC_MS = "invalid";

    const result = runSystemctlResult(fixture, ["--user", "start", "openclaw-gateway.service"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_RESTART_SEC_MS must be a positive integer",
    );
    expect(existsSync(fixture.childPidFile)).toBe(false);
    expect(existsSync(fixture.supervisorPidFile)).toBe(false);
  });

  it("returns nonzero when the first child cannot initialize its unit environment", () => {
    const fixture = createFixture("stay-running");
    writeFileSync(fixture.envFile, "BROKEN='unterminated\n");

    const result = runSystemctlResult(fixture, ["--user", "start", "openclaw-gateway.service"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("gateway exited before startup initialization");
    expect(existsSync(fixture.childPidFile)).toBe(false);
    expect(existsSync(fixture.supervisorPidFile)).toBe(false);
  });

  it("stops after five starts inside the production burst interval", async () => {
    const fixture = createFixture("always-fail");
    runSystemctl(fixture, ["--user", "start", "openclaw-gateway.service"]);
    const supervisorPid = Number(readFileSync(fixture.supervisorPidFile, "utf8").trim());

    await waitFor(
      () => readLines(fixture.gatewayRunsFile).length === 5,
      "gateway did not reach the five-start limit",
    );
    await waitFor(
      () => !processIsAlive(supervisorPid),
      "supervisor process stayed alive after the start limit",
    );
    expect(existsSync(fixture.supervisorPidFile)).toBe(true);
    expect(
      runSystemctlResult(fixture, ["--user", "is-active", "openclaw-gateway.service"]).status,
    ).toBe(3);
    await delay(150);
    expect(readLines(fixture.gatewayRunsFile)).toHaveLength(5);
    expect(existsSync(fixture.childPidFile)).toBe(false);
    expect(existsSync(fixture.supervisorPidFile)).toBe(false);
    expect(existsSync(`${fixture.childPidFile}.supervisor.mjs`)).toBe(false);
  });

  it("does not restart exit status 78", async () => {
    const fixture = createFixture("exit-78");
    runSystemctl(fixture, ["--user", "start", "openclaw-gateway.service"]);
    const supervisorPid = Number(readFileSync(fixture.supervisorPidFile, "utf8").trim());

    await waitFor(() => readLines(fixture.gatewayRunsFile).length === 1, "gateway did not run");
    await waitFor(
      () => !processIsAlive(supervisorPid),
      "supervisor process stayed alive after exit 78",
    );
    expect(existsSync(fixture.supervisorPidFile)).toBe(true);
    expect(
      runSystemctlResult(fixture, ["--user", "is-active", "openclaw-gateway.service"]).status,
    ).toBe(3);
    await delay(150);
    expect(readLines(fixture.gatewayRunsFile)).toHaveLength(1);
    expect(existsSync(fixture.childPidFile)).toBe(false);
    expect(existsSync(fixture.supervisorPidFile)).toBe(false);
    expect(existsSync(`${fixture.childPidFile}.supervisor.mjs`)).toBe(false);
  });
});
