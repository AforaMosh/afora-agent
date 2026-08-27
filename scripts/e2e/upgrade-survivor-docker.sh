#!/usr/bin/env bash
# Installs the packed Afora tarball over dirty old-user state. When
# AFORA_UPGRADE_SURVIVOR_BASELINE_SPEC is set, installs that published
# baseline first and upgrades it to the selected candidate.
set -euo pipefail

HARNESS_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT_DIR="$(cd "${AFORA_DOCKER_E2E_REPO_ROOT:-$HARNESS_ROOT_DIR}" && pwd)"
DOCKER_E2E_HARNESS_ROOT_DIR="$HARNESS_ROOT_DIR"
source "$HARNESS_ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$HARNESS_ROOT_DIR/scripts/lib/docker-e2e-package.sh"
source "$HARNESS_ROOT_DIR/scripts/lib/afora-e2e-instance.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "afora-upgrade-survivor-e2e" AFORA_UPGRADE_SURVIVOR_E2E_IMAGE)"
SKIP_BUILD="${AFORA_UPGRADE_SURVIVOR_E2E_SKIP_BUILD:-0}"
DOCKER_RUN_TIMEOUT="${AFORA_UPGRADE_SURVIVOR_DOCKER_RUN_TIMEOUT:-1200s}"
BASELINE_SPEC="${AFORA_UPGRADE_SURVIVOR_BASELINE_SPEC:-}"
SCENARIO="${AFORA_UPGRADE_SURVIVOR_SCENARIO:-base}"
UPDATE_RESTART_MODE="${AFORA_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE:-manual}"
COMMAND_TIMEOUT="${AFORA_UPGRADE_SURVIVOR_COMMAND_TIMEOUT:-900s}"
START_BUDGET_SECONDS="$(afora_e2e_read_positive_int_env AFORA_UPGRADE_SURVIVOR_START_BUDGET_SECONDS 90)"
STATUS_BUDGET_SECONDS="$(afora_e2e_read_positive_int_env AFORA_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS 30)"
PROBE_TIMEOUT_MS="$(afora_e2e_read_nonnegative_int_env AFORA_UPGRADE_SURVIVOR_PROBE_TIMEOUT_MS 60000)"
PROBE_ATTEMPT_TIMEOUT_MS="$(
  afora_e2e_read_positive_int_env AFORA_UPGRADE_SURVIVOR_PROBE_ATTEMPT_TIMEOUT_MS 5000
)"
PROBE_MAX_BODY_BYTES="$(
  afora_e2e_read_positive_int_env AFORA_UPGRADE_SURVIVOR_PROBE_MAX_BODY_BYTES 1048576
)"
ROOT_MANAGED_VPS="${AFORA_UPGRADE_SURVIVOR_ROOT_MANAGED_VPS:-0}"

resolve_lane_artifact_suffix() {
  if [ -n "${AFORA_DOCKER_ALL_LANE_NAME:-}" ]; then
    printf "%s" "$AFORA_DOCKER_ALL_LANE_NAME"
    return
  fi

  if [ "$ROOT_MANAGED_VPS" = "1" ]; then
    printf "root-managed-vps-upgrade"
  elif [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then
    printf "update-restart-auth"
  elif [ "${AFORA_UPGRADE_SURVIVOR_PUBLISHED_BASELINE:-0}" = "1" ]; then
    printf "published-upgrade-survivor"
  else
    printf "upgrade-survivor"
  fi

  if [ -n "${BASELINE_SPEC// }" ]; then
    printf -- "-%s" "$BASELINE_SPEC"
  fi
  if [ "$SCENARIO" != "base" ]; then
    printf -- "-%s" "$SCENARIO"
  fi
}

LANE_ARTIFACT_SUFFIX="$(resolve_lane_artifact_suffix)"
LANE_ARTIFACT_SUFFIX="${LANE_ARTIFACT_SUFFIX//[^A-Za-z0-9_.-]/_}"
ARTIFACT_DIR="${AFORA_UPGRADE_SURVIVOR_ARTIFACT_DIR:-$ROOT_DIR/.artifacts/upgrade-survivor/$LANE_ARTIFACT_SUFFIX}"
DOCKER_RUN_USER_ARGS=()
PREPUBLISH_PLUGIN_REGISTRY_ARGS=()
AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT=""
PROBE_ENV_ARGS=(
  -e AFORA_UPGRADE_SURVIVOR_PROBE_TIMEOUT_MS="$PROBE_TIMEOUT_MS"
  -e AFORA_UPGRADE_SURVIVOR_PROBE_ATTEMPT_TIMEOUT_MS="$PROBE_ATTEMPT_TIMEOUT_MS"
  -e AFORA_UPGRADE_SURVIVOR_PROBE_MAX_BODY_BYTES="$PROBE_MAX_BODY_BYTES"
)
if [ -n "${AFORA_UPGRADE_SURVIVOR_READYZ_ALLOW_FAILING:-}" ]; then
  PROBE_ENV_ARGS+=(
    -e AFORA_UPGRADE_SURVIVOR_READYZ_ALLOW_FAILING="$AFORA_UPGRADE_SURVIVOR_READYZ_ALLOW_FAILING"
  )
fi
if [ -n "${AFORA_UPGRADE_SURVIVOR_READYZ_ALLOW_DEGRADED:-}" ]; then
  PROBE_ENV_ARGS+=(
    -e AFORA_UPGRADE_SURVIVOR_READYZ_ALLOW_DEGRADED="$AFORA_UPGRADE_SURVIVOR_READYZ_ALLOW_DEGRADED"
  )
fi
configure_prepublish_plugin_registry() {
  local registry_dir="$1"
  PREPUBLISH_PLUGIN_REGISTRY_DIR="$(
    cd "$registry_dir" && pwd
  )"
  if [ ! -f "$PREPUBLISH_PLUGIN_REGISTRY_DIR/prepublish-plugin-registry.json" ]; then
    echo "Prepublish plugin registry manifest is missing." >&2
    exit 1
  fi
  PREPUBLISH_PLUGIN_REGISTRY_ARGS=(
    -e AFORA_PREPUBLISH_PLUGIN_REGISTRY_DIR=/tmp/afora-prepublish-plugin-registry
    -v "$PREPUBLISH_PLUGIN_REGISTRY_DIR:/tmp/afora-prepublish-plugin-registry:ro"
  )
}
if [ -n "${AFORA_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ]; then
  configure_prepublish_plugin_registry "$AFORA_PREPUBLISH_PLUGIN_REGISTRY_DIR"
fi
cleanup_outer() {
  docker_e2e_cleanup_package_tgz "${PACKAGE_TGZ:-}"
  if [ -n "$AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT" ]; then
    rm -rf "$AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT"
  fi
}
trap cleanup_outer EXIT

if [ "$ROOT_MANAGED_VPS" = "1" ]; then
  if [ "${AFORA_UPGRADE_SURVIVOR_PUBLISHED_BASELINE:-0}" != "1" ]; then
    echo "AFORA_UPGRADE_SURVIVOR_ROOT_MANAGED_VPS=1 requires AFORA_UPGRADE_SURVIVOR_PUBLISHED_BASELINE=1" >&2
    exit 1
  fi
  DOCKER_RUN_USER_ARGS+=(--user root -e HOME=/root -e USER=root)
fi

normalize_npm_candidate() {
  local raw="$1"
  case "$raw" in
    latest | beta)
      printf 'afora@%s\n' "$raw"
      ;;
    afora@*)
      printf '%s\n' "$raw"
      ;;
    *@*)
      echo "AFORA_UPGRADE_SURVIVOR_CANDIDATE must be current, latest, beta, afora@<version>, a bare version, or a .tgz path." >&2
      return 1
      ;;
    *)
      printf 'afora@%s\n' "$raw"
      ;;
  esac
}

if [ "${AFORA_UPGRADE_SURVIVOR_PUBLISHED_BASELINE:-0}" = "1" ]; then
  if [ -z "${BASELINE_SPEC// }" ]; then
    echo "AFORA_UPGRADE_SURVIVOR_BASELINE_SPEC is required for published upgrade survivor" >&2
    exit 1
  fi

  mkdir -p "$ARTIFACT_DIR"
  chmod -R a+rwX "$ARTIFACT_DIR" || true

  DOCKER_E2E_PACKAGE_ARGS=()
  CANDIDATE_RAW="${AFORA_UPGRADE_SURVIVOR_CANDIDATE:-current}"
  CANDIDATE_KIND="npm"
  CANDIDATE_IS_CURRENT=0
  CANDIDATE_SPEC=""

  if [ -n "${AFORA_CURRENT_PACKAGE_TGZ:-}" ]; then
    PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz upgrade-survivor "$AFORA_CURRENT_PACKAGE_TGZ")"
    docker_e2e_package_mount_args "$PACKAGE_TGZ"
    CANDIDATE_KIND="tarball"
    CANDIDATE_IS_CURRENT=1
    CANDIDATE_SPEC="/tmp/afora-current.tgz"
  elif [ "$CANDIDATE_RAW" = "current" ]; then
    PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz upgrade-survivor)"
    docker_e2e_package_mount_args "$PACKAGE_TGZ"
    CANDIDATE_KIND="tarball"
    CANDIDATE_IS_CURRENT=1
    CANDIDATE_SPEC="/tmp/afora-current.tgz"
  elif [[ "$CANDIDATE_RAW" == *.tgz ]]; then
    if [ ! -f "$CANDIDATE_RAW" ]; then
      echo "Afora candidate tarball does not exist: $CANDIDATE_RAW" >&2
      exit 1
    fi
    PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz upgrade-survivor "$CANDIDATE_RAW")"
    docker_e2e_package_mount_args "$PACKAGE_TGZ"
    CANDIDATE_KIND="tarball"
    CANDIDATE_SPEC="/tmp/afora-current.tgz"
  else
    CANDIDATE_KIND="npm"
    CANDIDATE_SPEC="$(normalize_npm_candidate "$CANDIDATE_RAW")"
  fi

  if [ "$CANDIDATE_IS_CURRENT" = "1" ] && [ -z "${AFORA_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ]; then
    AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT="$(
      mktemp -d "${TMPDIR:-/tmp}/afora-upgrade-survivor-plugin-registry.XXXXXX"
    )"
    AFORA_DOCKER_ALL_LANES=published-upgrade-survivor \
      AFORA_DOCKER_ALL_LOG_DIR="$AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT" \
      AFORA_DOCKER_ALL_TIMINGS=0 \
      AFORA_UPGRADE_SURVIVOR_BASELINE_SPECS="$BASELINE_SPEC" \
      AFORA_UPGRADE_SURVIVOR_SCENARIOS="$SCENARIO" \
      node "$HARNESS_ROOT_DIR/scripts/test-docker-all.mjs" --prepare-plugin-registry
    configure_prepublish_plugin_registry \
      "$AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT/prepublish-plugin-registry"
  fi

  AFORA_TEST_STATE_FUNCTION_B64="$(docker_e2e_test_state_function_b64)"
  TRUSTED_TSX_NODE_MODULES="$HARNESS_ROOT_DIR/node_modules"
  TRUSTED_TSX_IMPORT="$TRUSTED_TSX_NODE_MODULES/tsx/dist/loader.mjs"
  if [ ! -f "$TRUSTED_TSX_IMPORT" ]; then
    echo "Trusted upgrade-survivor tsx loader not found: $TRUSTED_TSX_IMPORT" >&2
    exit 1
  fi

  docker_e2e_build_or_reuse "$IMAGE_NAME" upgrade-survivor "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "bare" "$SKIP_BUILD"

  echo "Running published upgrade survivor Docker E2E..."
  # Keep candidate images from selecting an older copy of the trusted release runner.
  docker_e2e_run_with_harness \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    -e AFORA_TEST_STATE_FUNCTION_B64="$AFORA_TEST_STATE_FUNCTION_B64" \
    -e AFORA_UPGRADE_SURVIVOR_BASELINE="$BASELINE_SPEC" \
    -e AFORA_UPGRADE_SURVIVOR_CANDIDATE_KIND="$CANDIDATE_KIND" \
    -e AFORA_UPGRADE_SURVIVOR_CANDIDATE_SPEC="$CANDIDATE_SPEC" \
    -e AFORA_UPGRADE_SURVIVOR_SCENARIO="$SCENARIO" \
    -e AFORA_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE="$UPDATE_RESTART_MODE" \
    -e AFORA_UPGRADE_SURVIVOR_COMMAND_TIMEOUT="$COMMAND_TIMEOUT" \
    -e AFORA_UPGRADE_SURVIVOR_LEGACY_RUNTIME_DEPS_SYMLINK="${AFORA_UPGRADE_SURVIVOR_LEGACY_RUNTIME_DEPS_SYMLINK:-}" \
    -e AFORA_UPGRADE_SURVIVOR_ROOT_MANAGED_VPS="$ROOT_MANAGED_VPS" \
    -e AFORA_UPGRADE_SURVIVOR_TSX_IMPORT=/tmp/afora-release-harness/node_modules/tsx/dist/loader.mjs \
    -e AFORA_UPGRADE_SURVIVOR_SUMMARY_JSON=/tmp/afora-upgrade-survivor-artifacts/summary.json \
    -e AFORA_UPGRADE_SURVIVOR_START_BUDGET_SECONDS="$START_BUDGET_SECONDS" \
    -e AFORA_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS="$STATUS_BUDGET_SECONDS" \
    -e AFORA_UPGRADE_SURVIVOR_CLAWHUB_FIXTURE_SERVER=/tmp/afora-clawhub-fixture-server.cjs \
    "${PROBE_ENV_ARGS[@]}" \
    -v "$ARTIFACT_DIR:/tmp/afora-upgrade-survivor-artifacts" \
    -v "$TRUSTED_TSX_NODE_MODULES:/tmp/afora-release-harness/node_modules:ro" \
    -v "$HARNESS_ROOT_DIR/scripts/e2e/lib/clawhub-fixture-server.cjs:/tmp/afora-clawhub-fixture-server.cjs:ro" \
    -v "$HARNESS_ROOT_DIR/scripts/e2e/lib/upgrade-survivor/run.sh:/tmp/afora-upgrade-survivor-run.sh:ro" \
    "${PREPUBLISH_PLUGIN_REGISTRY_ARGS[@]}" \
    "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
    "${DOCKER_RUN_USER_ARGS[@]}" \
    "$IMAGE_NAME" \
    timeout --kill-after=30s "$DOCKER_RUN_TIMEOUT" bash /tmp/afora-upgrade-survivor-run.sh
  exit 0
fi

PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz upgrade-survivor "${AFORA_CURRENT_PACKAGE_TGZ:-}")"
docker_e2e_package_mount_args "$PACKAGE_TGZ"
AFORA_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 upgrade-survivor upgrade-survivor)"
mkdir -p "$ARTIFACT_DIR"
chmod -R a+rwX "$ARTIFACT_DIR" || true

docker_e2e_build_or_reuse "$IMAGE_NAME" upgrade-survivor "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "bare" "$SKIP_BUILD"

echo "Running upgrade survivor Docker E2E..."
docker_e2e_run_with_harness \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e AFORA_TEST_STATE_SCRIPT_B64="$AFORA_TEST_STATE_SCRIPT_B64" \
  -e AFORA_UPGRADE_SURVIVOR_ARTIFACT_ROOT=/tmp/afora-upgrade-survivor-artifacts \
  -e AFORA_UPGRADE_SURVIVOR_ROOT_MANAGED_VPS="$ROOT_MANAGED_VPS" \
  -e AFORA_UPGRADE_SURVIVOR_SCENARIO="$SCENARIO" \
  -e AFORA_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE="$UPDATE_RESTART_MODE" \
  -e AFORA_UPGRADE_SURVIVOR_COMMAND_TIMEOUT="$COMMAND_TIMEOUT" \
  -e AFORA_UPGRADE_SURVIVOR_START_BUDGET_SECONDS="$START_BUDGET_SECONDS" \
  -e AFORA_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS="$STATUS_BUDGET_SECONDS" \
  -e AFORA_UPGRADE_SURVIVOR_CLAWHUB_FIXTURE_SERVER=/tmp/afora-clawhub-fixture-server.cjs \
  "${PROBE_ENV_ARGS[@]}" \
  -v "$ARTIFACT_DIR:/tmp/afora-upgrade-survivor-artifacts" \
  -v "$HARNESS_ROOT_DIR/scripts/e2e/lib/clawhub-fixture-server.cjs:/tmp/afora-clawhub-fixture-server.cjs:ro" \
  "${PREPUBLISH_PLUGIN_REGISTRY_ARGS[@]}" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  "${DOCKER_RUN_USER_ARGS[@]}" \
  "$IMAGE_NAME" \
  timeout --kill-after=30s "$DOCKER_RUN_TIMEOUT" bash -lc 'set -euo pipefail
source scripts/lib/afora-e2e-instance.sh

export npm_config_loglevel=error
export npm_config_fund=false
export npm_config_audit=false
export AFORA_UPGRADE_SURVIVOR_ARTIFACT_ROOT="${AFORA_UPGRADE_SURVIVOR_ARTIFACT_ROOT:-/tmp/afora-upgrade-survivor-artifacts}"
export AFORA_UPGRADE_SURVIVOR_RUNTIME_ROOT="${AFORA_UPGRADE_SURVIVOR_RUNTIME_ROOT:-/tmp/afora-upgrade-survivor-runtime}"
mkdir -p "$AFORA_UPGRADE_SURVIVOR_ARTIFACT_ROOT"
export TMPDIR="${AFORA_UPGRADE_SURVIVOR_TMPDIR:-$AFORA_UPGRADE_SURVIVOR_RUNTIME_ROOT/tmp}"
export AFORA_TEST_STATE_TMPDIR="${AFORA_UPGRADE_SURVIVOR_TEST_STATE_TMPDIR:-$AFORA_UPGRADE_SURVIVOR_RUNTIME_ROOT/state-tmp}"
export npm_config_prefix="$AFORA_UPGRADE_SURVIVOR_ARTIFACT_ROOT/npm-prefix"
export NPM_CONFIG_PREFIX="$npm_config_prefix"
export npm_config_cache="${AFORA_UPGRADE_SURVIVOR_NPM_CACHE:-$AFORA_UPGRADE_SURVIVOR_RUNTIME_ROOT/npm-cache}"
export NPM_CONFIG_CACHE="$npm_config_cache"
export npm_config_tmp="$TMPDIR"
mkdir -p "$AFORA_UPGRADE_SURVIVOR_RUNTIME_ROOT" "$TMPDIR" "$AFORA_TEST_STATE_TMPDIR" "$npm_config_prefix" "$npm_config_cache"
chmod 700 "$npm_config_cache" || true
export PATH="$npm_config_prefix/bin:$PATH"
export CI=true
export AFORA_NO_ONBOARD=1
export AFORA_NO_PROMPT=1
export AFORA_SKIP_PROVIDERS=1
export AFORA_SKIP_CHANNELS=1
export AFORA_DISABLE_BONJOUR=1
export GATEWAY_AUTH_TOKEN_REF="upgrade-survivor-token"
export OPENAI_API_KEY="sk-afora-upgrade-survivor"
export DISCORD_BOT_TOKEN="upgrade-survivor-discord-token"
export TELEGRAM_BOT_TOKEN="123456:upgrade-survivor-telegram-token"
if [ "${AFORA_UPGRADE_SURVIVOR_SCENARIO:-base}" = "feishu-channel" ]; then
  export FEISHU_APP_SECRET="upgrade-survivor-feishu-secret"
fi
export BRAVE_API_KEY="BSA_upgrade_survivor_brave_key"

UPDATE_RESTART_MODE="${AFORA_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE:-manual}"
command_timeout="${AFORA_UPGRADE_SURVIVOR_COMMAND_TIMEOUT:-900s}"
PORT=18789
START_BUDGET="$(afora_e2e_read_positive_int_env AFORA_UPGRADE_SURVIVOR_START_BUDGET_SECONDS 90)"
STATUS_BUDGET="$(afora_e2e_read_positive_int_env AFORA_UPGRADE_SURVIVOR_STATUS_BUDGET_SECONDS 30)"
GATEWAY_LOG="$AFORA_UPGRADE_SURVIVOR_ARTIFACT_ROOT/gateway.log"
SYSTEMCTL_SHIM_LOG="$AFORA_UPGRADE_SURVIVOR_ARTIFACT_ROOT/systemctl-shim.log"
SYSTEMCTL_SHIM_PID_FILE="$AFORA_UPGRADE_SURVIVOR_ARTIFACT_ROOT/systemctl-shim.pid"
SYSTEMCTL_SHIM_DAEMON_LOG="$AFORA_UPGRADE_SURVIVOR_ARTIFACT_ROOT/systemctl-shim-gateway.log"
BASELINE_SERVICE_INSTALL_JSON="$AFORA_UPGRADE_SURVIVOR_ARTIFACT_ROOT/baseline-service-install.json"
BASELINE_SERVICE_INSTALL_ERR="$AFORA_UPGRADE_SURVIVOR_ARTIFACT_ROOT/baseline-service-install.err"
export AFORA_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG="$SYSTEMCTL_SHIM_LOG"
export AFORA_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE="$SYSTEMCTL_SHIM_PID_FILE"
export AFORA_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG="$SYSTEMCTL_SHIM_DAEMON_LOG"
export AFORA_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_JSON="$BASELINE_SERVICE_INSTALL_JSON"
export AFORA_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_ERR="$BASELINE_SERVICE_INSTALL_ERR"

gateway_pid=""
plugin_registry_pid=""
clawhub_fixture_pid=""
cleanup() {
  if [ -s "$SYSTEMCTL_SHIM_PID_FILE" ]; then
    systemctl --user stop afora-gateway.service >/dev/null 2>&1 || true
  fi
  afora_e2e_terminate_gateways "${gateway_pid:-}"
  if [ -s "$SYSTEMCTL_SHIM_PID_FILE" ]; then
    afora_e2e_terminate_gateways "$(cat "$SYSTEMCTL_SHIM_PID_FILE" 2>/dev/null || true)"
  fi
  afora_e2e_stop_process "${plugin_registry_pid:-}"
  afora_e2e_stop_process "${clawhub_fixture_pid:-}"
}
trap cleanup EXIT

wait_for_fixture_port() {
  local pid="$1" port_file="$2" log_file="$3" label="$4"
  for _ in $(seq 1 100); do
    [ -s "$port_file" ] && return 0
    afora_e2e_process_alive "$pid" || break
    sleep 0.1
  done
  afora_e2e_print_log "$log_file" >&2
  echo "Timed out waiting for upgrade survivor $label." >&2
  return 1
}

configure_clawhub_fixture() {
  unset AFORA_CLAWHUB_URL CLAWHUB_URL
  [ -z "${AFORA_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ] && return 0
  local fixture_root="$AFORA_UPGRADE_SURVIVOR_ARTIFACT_ROOT/clawhub-fixture" port_file log_file
  port_file="$fixture_root/port"
  log_file="$fixture_root/server.log"
  mkdir -p "$fixture_root"
  node "$AFORA_UPGRADE_SURVIVOR_CLAWHUB_FIXTURE_SERVER" \
    prepublish-artifacts "$port_file" \
    "$AFORA_PREPUBLISH_PLUGIN_REGISTRY_DIR/prepublish-plugin-registry.json" >"$log_file" 2>&1 &
  clawhub_fixture_pid="$!"
  wait_for_fixture_port "$clawhub_fixture_pid" "$port_file" "$log_file" "ClawHub fixture"
  export AFORA_CLAWHUB_URL="http://127.0.0.1:$(cat "$port_file")"
}

configure_plugin_registry() {
  local fixture_root="$AFORA_UPGRADE_SURVIVOR_ARTIFACT_ROOT/plugin-registry"
  local package_dir="$fixture_root/package"
  local tarball="$fixture_root/afora-brave-plugin-2026.5.2.tgz"
  local port_file="$fixture_root/npm-registry-port"
  local log_file="$fixture_root/npm-registry.log"
  local registry_args=()

  if [ -n "${AFORA_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ]; then
    local manifest="$AFORA_PREPUBLISH_PLUGIN_REGISTRY_DIR/prepublish-plugin-registry.json"
    local registry_rows
    registry_rows="$(
      PREPUBLISH_PLUGIN_REGISTRY_MANIFEST="$manifest" node <<'"'"'NODE'"'"'
const fs = require("node:fs");
const path = require("node:path");
const manifestPath = process.env.PREPUBLISH_PLUGIN_REGISTRY_MANIFEST;
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) {
  throw new Error("prepublish plugin registry manifest must contain packages");
}
for (const entry of manifest.packages) {
  if (
    typeof entry.name !== "string" ||
    typeof entry.version !== "string" ||
    typeof entry.tarball !== "string" ||
    path.basename(entry.tarball) !== entry.tarball
  ) {
    throw new Error("invalid prepublish plugin registry package entry");
  }
  process.stdout.write(
    `${entry.name}\t${entry.version}\t${path.join(path.dirname(manifestPath), entry.tarball)}\n`,
  );
}
NODE
    )"
    while IFS=$'"'"'\t'"'"' read -r plugin_package_name plugin_package_version plugin_package_tarball; do
      registry_args+=("$plugin_package_name" "$plugin_package_version" "$plugin_package_tarball")
    done <<<"$registry_rows"
  fi

  if [ "${AFORA_UPGRADE_SURVIVOR_SCENARIO:-base}" = "configured-plugin-installs" ]; then
    mkdir -p "$package_dir"
    FIXTURE_PACKAGE_DIR="$package_dir" node <<'"'"'NODE'"'"'
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.FIXTURE_PACKAGE_DIR;
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(
  path.join(root, "package.json"),
  `${JSON.stringify(
    {
      name: "@afora/brave-plugin",
      version: "2026.5.2",
      afora: { extensions: ["./index.js"] },
    },
    null,
    2,
  )}\n`,
);
fs.writeFileSync(
  path.join(root, "afora.plugin.json"),
  `${JSON.stringify(
    {
      id: "brave",
      activation: { onStartup: false },
      setup: { providers: [{ id: "brave", envVars: ["BRAVE_API_KEY"] }] },
      contracts: { webSearchProviders: ["brave"] },
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          webSearch: {
            type: "object",
            additionalProperties: false,
            properties: {
              apiKey: { type: ["string", "object"] },
              mode: { type: "string", enum: ["web", "llm-context"] },
              baseUrl: { type: ["string", "object"] },
            },
          },
        },
      },
    },
    null,
    2,
  )}\n`,
);
fs.writeFileSync(
  path.join(root, "index.js"),
  `module.exports = { id: "brave", name: "Brave Fixture", register() {} };\n`,
);
NODE
    tar -czf "$tarball" -C "$fixture_root" package
    registry_args+=("@afora/brave-plugin" "2026.5.2" "$tarball")
  fi

  if [ "${#registry_args[@]}" -eq 0 ]; then
    return 0
  fi

  mkdir -p "$fixture_root"
  AFORA_NPM_REGISTRY_DIST_TAGS="beta=$package_version" \
  AFORA_NPM_REGISTRY_UPSTREAM=https://registry.npmjs.org \
    node scripts/e2e/lib/plugins/npm-registry-server.mjs \
    "$port_file" \
    "${registry_args[@]}" \
    >"$log_file" 2>&1 &
  plugin_registry_pid="$!"

  wait_for_fixture_port "$plugin_registry_pid" "$port_file" "$log_file" "npm registry"
  export NPM_CONFIG_REGISTRY="http://127.0.0.1:$(cat "$port_file")"
  export npm_config_registry="$NPM_CONFIG_REGISTRY"
}

afora_e2e_eval_test_state_from_b64 "${AFORA_TEST_STATE_SCRIPT_B64:?missing AFORA_TEST_STATE_SCRIPT_B64}"
node scripts/e2e/lib/upgrade-survivor/assertions.mjs seed

afora_e2e_install_package "$AFORA_UPGRADE_SURVIVOR_ARTIFACT_ROOT/install.log" "upgrade survivor package" "$npm_config_prefix"
command -v afora >/dev/null
package_version="$(node -p "JSON.parse(require(\"node:fs\").readFileSync(process.argv[1] + \"/lib/node_modules/afora/package.json\", \"utf8\")).version" "$npm_config_prefix")"
AFORA_PACKAGE_ACCEPTANCE_LEGACY_COMPAT="$(
  node scripts/e2e/lib/package-compat.mjs "$package_version"
)"
export AFORA_PACKAGE_ACCEPTANCE_LEGACY_COMPAT

echo "Checking dirty-state config before update..."
AFORA_UPGRADE_SURVIVOR_ASSERT_STAGE=baseline node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-config
AFORA_UPGRADE_SURVIVOR_ASSERT_STAGE=baseline node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-state
configure_clawhub_fixture
if [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then
  # shellcheck disable=SC1091
  source scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh
  prepare_update_restart_probe_current_install "$PORT" "$GATEWAY_LOG"
fi

configure_plugin_registry
echo "Running package update against the mounted tarball..."
update_args=(update --tag "${AFORA_CURRENT_PACKAGE_TGZ:?missing AFORA_CURRENT_PACKAGE_TGZ}" --yes --json)
if [ "$UPDATE_RESTART_MODE" != "auto-auth" ]; then
  update_args+=(--no-restart)
fi
set +e
afora_e2e_maybe_timeout "$command_timeout" env -u AFORA_GATEWAY_TOKEN -u AFORA_GATEWAY_PASSWORD AFORA_ALLOW_ROOT=1 afora "${update_args[@]}" >/tmp/afora-upgrade-survivor-update.json 2>/tmp/afora-upgrade-survivor-update.err
update_status=$?
set -e
if [ "$update_status" -ne 0 ]; then
  echo "afora update failed" >&2
  validate_status=0
  afora_e2e_maybe_timeout "$command_timeout" afora config validate --json >/tmp/afora-upgrade-survivor-post-update-validate.json 2>/tmp/afora-upgrade-survivor-post-update-validate.err || validate_status=$?
  echo "post-update config validation probe status=$validate_status" >&2
  afora_e2e_print_log /tmp/afora-upgrade-survivor-post-update-validate.err >&2 || true
  afora_e2e_print_log /tmp/afora-upgrade-survivor-post-update-validate.json >&2 || true
  afora_e2e_print_log /tmp/afora-upgrade-survivor-update.err >&2 || true
  afora_e2e_print_log /tmp/afora-upgrade-survivor-update.json >&2 || true
  exit "$update_status"
fi
if [ -n "${AFORA_CLAWHUB_URL:-}" ]; then
  node "$AFORA_UPGRADE_SURVIVOR_CLAWHUB_FIXTURE_SERVER" \
    assert-prepublish-requests "$AFORA_CLAWHUB_URL" "@afora/whatsapp" "$package_version"
fi

if [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then
  echo "Skipping doctor repair until after restart proof."
else
  echo "Running non-interactive doctor repair..."
  if ! afora_e2e_maybe_timeout "$command_timeout" afora doctor --fix --non-interactive >/tmp/afora-upgrade-survivor-doctor.log 2>&1; then
    echo "afora doctor failed" >&2
    afora_e2e_print_log /tmp/afora-upgrade-survivor-doctor.log >&2
    exit 1
  fi
  if ! afora_e2e_maybe_timeout "$command_timeout" afora config validate >>/tmp/afora-upgrade-survivor-doctor.log 2>&1; then
    echo "post-doctor config validation failed" >&2
    afora_e2e_print_log /tmp/afora-upgrade-survivor-doctor.log >&2
    exit 1
  fi
fi

echo "Verifying config and state survived update..."
node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-config
node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-state

startup_summary="n/a"
if [ "$UPDATE_RESTART_MODE" = "auto-auth" ]; then
  echo "Gateway restart was handled by afora update."
else
  echo "Starting gateway from upgraded state..."
  start_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
  afora gateway --port "$PORT" --bind loopback --allow-unconfigured >"$GATEWAY_LOG" 2>&1 &
  gateway_pid="$!"
  afora_e2e_wait_gateway_ready "$gateway_pid" "$GATEWAY_LOG" 360 "$PORT"
  ready_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
  start_seconds=$(((ready_epoch - start_epoch + 999) / 1000))
  if [ "$start_seconds" -gt "$START_BUDGET" ]; then
    echo "gateway startup exceeded survivor budget: ${start_seconds}s > ${START_BUDGET}s" >&2
    afora_e2e_print_log "$GATEWAY_LOG" >&2
    exit 1
  fi
  startup_summary="${start_seconds}s"
fi

echo "Checking gateway HTTP probes..."
node scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs \
  --base-url "http://127.0.0.1:$PORT" \
  --path /healthz \
  --expect live \
  --out /tmp/afora-upgrade-survivor-healthz.json

readyz_probe_args=(
  --base-url "http://127.0.0.1:$PORT"
  --path /readyz
  --expect ready
)
if [ -n "${AFORA_UPGRADE_SURVIVOR_READYZ_ALLOW_FAILING:-}" ]; then
  readyz_probe_args+=(--allow-failing "$AFORA_UPGRADE_SURVIVOR_READYZ_ALLOW_FAILING")
fi
if [ "${AFORA_UPGRADE_SURVIVOR_READYZ_ALLOW_DEGRADED:-}" = "1" ]; then
  readyz_probe_args+=(--allow-degraded-ready)
fi
readyz_probe_args+=(--out /tmp/afora-upgrade-survivor-readyz.json)
node scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs "${readyz_probe_args[@]}"

echo "Checking gateway RPC status..."
status_start="$(node -e "process.stdout.write(String(Date.now()))")"
if ! afora_e2e_maybe_timeout "$command_timeout" afora gateway status --url "ws://127.0.0.1:$PORT" --token "$GATEWAY_AUTH_TOKEN_REF" --require-rpc --timeout 30000 --json >/tmp/afora-upgrade-survivor-status.json 2>/tmp/afora-upgrade-survivor-status.err; then
  echo "gateway status failed" >&2
  afora_e2e_print_log /tmp/afora-upgrade-survivor-status.err >&2
  afora_e2e_print_log "$GATEWAY_LOG" >&2
  afora_e2e_print_log "$SYSTEMCTL_SHIM_DAEMON_LOG" >&2
  exit 1
fi
status_end="$(node -e "process.stdout.write(String(Date.now()))")"
status_seconds=$(((status_end - status_start + 999) / 1000))
if [ "$status_seconds" -gt "$STATUS_BUDGET" ]; then
  echo "gateway status exceeded survivor budget: ${status_seconds}s > ${STATUS_BUDGET}s" >&2
  afora_e2e_print_log /tmp/afora-upgrade-survivor-status.json >&2
  exit 1
fi
node scripts/e2e/lib/upgrade-survivor/assertions.mjs assert-status-json /tmp/afora-upgrade-survivor-status.json

echo "Upgrade survivor Docker E2E passed scenario=${AFORA_UPGRADE_SURVIVOR_SCENARIO:-base} updateRestartMode=${UPDATE_RESTART_MODE} startup=${startup_summary} status=${status_seconds}s."
'
