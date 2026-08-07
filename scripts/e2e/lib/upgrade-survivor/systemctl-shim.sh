#!/usr/bin/env bash

install_update_restart_systemctl_shim() {
  local shim_dir="$npm_config_prefix/bin"
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG="${OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG:-${SYSTEMCTL_SHIM_LOG:-/tmp/openclaw-systemctl-shim.log}}"
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE="${OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE:-${SYSTEMCTL_SHIM_PID_FILE:-/tmp/openclaw-systemctl-shim.pid}}"
  export OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG="${OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG:-${SYSTEMCTL_SHIM_DAEMON_LOG:-/tmp/openclaw-systemctl-shim-gateway.log}}"
  mkdir -p "$shim_dir"
  cat >"$shim_dir/systemctl" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail

log_file="${OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG:-/tmp/openclaw-systemctl-shim.log}"
pid_file="${OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE:-/tmp/openclaw-systemctl-shim.pid}"
daemon_log="${OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG:-/tmp/openclaw-systemctl-shim-gateway.log}"
supervisor_pid_file="${pid_file}.supervisor.pid"
supervisor_script="${pid_file}.supervisor.mjs"
supervisor_ready_file="${pid_file}.supervisor.ready"
supervisor_error_file="${pid_file}.supervisor.error"
child_init_file="${pid_file}.child.init"
printf '%s\n' "$*" >>"$log_file"

filtered=()
system_scope=1
property=""
for ((i = 1; i <= $#; i++)); do
  arg="${!i}"
  case "$arg" in
    --user)
      system_scope=0
      ;;
    --quiet | --no-page | --now | --value)
      ;;
    --property)
      i=$((i + 1))
      property="${!i}"
      ;;
    --property=*)
      property="${arg#--property=}"
      ;;
    *)
      filtered+=("$arg")
      ;;
  esac
done

command="${filtered[0]:-status}"

pid_is_running() {
  local pid="${1:-}"
  local process_state=""
  [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] || return 1
  kill -0 "$pid" >/dev/null 2>&1 || return 1
  if [ -r "/proc/$pid/stat" ]; then
    process_state="$(awk '{ print $3 }' "/proc/$pid/stat" 2>/dev/null || true)"
  else
    process_state="$(ps -o stat= -p "$pid" 2>/dev/null | cut -c1 || true)"
  fi
  [ "$process_state" != "Z" ]
}

process_group_is_running() {
  local pgid="${1:-}"
  local process_group=""
  local process_state=""
  local stat_file=""
  [[ "$pgid" =~ ^[0-9]+$ ]] && [ "$pgid" -gt 1 ] || return 1
  kill -0 -- "-$pgid" >/dev/null 2>&1 || return 1
  if [ -d /proc ]; then
    for stat_file in /proc/[0-9]*/stat; do
      [ -r "$stat_file" ] || continue
      read -r process_state _ process_group _ <<<"$(sed 's/^.*) //' "$stat_file" 2>/dev/null || true)"
      if [ "$process_group" = "$pgid" ] && [ "$process_state" != "Z" ] && [ "$process_state" != "X" ]; then
        return 0
      fi
    done
    return 1
  fi
}

signal_process_group() {
  local pgid="${1:-}"
  local signal="$2"
  process_group_is_running "$pgid" || return 0
  kill "-$signal" -- "-$pgid" >/dev/null 2>&1 || true
}

read_pid_file() {
  local file="$1"
  [ -s "$file" ] || return 1
  cat "$file" 2>/dev/null
}

child_is_running() {
  local pid=""
  pid="$(read_pid_file "$pid_file" || true)"
  pid_is_running "$pid"
}

supervisor_is_running() {
  local pid=""
  pid="$(read_pid_file "$supervisor_pid_file" || true)"
  pid_is_running "$pid"
}

service_is_running() {
  child_is_running
}

cleanup_stale_supervisor_state() {
  local supervisor_pid=""
  supervisor_pid="$(read_pid_file "$supervisor_pid_file" || true)"
  if [ -n "$supervisor_pid" ] && ! pid_is_running "$supervisor_pid"; then
    rm -f \
      "$supervisor_pid_file" \
      "$supervisor_script" \
      "$supervisor_ready_file" \
      "$supervisor_error_file" \
      "$child_init_file"
  fi
  if [ -s "$pid_file" ] && ! process_group_is_running "$(read_pid_file "$pid_file" || true)"; then
    rm -f "$pid_file"
  fi
}

stop_gateway() {
  local child_pid=""
  local supervisor_pid=""
  child_pid="$(read_pid_file "$pid_file" || true)"
  supervisor_pid="$(read_pid_file "$supervisor_pid_file" || true)"

  if pid_is_running "$supervisor_pid"; then
    kill "$supervisor_pid" >/dev/null 2>&1 || true
  elif process_group_is_running "$child_pid"; then
    signal_process_group "$child_pid" TERM
  fi

  for ((attempt = 0; attempt < 350; attempt++)); do
    if ! pid_is_running "$supervisor_pid" && ! process_group_is_running "$child_pid"; then
      break
    fi
    sleep 0.1
  done
  process_group_is_running "$child_pid" && signal_process_group "$child_pid" KILL
  pid_is_running "$supervisor_pid" && kill -9 "$supervisor_pid" >/dev/null 2>&1 || true
  for ((attempt = 0; attempt < 50; attempt++)); do
    if ! pid_is_running "$supervisor_pid" && ! process_group_is_running "$child_pid"; then
      break
    fi
    sleep 0.1
  done
  if pid_is_running "$supervisor_pid" || process_group_is_running "$child_pid"; then
    echo "systemctl shim could not stop gateway supervisor or process group" >&2
    return 1
  fi
  rm -f \
    "$pid_file" \
    "$supervisor_pid_file" \
    "$supervisor_script" \
    "$supervisor_ready_file" \
    "$supervisor_error_file" \
    "$child_init_file"
}

unit_path() {
  printf '%s/.config/systemd/user/openclaw-gateway.service\n' "${HOME:?missing HOME}"
}

start_gateway() {
  local unit
  local exec_start
  local supervisor_pid
  unit="$(unit_path)"
  exec_start="$(sed -n 's/^ExecStart=//p' "$unit" | tail -n 1)"
  [ -n "$exec_start" ] || {
    echo "systemctl shim could not find ExecStart in $unit" >&2
    return 1
  }

  rm -f \
    "$pid_file" \
    "$supervisor_pid_file" \
    "$supervisor_script" \
    "$supervisor_ready_file" \
    "$supervisor_error_file" \
    "$child_init_file"
  cat >"$supervisor_script" <<'SUPERVISOR'
import fs from "node:fs";
import { spawn } from "node:child_process";

const command = process.env.OPENCLAW_SYSTEMCTL_SHIM_EXEC_START;
const daemonLog = process.env.OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG;
const unitPath = process.env.OPENCLAW_SYSTEMCTL_SHIM_UNIT_PATH;
const childPidFile = process.env.OPENCLAW_SYSTEMCTL_SHIM_CHILD_PID_FILE;
const supervisorPidFile = process.env.OPENCLAW_SYSTEMCTL_SHIM_SUPERVISOR_PID_FILE;
const supervisorScript = process.env.OPENCLAW_SYSTEMCTL_SHIM_SUPERVISOR_SCRIPT;
const supervisorReadyFile = process.env.OPENCLAW_SYSTEMCTL_SHIM_SUPERVISOR_READY_FILE;
const supervisorErrorFile = process.env.OPENCLAW_SYSTEMCTL_SHIM_SUPERVISOR_ERROR_FILE;
const childInitFile = process.env.OPENCLAW_SYSTEMCTL_SHIM_CHILD_INIT_FILE;
if (
  !command ||
  !daemonLog ||
  !unitPath ||
  !childPidFile ||
  !supervisorPidFile ||
  !supervisorReadyFile ||
  !supervisorErrorFile ||
  !childInitFile
) {
  process.exit(2);
}
fs.writeFileSync(supervisorPidFile, `${process.pid}\n`);

const readPositiveInt = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

let restartDelayMs;
let startLimitBurst;
let startLimitIntervalMs;
let stopTimeoutMs;
let output;
let inheritedEnv;
try {
  restartDelayMs = readPositiveInt(
    "OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_RESTART_SEC_MS",
    5_000,
  );
  startLimitBurst = readPositiveInt(
    "OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_START_LIMIT_BURST",
    5,
  );
  startLimitIntervalMs = readPositiveInt(
    "OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_START_LIMIT_INTERVAL_MS",
    60_000,
  );
  stopTimeoutMs = readPositiveInt(
    "OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_STOP_TIMEOUT_MS",
    30_000,
  );
  output = fs.openSync(daemonLog, "a");
  inheritedEnv = { ...process.env };
  for (const key of Object.keys(inheritedEnv)) {
    if (
      key.startsWith("OPENCLAW_UPDATE_") ||
      key.startsWith("OPENCLAW_SYSTEMCTL_SHIM_") ||
      key.startsWith("OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_")
    ) {
      delete inheritedEnv[key];
    }
  }
  delete inheritedEnv.OPENCLAW_COMPATIBILITY_HOST_VERSION;
} catch (error) {
  fs.writeFileSync(supervisorErrorFile, `${String(error)}\n`);
  process.exit(1);
}

const childLoader = `
set -euo pipefail
unit="$1"
exec_start="$2"
child_init_file="$3"
while IFS= read -r line; do
  case "$line" in
    EnvironmentFile=*)
      spec="\${line#EnvironmentFile=}"
      for token in $spec; do
        file="\${token#-}"
        file="\${file#\\\"}"
        file="\${file%\\\"}"
        [ -f "$file" ] || continue
        set -a
        . "$file"
        set +a
      done
      ;;
    Environment=*)
      assignment="\${line#Environment=}"
      assignment="\${assignment#\\\"}"
      assignment="\${assignment%\\\"}"
      export "$assignment"
      ;;
  esac
done <"$unit"
printf '%s\\n' "$$" >"$child_init_file"
exec bash -lc "exec $exec_start"
`;

let child;
let finished = false;
let startupFailure = "";
let startupPoll;
let startupReady = false;
let stopping = false;
let stopTimer;
let forceDrainTimer;
let groupPoll;
let terminatingPgid;
const startTimes = [];

const removeChildState = () => {
  try {
    fs.rmSync(childPidFile, { force: true });
  } catch {}
};

const finish = (status = 0, options = {}) => {
  if (finished) return;
  finished = true;
  if (stopTimer) clearTimeout(stopTimer);
  if (forceDrainTimer) clearTimeout(forceDrainTimer);
  if (groupPoll) clearInterval(groupPoll);
  if (startupPoll) clearInterval(startupPoll);
  if (!options.preserveChildState) removeChildState();
  try {
    if (output !== undefined) fs.closeSync(output);
  } catch {}
  process.exit(status);
};

const processGroupIsRunning = (pgid) => {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
  if (process.platform !== "linux") return true;
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^[0-9]+$/u.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/u);
      const state = fields[0];
      const processGroup = Number(fields[2]);
      if (processGroup === pgid && state !== "Z" && state !== "X") return true;
    } catch {}
  }
  return false;
};

const signalProcessGroup = (pgid, signal) => {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
};

const terminateProcessGroup = (pgid, callback) => {
  if (!processGroupIsRunning(pgid)) return callback();
  if (terminatingPgid === pgid) return;
  if (terminatingPgid !== undefined) {
    throw new Error(`already terminating process group ${terminatingPgid}`);
  }
  terminatingPgid = pgid;
  const complete = (error) => {
    if (groupPoll) clearInterval(groupPoll);
    if (stopTimer) clearTimeout(stopTimer);
    if (forceDrainTimer) clearTimeout(forceDrainTimer);
    groupPoll = undefined;
    stopTimer = undefined;
    forceDrainTimer = undefined;
    terminatingPgid = undefined;
    if (!error) child = undefined;
    callback(error);
  };
  signalProcessGroup(pgid, "SIGTERM");
  groupPoll = setInterval(() => {
    if (!processGroupIsRunning(pgid)) complete();
  }, 10);
  stopTimer = setTimeout(() => {
    signalProcessGroup(pgid, "SIGKILL");
    forceDrainTimer = setTimeout(() => {
      if (!processGroupIsRunning(pgid)) return complete();
      complete(new Error(`process group ${pgid} remained active after SIGKILL`));
    }, Math.min(stopTimeoutMs, 5_000));
    forceDrainTimer.unref();
  }, stopTimeoutMs);
  stopTimer.unref();
};

const failStartup = (error) => {
  if (startupFailure || startupReady || finished) return;
  startupFailure = String(error);
  fs.writeFileSync(supervisorErrorFile, `${startupFailure}\n`);
  if (output !== undefined) {
    fs.writeSync(output, `[systemctl-shim] startup failed: ${startupFailure}\n`);
  }
  stopping = true;
  if (!child) return finish(1);
  terminateProcessGroup(child.pid, (error) =>
    finish(1, { preserveChildState: error !== undefined }),
  );
};

const stop = () => {
  if (stopping || finished) return;
  stopping = true;
  if (!child) return finish();
  terminateProcessGroup(child.pid, (error) => {
    if (error) fs.writeSync(output, `[systemctl-shim] ${String(error)}\n`);
    finish(error ? 1 : 0, { preserveChildState: error !== undefined });
  });
};

const start = () => {
  if (stopping || finished) return finish();
  const now = Date.now();
  while (startTimes.length > 0 && now - startTimes[0] >= startLimitIntervalMs) {
    startTimes.shift();
  }
  if (startTimes.length >= startLimitBurst) {
    fs.writeSync(
      output,
      `[systemctl-shim] start limit hit: ${startLimitBurst} starts in ${startLimitIntervalMs}ms\n`,
    );
    return finish(1);
  }
  startTimes.push(now);
  fs.rmSync(childInitFile, { force: true });
  child = spawn(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      childLoader,
      "systemctl-shim-child",
      unitPath,
      command,
      childInitFile,
    ],
    {
      detached: true,
      env: inheritedEnv,
      stdio: ["ignore", output, output],
    },
  );
  child.once("spawn", () => {
    fs.writeFileSync(childPidFile, `${child.pid}\n`);
    if (startupReady) return;
    startupPoll = setInterval(() => {
      let initializedPid = "";
      try {
        initializedPid = fs.readFileSync(childInitFile, "utf8").trim();
      } catch {
        return;
      }
      if (initializedPid !== String(child?.pid) || child?.exitCode !== null) return;
      startupReady = true;
      clearInterval(startupPoll);
      startupPoll = undefined;
      fs.writeFileSync(supervisorReadyFile, `${initializedPid}\n`);
    }, 5);
  });
  child.on("error", (error) => {
    fs.writeSync(output, `[systemctl-shim] gateway spawn failed: ${String(error)}\n`);
    if (!startupReady) failStartup(error);
  });
  child.once("close", (code) => {
    const pgid = child?.pid;
    if (startupPoll) {
      clearInterval(startupPoll);
      startupPoll = undefined;
    }
    try {
      fs.rmSync(childPidFile, { force: true });
      fs.rmSync(childInitFile, { force: true });
    } catch {}
    if (terminatingPgid === pgid) return;
    child = undefined;
    if (stopping) return finish(startupFailure ? 1 : 0);
    if (!startupReady) {
      return failStartup(`gateway exited before startup initialization (code ${code ?? "signal"})`);
    }
    terminateProcessGroup(pgid, (error) => {
      if (error) {
        fs.writeSync(output, `[systemctl-shim] ${String(error)}\n`);
        return finish(1, { preserveChildState: true });
      }
      if (code === 78) return finish();
      setTimeout(start, restartDelayMs);
    });
  });
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);
start();
SUPERVISOR

  OPENCLAW_SYSTEMCTL_SHIM_EXEC_START="$exec_start" \
    OPENCLAW_SYSTEMCTL_SHIM_DAEMON_LOG="$daemon_log" \
    OPENCLAW_SYSTEMCTL_SHIM_UNIT_PATH="$unit" \
    OPENCLAW_SYSTEMCTL_SHIM_CHILD_PID_FILE="$pid_file" \
    OPENCLAW_SYSTEMCTL_SHIM_SUPERVISOR_PID_FILE="$supervisor_pid_file" \
    OPENCLAW_SYSTEMCTL_SHIM_SUPERVISOR_SCRIPT="$supervisor_script" \
    OPENCLAW_SYSTEMCTL_SHIM_SUPERVISOR_READY_FILE="$supervisor_ready_file" \
    OPENCLAW_SYSTEMCTL_SHIM_SUPERVISOR_ERROR_FILE="$supervisor_error_file" \
    OPENCLAW_SYSTEMCTL_SHIM_CHILD_INIT_FILE="$child_init_file" \
    nohup node "$supervisor_script" </dev/null >/dev/null 2>&1 &
  supervisor_pid="$!"
  for ((attempt = 0; attempt < 1000; attempt++)); do
    if [ -s "$supervisor_pid_file" ]; then
      if [ "$(cat "$supervisor_pid_file")" != "$supervisor_pid" ]; then
        stop_gateway || true
        echo "systemctl shim supervisor published an unexpected PID" >&2
        return 1
      fi
    fi
    if [ -s "$supervisor_error_file" ]; then
      local startup_error
      startup_error="$(cat "$supervisor_error_file")"
      for ((exit_attempt = 0; exit_attempt < 500; exit_attempt++)); do
        pid_is_running "$supervisor_pid" || break
        sleep 0.01
      done
      if pid_is_running "$supervisor_pid"; then
        stop_gateway || true
      else
        cleanup_stale_supervisor_state
      fi
      echo "systemctl shim supervisor startup failed: $startup_error" >&2
      return 1
    fi
    if [ -s "$supervisor_ready_file" ]; then
      local child_pid
      child_pid="$(cat "$supervisor_ready_file")"
      if [ "$child_pid" = "$(read_pid_file "$pid_file" || true)" ] && pid_is_running "$child_pid"; then
        rm -f "$supervisor_ready_file" "$supervisor_error_file" "$child_init_file"
        return 0
      fi
    fi
    if ! pid_is_running "$supervisor_pid"; then
      local supervisor_status=0
      wait "$supervisor_pid" || supervisor_status=$?
      cleanup_stale_supervisor_state
      echo "systemctl shim supervisor exited before startup completed (status $supervisor_status)" >&2
      return 1
    fi
    sleep 0.01
  done
  stop_gateway || true
  echo "systemctl shim supervisor did not complete startup" >&2
  return 1
}

cleanup_stale_supervisor_state

case "$command" in
  daemon-reload | enable | disable)
    exit 0
    ;;
  status)
    service_is_running && exit 0
    exit 0
    ;;
  stop)
    stop_gateway
    exit 0
    ;;
  restart | start)
    stop_gateway
    start_gateway
    exit 0
    ;;
  is-enabled)
    exit 0
    ;;
  is-active)
    service_is_running && exit 0
    exit 3
    ;;
  show)
    if [ "$system_scope" = "1" ]; then
      case "$property" in
        LoadState)
          printf 'not-found\n'
          ;;
        UnitPath)
          printf '/etc/systemd/system /usr/lib/systemd/system\n'
          ;;
        *)
          echo "systemctl shim unsupported system-scope show: $*" >&2
          exit 1
          ;;
      esac
      exit 0
    fi
    if service_is_running; then
      main_pid=0
      child_is_running && main_pid="$(cat "$pid_file")"
      printf 'ActiveState=active\nSubState=running\nMainPID=%s\nExecMainStatus=0\nExecMainCode=0\n' "$main_pid"
    else
      printf 'ActiveState=inactive\nSubState=dead\nMainPID=0\nExecMainStatus=0\nExecMainCode=0\n'
    fi
    exit 0
    ;;
  *)
    echo "systemctl shim unsupported command: $*" >&2
    exit 1
    ;;
esac
SHIM
  chmod +x "$shim_dir/systemctl"
  export PATH="$shim_dir:$PATH"
}
