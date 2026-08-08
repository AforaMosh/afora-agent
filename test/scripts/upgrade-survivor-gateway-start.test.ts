import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const gatewayHelper = path.resolve("scripts/e2e/lib/upgrade-survivor/gateway-start.sh");
const refusalPrefix = "OpenClaw plugin migration inputs changed during startup convergence;";
const retryMarker = "[upgrade-survivor] retrying gateway startup after convergence input change";

function quote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

type ScenarioOptions = {
  initialLog?: string;
  initialOwnership?: string;
  initialPid?: string;
  platform?: "Darwin" | "Linux";
  readinessStatus?: number;
  setsidAvailable?: boolean;
  deadlineOffset?: number;
  expireAfterWait?: boolean;
};

function runScenario(sequence: string, options: ScenarioOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-gateway-"));
  const executable = path.join(root, "openclaw");
  const log = path.join(root, "gateway.log");
  const count = path.join(root, "count");
  const trace = path.join(root, "trace");
  fs.writeFileSync(log, options.initialLog ?? "");
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env bash
set -euo pipefail
attempt=0
[ ! -f "$FAKE_COUNT" ] || attempt="$(cat "$FAKE_COUNT")"
attempt=$((attempt + 1))
printf '%s\n' "$attempt" >"$FAKE_COUNT"
printf 'pid=%s argc=%s\n' "$$" "$#" >>"$FAKE_TRACE"
printf 'arg=%s\n' "$@" >>"$FAKE_TRACE"
printf '%s\n' --- >>"$FAKE_TRACE"
IFS=, read -r -a steps <<<"$FAKE_SEQUENCE"
case "\${steps[$((attempt - 1))]:-missing}" in
  success)
    printf '[gateway] ready ws://127.0.0.1:24567\n' >&2
    exec sleep 30
    ;;
  refusal) printf '%s arbitrary suffix\n' ${quote(refusalPrefix)} >&2; exit 1 ;;
  refusal2) printf '%s arbitrary suffix\n' ${quote(refusalPrefix)} >&2; exit 2 ;;
  signal) kill -TERM "$$" ;;
  near) printf 'x%s arbitrary suffix\n' ${quote(refusalPrefix)} >&2; exit 1 ;;
  stdout) printf '%s arbitrary suffix\n' ${quote(refusalPrefix)}; exit 1 ;;
  unrelated) printf 'unrelated startup failure\n' >&2; exit 1 ;;
  stale) exit 1 ;;
  *) exit 64 ;;
esac
`,
    { mode: 0o755 },
  );

  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      `
set -uo pipefail
source ${quote(gatewayHelper)}
uname() { printf '%s\n' ${quote(options.platform ?? "Linux")}; }
${
  options.setsidAvailable === false
    ? `setsid_probe_dir=${quote(path.join(root, "no-setsid"))}
mkdir -p "$setsid_probe_dir"
PATH="$setsid_probe_dir"`
    : `setsid() { exec "$@"; }`
}
openclaw_e2e_stop_process() {
  pkill -TERM -P "$1" >/dev/null 2>&1 || true
  kill -TERM "$1" >/dev/null 2>&1 || true
  wait "$1" >/dev/null 2>&1 || true
}
openclaw_e2e_wait_gateway_ready() {
  local leader="$1" log_file="$2" child_var="$6" deadline="$7" offset="$8"
  ${
    options.readinessStatus === undefined
      ? `local i status
  for i in {1..80}; do
    if tail -c "+$((offset + 1))" "$log_file" 2>/dev/null | grep -qF '[gateway] ready '; then
      return 0
    fi
    if ! kill -0 "$leader" >/dev/null 2>&1; then
      wait "$leader"; status=$?
      printf -v "$child_var" '%s' "$status"
      ${options.expireAfterWait ? `SECONDS="$deadline"` : ""}
      return 1
    fi
    sleep 0.01
  done
  return 1`
      : `printf -v "$child_var" '%s' ""
  return ${options.readinessStatus}`
  }
}
gateway_pid=${quote(options.initialPid ?? "")}
gateway_ownership=${quote(options.initialOwnership ?? "")}
export FAKE_COUNT=${quote(count)} FAKE_TRACE=${quote(trace)} FAKE_SEQUENCE=${quote(sequence)}
upgrade_survivor_start_gateway_with_convergence_retry \
  gateway_pid ${quote(log)} 8 24567 legacy-ready-log-ok "$((SECONDS+${options.deadlineOffset ?? 5}))" \
  gateway_ownership -- ${quote(executable)} args
status=$?
printf 'gateway_pid=%s\n' "$gateway_pid"
printf 'gateway_ownership=%s\n' "$gateway_ownership"
if [ "$status" -eq 0 ] && [ -n "$gateway_pid" ]; then
  openclaw_e2e_stop_process "$gateway_pid"
fi
exit "$status"
`,
    ],
    { encoding: "utf8" },
  );
  const traceText = fs.existsSync(trace) ? fs.readFileSync(trace, "utf8") : "";
  const logText = fs.readFileSync(log, "utf8");
  fs.rmSync(root, { force: true, recursive: true });
  return { result, traceText, logText };
}

function launches(traceText: string): string[] {
  return traceText.split("---\n").filter(Boolean);
}

describe("upgrade survivor gateway convergence launcher", () => {
  it.each([
    ["Darwin", { platform: "Darwin" as const }],
    ["missing setsid", { setsidAvailable: false }],
  ])("fails closed on %s without changing the preexisting pid or log", (_label, options) => {
    const { result, traceText, logText } = runScenario("success", {
      ...options,
      initialLog: "keep-log\n",
      initialOwnership: "keep-ownership",
      initialPid: "keep-pid",
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("gateway_pid=keep-pid");
    expect(result.stdout).toContain("gateway_ownership=keep-ownership");
    expect(logText).toBe("keep-log\n");
    expect(traceText).toBe("");
  });

  it("returns the waitable leader pid rather than the executable pid", () => {
    const { result, traceText } = runScenario("success");
    const launch = launches(traceText)[0];
    const returnedPid = result.stdout.match(/gateway_pid=(\d+)/u)?.[1];
    const executablePid = launch?.match(/pid=(\d+)/u)?.[1];

    expect(result.status, result.stderr).toBe(0);
    expect(launches(traceText)).toHaveLength(1);
    expect(returnedPid).toMatch(/^\d+$/u);
    expect(executablePid).toMatch(/^\d+$/u);
    expect(returnedPid).not.toBe(executablePid);
    expect(result.stdout).toContain("gateway_ownership=process-group");
  });

  it("retries one exact-prefix stderr refusal with an arbitrary suffix", () => {
    const { result, traceText, logText } = runScenario("refusal,success");

    expect(result.status, result.stderr).toBe(0);
    expect(launches(traceText)).toHaveLength(2);
    expect(logText.split(retryMarker).length - 1).toBe(1);
  });

  it("caps two refusals at two launches", () => {
    const { result, traceText, logText } = runScenario("refusal,refusal");

    expect(result.status).toBe(1);
    expect(launches(traceText)).toHaveLength(2);
    expect(logText.split(retryMarker).length - 1).toBe(1);
  });

  it.each([
    ["exit 2", "refusal2", "", 1],
    ["signal", "signal", "", 1],
    ["near prefix", "near", "", 1],
    ["stdout only", "stdout", "", 1],
    ["unrelated exit 1", "unrelated", "", 1],
    ["stale refusal", "stale", `${refusalPrefix} old\n`, 1],
  ])("does not retry %s", (_label, sequence, initialLog, expectedStatus) => {
    const { result, traceText, logText } = runScenario(sequence, { initialLog });

    expect(result.status).toBe(expectedStatus);
    expect(launches(traceText)).toHaveLength(1);
    expect(logText).not.toContain(retryMarker);
  });

  it("ignores stale readiness", () => {
    const { result, traceText } = runScenario("unrelated", {
      initialLog: "[gateway] ready ws://127.0.0.1:24567\n",
    });

    expect(result.status).toBe(1);
    expect(launches(traceText)).toHaveLength(1);
  });

  it("does not launch or mark a retry after the shared deadline expires", () => {
    const { result, traceText, logText } = runScenario("success", { deadlineOffset: 0 });

    expect(result.status).toBe(1);
    expect(traceText).toBe("");
    expect(logText).not.toContain(retryMarker);
  });

  it("does not relaunch when the first refusal consumes the shared deadline", () => {
    const { result, traceText, logText } = runScenario("refusal,success", {
      expireAfterWait: true,
    });

    expect(result.status).toBe(1);
    expect(launches(traceText)).toHaveLength(1);
    expect(logText).not.toContain(retryMarker);
  });

  it("does not retry readiness status 2", () => {
    const { result, traceText, logText } = runScenario("refusal", { readinessStatus: 2 });

    expect(result.status).toBe(2);
    expect(launches(traceText)).toHaveLength(1);
    expect(logText).not.toContain(retryMarker);
  });

  it.runIf(process.platform === "linux")(
    "kills and reaps a TERM-resistant descendant after failure",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-setsid-"));
      const executable = path.join(root, "openclaw");
      const log = path.join(root, "gateway.log");
      const descendant = path.join(root, "descendant.pid");
      fs.writeFileSync(
        executable,
        `#!/usr/bin/env bash
( trap '' TERM; printf '%s\n' "$BASHPID" >${quote(descendant)}; while :; do sleep 1; done ) &
exit 1
`,
        { mode: 0o755 },
      );

      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          `
source ${quote(gatewayHelper)}
openclaw_e2e_wait_gateway_ready() {
  local leader="$1" child_var="$6"
  wait "$leader"
  printf -v "$child_var" '%s' "$?"
  return 1
}
openclaw_e2e_stop_process() {
  kill -TERM -- "-$1" >/dev/null 2>&1 || true
  sleep 0.05
  kill -KILL -- "-$1" >/dev/null 2>&1 || true
  wait "$1" >/dev/null 2>&1 || true
}
gateway_pid=""
upgrade_survivor_start_gateway_with_convergence_retry \
  gateway_pid ${quote(log)} 8 24567 legacy-ready-log-ok "$((SECONDS+5))" \
  -- ${quote(executable)} args
status=$?
pid="$(cat ${quote(descendant)})"
for _ in {1..100}; do
  [ ! -e "/proc/$pid" ] && exit "$status"
  sleep 0.01
done
exit 99
`,
        ],
        { encoding: "utf8", timeout: 5_000 },
      );
      fs.rmSync(root, { force: true, recursive: true });

      expect(result.status, result.stderr).toBe(1);
    },
  );
});
