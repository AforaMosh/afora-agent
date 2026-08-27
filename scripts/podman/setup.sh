#!/usr/bin/env bash
# One-time host setup for rootless Afora in Podman. Uses the current
# non-root user throughout, builds or pulls the image into that user's Podman
# store, writes config under ~/.afora by default, and uses the repo-local
# launch script at ./scripts/run-afora-podman.sh.
#
# Usage: ./scripts/podman/setup.sh [--quadlet|--container]
#   --quadlet   Install a Podman Quadlet as the current user's systemd service
#   --container Only install image + config; you start the container manually (default)
#   Or set AFORA_PODMAN_QUADLET=1 (or 0) to choose without a flag.
#
# After this, start the gateway manually:
#   ./scripts/run-afora-podman.sh launch
#   ./scripts/run-afora-podman.sh launch setup
# Or, if you used --quadlet:
#   systemctl --user start afora.service
set -euo pipefail

REPO_PATH="${AFORA_REPO_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
source "$REPO_PATH/scripts/lib/build-metadata.sh"
source "$REPO_PATH/scripts/lib/host-timeout.sh"
RUN_SCRIPT_SRC="$REPO_PATH/scripts/run-afora-podman.sh"
QUADLET_TEMPLATE="$REPO_PATH/scripts/podman/afora.container.in"
AFORA_USER="$(id -un)"
AFORA_HOME="${HOME:-}"
AFORA_CONFIG_DIR="${AFORA_CONFIG_DIR:-}"
AFORA_WORKSPACE_DIR="${AFORA_WORKSPACE_DIR:-}"
AFORA_IMAGE="${AFORA_PODMAN_IMAGE:-${AFORA_IMAGE:-afora:local}}"
AFORA_CONTAINER_NAME="${AFORA_PODMAN_CONTAINER:-afora}"
PLATFORM_NAME="$(uname -s 2>/dev/null || echo unknown)"
HOST_GATEWAY_PORT="${AFORA_PODMAN_GATEWAY_HOST_PORT:-${AFORA_GATEWAY_PORT:-18789}}"
QUADLET_GATEWAY_PORT="18789"
PODMAN_PULL_TIMEOUT="${AFORA_PODMAN_SETUP_PULL_TIMEOUT:-600s}"
PODMAN_BUILD_TIMEOUT="${AFORA_PODMAN_SETUP_BUILD_TIMEOUT:-1800s}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1" >&2
    exit 1
  fi
}

is_root() { [[ "$(id -u)" -eq 0 ]]; }

fail() {
  echo "$*" >&2
  exit 1
}

run_podman_pull() {
  local image="$1"
  afora_host_timeout_cmd "$PODMAN_PULL_TIMEOUT" podman pull "$image"
}

run_podman_build() {
  afora_host_timeout_cmd "$PODMAN_BUILD_TIMEOUT" podman build "$@"
}

validate_single_line_value() {
  local label="$1"
  local value="$2"
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    fail "Invalid $label: control characters are not allowed."
  fi
}

validate_absolute_path() {
  local label="$1"
  local value="$2"
  validate_single_line_value "$label" "$value"
  [[ "$value" == /* ]] || fail "Invalid $label: expected an absolute path."
  [[ "$value" != *"//"* ]] || fail "Invalid $label: repeated slashes are not allowed."
  [[ "$value" != *"/./"* && "$value" != */. && "$value" != *"/../"* && "$value" != */.. ]] ||
    fail "Invalid $label: dot path segments are not allowed."
}

validate_mount_source_path() {
  local label="$1"
  local value="$2"
  validate_absolute_path "$label" "$value"
  [[ "$value" != *:* ]] || fail "Invalid $label: ':' is not allowed in Podman bind-mount source paths."
}

validate_container_name() {
  local value="$1"
  validate_single_line_value "container name" "$value"
  [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] ||
    fail "Invalid container name: $value"
}

validate_image_name() {
  local value="$1"
  validate_single_line_value "image name" "$value"
  case "$value" in
    oci-archive:*|docker-archive:*|dir:*|oci:*|containers-storage:*|docker-daemon:*|archive:* )
      fail "Invalid image name: transport prefixes are not allowed: $value"
      ;;
  esac
  [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] ||
    fail "Invalid image name: $value"
}

ensure_safe_existing_dir() {
  local label="$1"
  local dir="$2"
  validate_absolute_path "$label" "$dir"
  [[ -d "$dir" ]] || fail "Missing $label: $dir"
  [[ ! -L "$dir" ]] || fail "Unsafe $label: symlinks are not allowed ($dir)"
}

stat_uid() {
  local path="$1"
  if stat -f '%u' "$path" >/dev/null 2>&1; then
    stat -f '%u' "$path"
  else
    stat -Lc '%u' "$path"
  fi
}

stat_mode() {
  local path="$1"
  if stat -f '%Lp' "$path" >/dev/null 2>&1; then
    stat -f '%Lp' "$path"
  else
    stat -Lc '%a' "$path"
  fi
}

ensure_private_existing_dir_owned_by_user() {
  local label="$1"
  local dir="$2"
  local uid=""
  local mode=""
  ensure_safe_existing_dir "$label" "$dir"
  uid="$(stat_uid "$dir")"
  [[ "$uid" == "$(id -u)" ]] || fail "Unsafe $label: not owned by current user ($dir)"
  mode="$(stat_mode "$dir")"
  (( (8#$mode & 0022) == 0 )) || fail "Unsafe $label: group/other writable ($dir)"
}

ensure_safe_write_file_path() {
  local label="$1"
  local file="$2"
  local dir
  validate_absolute_path "$label" "$file"
  if [[ -e "$file" ]]; then
    [[ ! -L "$file" ]] || fail "Unsafe $label: symlinks are not allowed ($file)"
    [[ -f "$file" ]] || fail "Unsafe $label: expected a regular file ($file)"
  fi
  dir="$(dirname "$file")"
  ensure_safe_existing_dir "${label} parent directory" "$dir"
}

write_file_atomically() {
  local file="$1"
  local mode="$2"
  local dir=""
  local tmp=""
  ensure_safe_write_file_path "output file" "$file"
  dir="$(dirname "$file")"
  tmp="$(mktemp "$dir/.tmp.XXXXXX")"
  cat >"$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$file"
}

validate_port() {
  local label="$1"
  local value="$2"
  local numeric=""
  [[ "$value" =~ ^[0-9]{1,5}$ ]] || fail "Invalid $label: must be numeric."
  numeric=$((10#$value))
  (( numeric >= 1 && numeric <= 65535 )) || fail "Invalid $label: out of range."
}

escape_sed_replacement_pipe_delim() {
  printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'
}

resolve_user_home() {
  local user="$1"
  local home=""
  if command -v getent >/dev/null 2>&1; then
    home="$(getent passwd "$user" 2>/dev/null | cut -d: -f6 || true)"
  fi
  if [[ -z "$home" && -f /etc/passwd ]]; then
    home="$(awk -F: -v u="$user" '$1==u {print $6}' /etc/passwd 2>/dev/null || true)"
  fi
  if [[ -z "$home" ]]; then
    home="/home/$user"
  fi
  printf '%s' "$home"
}

generate_token_hex_32() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
    return 0
  fi
  if command -v od >/dev/null 2>&1; then
    od -An -N32 -tx1 /dev/urandom | tr -d " \n"
    return 0
  fi
  echo "Missing dependency: need openssl or python3 (or od) to generate AFORA_GATEWAY_TOKEN." >&2
  exit 1
}

seed_local_control_ui_origins() {
  local file="$1"
  local port="$2"
  local dir=""
  local tmp=""
  ensure_safe_write_file_path "config file" "$file"
  if ! command -v python3 >/dev/null 2>&1; then
    echo "Warning: python3 not found; unable to seed gateway.controlUi.allowedOrigins in $file." >&2
    return 0
  fi
  dir="$(dirname "$file")"
  tmp="$(mktemp "$dir/.config.tmp.XXXXXX")"
  if ! python3 - "$file" "$port" "$tmp" <<'PY'
import json
import sys

path = sys.argv[1]
port = sys.argv[2]
tmp = sys.argv[3]
try:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
except json.JSONDecodeError as exc:
    print(
        f"Warning: unable to seed gateway.controlUi.allowedOrigins in {path}: existing config is not strict JSON ({exc}). Leaving file unchanged.",
        file=sys.stderr,
    )
    raise SystemExit(1)
if not isinstance(data, dict):
    raise SystemExit(f"{path}: expected top-level object")
gateway = data.setdefault("gateway", {})
if not isinstance(gateway, dict):
    raise SystemExit(f"{path}: expected gateway object")
gateway.setdefault("mode", "local")
control_ui = gateway.setdefault("controlUi", {})
if not isinstance(control_ui, dict):
    raise SystemExit(f"{path}: expected gateway.controlUi object")
allowed = control_ui.get("allowedOrigins")
managed_localhosts = {"127.0.0.1", "localhost"}
desired = [
    f"http://127.0.0.1:{port}",
    f"http://localhost:{port}",
]
if not isinstance(allowed, list):
    allowed = []
cleaned = []
for origin in allowed:
    if not isinstance(origin, str):
        continue
    normalized = origin.strip()
    if not normalized:
        continue
    if normalized.startswith("http://"):
        host_port = normalized[len("http://") :]
        host = host_port.split(":", 1)[0]
        if host in managed_localhosts:
            continue
    cleaned.append(normalized)
control_ui["allowedOrigins"] = cleaned + desired
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")
PY
  then
    rm -f "$tmp"
    return 0
  fi
  [[ -s "$tmp" ]] || {
    rm -f "$tmp"
    return 0
  }
  chmod 600 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$file"
}

upsert_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp
  local dir
  ensure_safe_write_file_path "env file" "$file"
  dir="$(dirname "$file")"
  tmp="$(mktemp "$dir/.env.tmp.XXXXXX")"
  if [[ -f "$file" ]]; then
    awk -v k="$key" -v v="$value" '
      BEGIN { found = 0 }
      $0 ~ ("^" k "=") { print k "=" v; found = 1; next }
      { print }
      END { if (!found) print k "=" v }
    ' "$file" >"$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >"$tmp"
  fi
  mv "$tmp" "$file"
  chmod 600 "$file" 2>/dev/null || true
}

INSTALL_QUADLET=false
for arg in "$@"; do
  case "$arg" in
    --quadlet) INSTALL_QUADLET=true ;;
    --container) INSTALL_QUADLET=false ;;
  esac
done
if [[ -n "${AFORA_PODMAN_QUADLET:-}" ]]; then
  case "${AFORA_PODMAN_QUADLET,,}" in
    1|yes|true) INSTALL_QUADLET=true ;;
    0|no|false) INSTALL_QUADLET=false ;;
  esac
fi
if [[ "$INSTALL_QUADLET" == true && "$PLATFORM_NAME" != "Linux" ]]; then
  fail "--quadlet is only supported on Linux with systemd user services."
fi

SEED_GATEWAY_PORT="$HOST_GATEWAY_PORT"
if [[ "$INSTALL_QUADLET" == true ]]; then
  SEED_GATEWAY_PORT="$QUADLET_GATEWAY_PORT"
fi

require_cmd podman
if is_root; then
  echo "Run scripts/podman/setup.sh as your normal user so Podman stays rootless." >&2
  exit 1
fi
if [[ "$AFORA_IMAGE" == "afora:local" ]] && [[ ! -f "$REPO_PATH/Dockerfile" ]]; then
  echo "Dockerfile not found at $REPO_PATH. Set AFORA_REPO_PATH to the repo root." >&2
  exit 1
fi
if [[ ! -f "$RUN_SCRIPT_SRC" ]]; then
  echo "Launch script not found at $RUN_SCRIPT_SRC." >&2
  exit 1
fi

if [[ -z "$AFORA_HOME" ]]; then
  AFORA_HOME="$(resolve_user_home "$AFORA_USER")"
fi
if [[ -z "$AFORA_HOME" ]]; then
  echo "Unable to resolve HOME for user $AFORA_USER." >&2
  exit 1
fi
if [[ -z "$AFORA_CONFIG_DIR" ]]; then
  AFORA_CONFIG_DIR="$AFORA_HOME/.afora"
fi
if [[ -z "$AFORA_WORKSPACE_DIR" ]]; then
  AFORA_WORKSPACE_DIR="$AFORA_CONFIG_DIR/workspace"
fi
validate_absolute_path "home directory" "$AFORA_HOME"
validate_mount_source_path "config directory" "$AFORA_CONFIG_DIR"
validate_mount_source_path "workspace directory" "$AFORA_WORKSPACE_DIR"
validate_container_name "$AFORA_CONTAINER_NAME"
validate_image_name "$AFORA_IMAGE"
validate_port "gateway host port" "$HOST_GATEWAY_PORT"
validate_port "seed gateway port" "$SEED_GATEWAY_PORT"

install -d -m 700 "$AFORA_CONFIG_DIR" "$AFORA_WORKSPACE_DIR"
ensure_private_existing_dir_owned_by_user "config directory" "$AFORA_CONFIG_DIR"
ensure_private_existing_dir_owned_by_user "workspace directory" "$AFORA_WORKSPACE_DIR"

AFORA_IMAGE_APT_PACKAGES="${AFORA_IMAGE_APT_PACKAGES-${AFORA_DOCKER_APT_PACKAGES:-}}"
AFORA_IMAGE_PIP_PACKAGES="${AFORA_IMAGE_PIP_PACKAGES:-}"
BUILD_ARGS=()
BUILD_GIT_COMMIT="$(afora_resolve_git_commit "$REPO_PATH")"
BUILD_TIMESTAMP="$(afora_resolve_build_timestamp)"
BUILD_ARGS+=(--build-arg "AFORA_BUILD_TIMESTAMP=${BUILD_TIMESTAMP}")
if [[ "$BUILD_GIT_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]]; then
  BUILD_ARGS+=(--build-arg "GIT_COMMIT=${BUILD_GIT_COMMIT}")
fi
if [[ -n "$AFORA_IMAGE_APT_PACKAGES" ]]; then
  BUILD_ARGS+=(--build-arg "AFORA_IMAGE_APT_PACKAGES=${AFORA_IMAGE_APT_PACKAGES}")
fi
if [[ -n "$AFORA_IMAGE_PIP_PACKAGES" ]]; then
  BUILD_ARGS+=(--build-arg "AFORA_IMAGE_PIP_PACKAGES=${AFORA_IMAGE_PIP_PACKAGES}")
fi
if [[ -n "${AFORA_EXTENSIONS:-}" ]]; then
  BUILD_ARGS+=(--build-arg "AFORA_EXTENSIONS=${AFORA_EXTENSIONS}")
fi
if [[ -n "${AFORA_INSTALL_BROWSER:-}" ]]; then
  BUILD_ARGS+=(--build-arg "AFORA_INSTALL_BROWSER=${AFORA_INSTALL_BROWSER}")
fi

if [[ "$AFORA_IMAGE" == "afora:local" ]]; then
  echo "Building image $AFORA_IMAGE ..."
  run_podman_build -t "$AFORA_IMAGE" -f "$REPO_PATH/Dockerfile" "${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}" "$REPO_PATH"
else
  if podman image exists "$AFORA_IMAGE" >/dev/null 2>&1; then
    echo "Using existing image $AFORA_IMAGE"
  else
    echo "Pulling image $AFORA_IMAGE ..."
    run_podman_pull "$AFORA_IMAGE"
  fi
fi

ENV_FILE="$AFORA_CONFIG_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  TOKEN="$(generate_token_hex_32)"
  (
    umask 077
    write_file_atomically "$ENV_FILE" 600 <<EOF
AFORA_GATEWAY_TOKEN=$TOKEN
EOF
  )
  echo "Generated AFORA_GATEWAY_TOKEN and wrote it to $ENV_FILE"
fi
upsert_env_var "$ENV_FILE" "AFORA_PODMAN_CONTAINER" "$AFORA_CONTAINER_NAME"
upsert_env_var "$ENV_FILE" "AFORA_PODMAN_IMAGE" "$AFORA_IMAGE"

CONFIG_JSON="$AFORA_CONFIG_DIR/afora.json"
if [[ ! -f "$CONFIG_JSON" ]]; then
  (
    umask 077
    write_file_atomically "$CONFIG_JSON" 600 <<JSON
{
  "gateway": {
    "mode": "local",
        "controlUi": {
          "allowedOrigins": [
        "http://127.0.0.1:${SEED_GATEWAY_PORT}",
        "http://localhost:${SEED_GATEWAY_PORT}"
      ]
    }
  }
}
JSON
  )
  echo "Wrote minimal config to $CONFIG_JSON"
fi
seed_local_control_ui_origins "$CONFIG_JSON" "$SEED_GATEWAY_PORT"

if [[ "$INSTALL_QUADLET" == true ]]; then
  QUADLET_DIR="$AFORA_HOME/.config/containers/systemd"
  QUADLET_DST="$QUADLET_DIR/afora.container"
  echo "Installing Quadlet to $QUADLET_DST ..."
  mkdir -p "$QUADLET_DIR"
  ensure_safe_existing_dir "quadlet directory" "$QUADLET_DIR"
  AFORA_HOME_ESCAPED="$(escape_sed_replacement_pipe_delim "$AFORA_HOME")"
  AFORA_CONFIG_ESCAPED="$(escape_sed_replacement_pipe_delim "$AFORA_CONFIG_DIR")"
  AFORA_WORKSPACE_ESCAPED="$(escape_sed_replacement_pipe_delim "$AFORA_WORKSPACE_DIR")"
  AFORA_IMAGE_ESCAPED="$(escape_sed_replacement_pipe_delim "$AFORA_IMAGE")"
  AFORA_CONTAINER_ESCAPED="$(escape_sed_replacement_pipe_delim "$AFORA_CONTAINER_NAME")"
  sed \
    -e "s|{{AFORA_HOME}}|$AFORA_HOME_ESCAPED|g" \
    -e "s|{{AFORA_CONFIG_DIR}}|$AFORA_CONFIG_ESCAPED|g" \
    -e "s|{{AFORA_WORKSPACE_DIR}}|$AFORA_WORKSPACE_ESCAPED|g" \
    -e "s|{{IMAGE_NAME}}|$AFORA_IMAGE_ESCAPED|g" \
    -e "s|{{CONTAINER_NAME}}|$AFORA_CONTAINER_ESCAPED|g" \
    "$QUADLET_TEMPLATE" | write_file_atomically "$QUADLET_DST" 644

  if command -v systemctl >/dev/null 2>&1; then
    echo "Reloading and starting user service..."
    if systemctl --user daemon-reload && systemctl --user start afora.service; then
      echo "Quadlet installed and service started."
    else
      echo "Quadlet installed, but automatic start failed." >&2
      echo "Try: systemctl --user daemon-reload && systemctl --user start afora.service" >&2
      if command -v loginctl >/dev/null 2>&1; then
        echo "For boot persistence on headless hosts, you may also need: sudo loginctl enable-linger $(whoami)" >&2
      fi
    fi
  else
    echo "systemctl not found; Quadlet installed but not started." >&2
  fi
else
  echo "Container setup complete."
fi

echo
echo "Next:"
echo "  ./scripts/run-afora-podman.sh launch"
echo "  ./scripts/run-afora-podman.sh launch setup"
echo "  afora --container $AFORA_CONTAINER_NAME dashboard --no-open"
