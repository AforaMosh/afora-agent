#!/usr/bin/env bash
set -euo pipefail

cd /repo

export AFORA_STATE_DIR="/tmp/afora-test"
export AFORA_CONFIG_PATH="${AFORA_STATE_DIR}/afora.json"

read_positive_int_env() {
  local name="${1:?missing environment variable name}"
  local fallback="${2:?missing fallback value}"
  local value="${!name-}"
  if [ -z "${!name+x}" ]; then
    value="$fallback"
  fi
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( 10#$value < 1 )); then
    echo "invalid $name: $value" >&2
    return 2
  fi
  printf '%s\n' "$((10#$value))"
}

print_log_tail() {
  local log_file="$1"
  local max_bytes
  max_bytes="$(read_positive_int_env AFORA_CLEANUP_SMOKE_LOG_PRINT_BYTES 65536)" || return $?
  if [ ! -f "$log_file" ]; then
    return 0
  fi
  local log_bytes
  log_bytes="$(wc -c <"$log_file" 2>/dev/null || echo 0)"
  log_bytes="${log_bytes//[[:space:]]/}"
  if ! [[ "$log_bytes" =~ ^[0-9]+$ ]]; then
    log_bytes="0"
  fi
  if [ "$log_bytes" -le "$max_bytes" ]; then
    cat "$log_file"
    return 0
  fi
  echo "--- ${log_file} truncated: showing last ${max_bytes} of ${log_bytes} bytes ---"
  tail -c "$max_bytes" "$log_file"
}

read_positive_int_env AFORA_CLEANUP_SMOKE_LOG_PRINT_BYTES 65536 >/dev/null

ensure_cleanup_smoke_node_options() {
  local current="${NODE_OPTIONS:-}"
  case " $current " in
    *" --max-old-space-size="* | *" --max-old-space-size "* | *" --max_old_space_size="* | *" --max_old_space_size "*)
      ;;
    *)
      current="${current:+$current }--max-old-space-size=8192"
      ;;
  esac
  export NODE_OPTIONS="$current"
}
ensure_cleanup_smoke_node_options

echo "==> Build"
if ! pnpm build >/tmp/afora-cleanup-build.log 2>&1; then
  print_log_tail /tmp/afora-cleanup-build.log
  exit 1
fi

echo "==> Seed state"
mkdir -p "${AFORA_STATE_DIR}/credentials"
mkdir -p "${AFORA_STATE_DIR}/agents/main/sessions"
echo '{}' >"${AFORA_CONFIG_PATH}"
echo 'creds' >"${AFORA_STATE_DIR}/credentials/marker.txt"
echo 'session' >"${AFORA_STATE_DIR}/agents/main/sessions/sessions.json"

echo "==> Reset (config+creds+sessions)"
if ! pnpm afora reset --scope config+creds+sessions --yes --non-interactive >/tmp/afora-cleanup-reset.log 2>&1; then
  print_log_tail /tmp/afora-cleanup-reset.log
  exit 1
fi

test ! -f "${AFORA_CONFIG_PATH}"
test ! -d "${AFORA_STATE_DIR}/credentials"
test ! -d "${AFORA_STATE_DIR}/agents/main/sessions"

echo "==> Recreate minimal config"
mkdir -p "${AFORA_STATE_DIR}/credentials"
echo '{}' >"${AFORA_CONFIG_PATH}"

echo "==> Uninstall (state only)"
if ! pnpm afora uninstall --state --yes --non-interactive >/tmp/afora-cleanup-uninstall.log 2>&1; then
  print_log_tail /tmp/afora-cleanup-uninstall.log
  exit 1
fi

test ! -d "${AFORA_STATE_DIR}"

echo "OK"
