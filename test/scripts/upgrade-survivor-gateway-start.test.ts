import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const instanceHelperPath = path.resolve("scripts/lib/openclaw-e2e-instance.sh");
const gatewayStartPath = path.resolve("scripts/e2e/lib/upgrade-survivor/gateway-start.sh");
const refusal =
  "OpenClaw plugin migration inputs changed during startup convergence; refusing to report the gateway ready. Restart OpenClaw so state migrations run against the final config and plugin inventory.";
const restartMarker =
  "[upgrade-survivor] restarting direct gateway after migration convergence refusal";
const tempRoots: string[] = [];

type Attempt = {
  args: string[];
  config: unknown;
  cwd: string;
  env: Record<string, string | undefined>;
  pid: number;
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function runScenario(sequence: string, initialLog = "") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-survivor-gateway-start-"));
  tempRoots.push(root);
  const fixturePath = path.join(root, "gateway.mjs");
  const tracePath = path.join(root, "attempts.jsonl");
  const configPath = path.join(root, "openclaw.json");
  const logPath = path.join(root, "gateway.log");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir);
  fs.writeFileSync(configPath, `${JSON.stringify({ gateway: { mode: "local" } })}\n`);
  fs.writeFileSync(logPath, initialLog);
  fs.writeFileSync(
    fixturePath,
    `
import fs from "node:fs";
const tracePath = process.env.OPENCLAW_FAKE_GATEWAY_TRACE;
const countPath = tracePath + ".count";
let attempt = 1;
try { attempt = Number(fs.readFileSync(countPath, "utf8")) + 1; } catch {}
fs.writeFileSync(countPath, String(attempt));
fs.appendFileSync(tracePath, JSON.stringify({
  args: process.argv.slice(2),
  config: JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8")),
  cwd: process.cwd(),
  env: Object.fromEntries(["HOME", "OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR", "OPENCLAW_TEST_LAUNCH_ID"].map((key) => [key, process.env[key]])),
  pid: process.pid,
}) + "\\n");
const action = (process.env.OPENCLAW_FAKE_GATEWAY_SEQUENCE || "ready").split(",")[attempt - 1] || "ready";
const refusal = ${JSON.stringify(refusal)};
if (action === "refuse") { process.stderr.write(refusal + "\\n"); process.exit(1); }
if (action === "near") { process.stderr.write(refusal.replace("convergence;", "convergence:") + "\\n"); process.exit(1); }
if (action === "prefixed") { process.stderr.write("prefix " + refusal + "\\n"); process.exit(1); }
if (action === "suffixed") { process.stderr.write(refusal + " extra\\n"); process.exit(1); }
if (action === "status2") { process.stderr.write(refusal + "\\n"); process.exit(2); }
if (action === "signal") { process.stderr.write(refusal + "\\n"); process.kill(process.pid, "SIGTERM"); }
if (action === "unrelated") { process.stderr.write("unrelated startup failure\\n"); process.exit(1); }
process.stdout.write("[gateway] ready ws://127.0.0.1:23456\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
  );

  const script = `
set -u
source ${shellQuote(instanceHelperPath)}
source ${shellQuote(gatewayStartPath)}
openclaw_e2e_probe_http() { return 0; }
set +e
upgrade_survivor_start_direct_gateway \
  ${shellQuote(logPath)} \
  20 \
  23456 \
  strict \
  -- \
  env \
    HOME=${shellQuote(root)} \
    OPENCLAW_CONFIG_PATH=${shellQuote(configPath)} \
    OPENCLAW_STATE_DIR=${shellQuote(stateDir)} \
    OPENCLAW_TEST_LAUNCH_ID=stable-launch \
    OPENCLAW_FAKE_GATEWAY_TRACE=${shellQuote(tracePath)} \
    OPENCLAW_FAKE_GATEWAY_SEQUENCE=${shellQuote(sequence)} \
    ${shellQuote(process.execPath)} \
    ${shellQuote(fixturePath)} \
    gateway \
    --port \
    23456 \
    "argument with spaces"
status="$?"
set -e
printf 'result=%s pid=%s\\n' "$status" "\${gateway_pid:-}"
if [ "$status" -eq 0 ]; then
  openclaw_e2e_stop_process "$gateway_pid"
fi
`;
  const result = spawnSync("/bin/bash", ["-c", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
  const attempts = fs.existsSync(tracePath)
    ? fs
        .readFileSync(tracePath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Attempt)
    : [];
  return {
    attempts,
    log: fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "",
    result,
  };
}

describe("upgrade survivor direct gateway convergence", () => {
  it("retries one exact refusal with identical launch state and retains the ready PID", () => {
    const { attempts, log, result } = runScenario("refuse,ready");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`result=0 pid=${attempts[1]?.pid}`);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.pid).not.toBe(attempts[1]?.pid);
    expect({ ...attempts[0], pid: 0 }).toEqual({ ...attempts[1], pid: 0 });
    expect(log).toContain(refusal);
    expect(log).toContain(restartMarker);
  });

  it.each(["near", "prefixed", "suffixed", "status2", "signal", "unrelated"])(
    "keeps %s refusal lookalikes terminal",
    (action) => {
      const { attempts, log, result } = runScenario(`${action},ready`);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("result=1 pid=");
      expect(attempts).toHaveLength(1);
      expect(log).not.toContain(restartMarker);
    },
  );

  it("does not reuse the first attempt refusal for a later unrelated exit", () => {
    const { attempts, log, result } = runScenario("refuse,unrelated,ready");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("result=1 pid=");
    expect(attempts).toHaveLength(2);
    expect(log.split(restartMarker)).toHaveLength(2);
  });

  it("ignores an exact refusal left in the log before the current launch", () => {
    const { attempts, log, result } = runScenario("unrelated,ready", `${refusal}\n`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("result=1 pid=");
    expect(attempts).toHaveLength(1);
    expect(log).not.toContain(refusal);
    expect(log).not.toContain(restartMarker);
  });

  it("fails a second exact refusal without spawning a third gateway", () => {
    const { attempts, log, result } = runScenario("refuse,refuse,ready");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("result=1 pid=");
    expect(attempts).toHaveLength(2);
    expect(log.split(restartMarker)).toHaveLength(2);
    expect(
      log.match(/OpenClaw plugin migration inputs changed during startup convergence;/gu),
    ).toHaveLength(2);
  });
});
