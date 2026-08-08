#!/usr/bin/env bash

upgrade_survivor_start_gateway_with_convergence_retry() {
  if [ "$#" -lt 8 ]; then
    return 2
  fi

  local output_var="$1"
  local log_file="$2"
  local readiness_attempts="$3"
  local port="$4"
  local readiness_mode="$5"
  local absolute_deadline="$6"
  shift 6
  if [ "$1" != "--" ]; then
    return 2
  fi
  shift

  if ! [[ "$output_var" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
    [ -z "$log_file" ] ||
    ! [[ "$readiness_attempts" =~ ^[0-9]+$ ]] ||
    [ "$readiness_attempts" -lt 1 ] ||
    { [ -n "$port" ] && { ! [[ "$port" =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ]; }; } ||
    ! [[ "$absolute_deadline" =~ ^[0-9]+$ ]] ||
    { [ "$readiness_mode" != "strict" ] && [ "$readiness_mode" != "legacy-ready-log-ok" ]; } ||
    [ "$#" -eq 0 ] ||
    [ "$(uname -s)" != "Linux" ] ||
    ! command -v setsid >/dev/null 2>&1; then
    return 2
  fi

  printf -v "$output_var" '%s' ""
  local launch_attempt leader child_status offset stderr_file wait_status
  local retry_prefix="OpenClaw plugin migration inputs changed during startup convergence;"

  for ((launch_attempt = 1; launch_attempt <= 2; launch_attempt++)); do
    if [ "$SECONDS" -ge "$absolute_deadline" ]; then
      return 1
    fi

    offset=0
    if [ -f "$log_file" ]; then
      offset="$(wc -c <"$log_file")" || return 1
      offset="${offset//[[:space:]]/}"
      [[ "$offset" =~ ^[0-9]+$ ]] || return 1
    fi
    stderr_file="$(mktemp "${TMPDIR:-/tmp}/openclaw-upgrade-survivor-stderr.XXXXXX")" || return 1

    if [ "$launch_attempt" -eq 2 ]; then
      if [ "$SECONDS" -ge "$absolute_deadline" ]; then
        rm -f "$stderr_file"
        return 1
      fi
      printf '%s\n' "[upgrade-survivor] retrying gateway startup after convergence input change" |
        tee -a "$log_file"
    fi
    setsid bash -c '
      log="$1"
      stderr_capture="$2"
      shift 2
      "$@" >>"$log" 2> >(tee -a "$log" >"$stderr_capture")
      status=$?
      wait
      exit "$status"
    ' bash "$log_file" "$stderr_file" "$@" &
    leader="$!"
    child_status=""
    wait_status=0
    openclaw_e2e_wait_gateway_ready \
      "$leader" "$log_file" "$readiness_attempts" "$port" "$readiness_mode" \
      child_status "$absolute_deadline" "$offset" || wait_status="$?"
    if [ "$wait_status" -eq 0 ]; then
      rm -f "$stderr_file"
      printf -v "$output_var" '%s' "$leader"
      return 0
    fi

    openclaw_e2e_stop_process "$leader"

    if [ "$launch_attempt" -eq 1 ] &&
      [ "$wait_status" -eq 1 ] &&
      [ "$child_status" = "1" ] &&
      [ "$SECONDS" -lt "$absolute_deadline" ] &&
      awk -v prefix="$retry_prefix" 'index($0, prefix) == 1 { found = 1; exit } END { exit !found }' "$stderr_file"; then
      rm -f "$stderr_file"
      continue
    fi

    rm -f "$stderr_file"
    return "$wait_status"
  done

  return 1
}
