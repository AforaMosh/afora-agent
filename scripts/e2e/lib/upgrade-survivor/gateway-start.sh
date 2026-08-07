#!/usr/bin/env bash

UPGRADE_SURVIVOR_GATEWAY_MIGRATION_REFUSAL="OpenClaw plugin migration inputs changed during startup convergence; refusing to report the gateway ready. Restart OpenClaw so state migrations run against the final config and plugin inventory."
UPGRADE_SURVIVOR_GATEWAY_MIGRATION_RESTART_MARKER="[upgrade-survivor] restarting direct gateway after migration convergence refusal"

upgrade_survivor_attempt_log_has_migration_refusal() {
  local log_path="$1"
  local launch_offset="$2"
  local refusal="$UPGRADE_SURVIVOR_GATEWAY_MIGRATION_REFUSAL"
  tail -c +"$((launch_offset + 1))" "$log_path" 2>/dev/null |
    awk -v refusal="$refusal" '$0 == refusal { found = 1 } END { exit found ? 0 : 1 }'
}

# Reuse the exact launch command and retry only the convergence refusal emitted
# by this attempt. The ready child PID remains the caller-owned gateway PID.
upgrade_survivor_start_direct_gateway() {
  local log_path="$1"
  local attempts="$2"
  local port="$3"
  local readiness_mode="${4:-strict}"
  shift 4
  if [ "${1:-}" = "--" ]; then
    shift
  fi
  if [ "$#" -eq 0 ]; then
    echo "missing direct gateway launch command" >&2
    return 2
  fi

  : >"$log_path"
  local attempt
  for attempt in 1 2; do
    local launch_offset
    launch_offset="$(wc -c <"$log_path")"
    launch_offset="${launch_offset//[[:space:]]/}"
    if command -v setsid >/dev/null 2>&1; then
      setsid "$@" >>"$log_path" 2>&1 &
    else
      "$@" >>"$log_path" 2>&1 &
    fi
    gateway_pid="$!"
    OPENCLAW_E2E_GATEWAY_PID="$gateway_pid"

    if openclaw_e2e_wait_gateway_ready \
      "$gateway_pid" \
      "$log_path" \
      "$attempts" \
      "$port" \
      "$readiness_mode" \
      "$launch_offset"; then
      return 0
    fi

    if [ "$attempt" -eq 1 ] &&
      [ "${OPENCLAW_E2E_GATEWAY_EXIT_STATUS:-}" = "1" ] &&
      upgrade_survivor_attempt_log_has_migration_refusal "$log_path" "$launch_offset"; then
      printf '%s\n' "$UPGRADE_SURVIVOR_GATEWAY_MIGRATION_RESTART_MARKER" >>"$log_path"
      continue
    fi
    return 1
  done
}
