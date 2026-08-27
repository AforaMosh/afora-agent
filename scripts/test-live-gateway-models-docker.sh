#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="${AFORA_LIVE_DOCKER_REPO_ROOT:-$SCRIPT_ROOT_DIR}"
ROOT_DIR="$(cd "$ROOT_DIR" && pwd)"
TRUSTED_HARNESS_DIR="${AFORA_LIVE_DOCKER_TRUSTED_HARNESS_DIR:-$SCRIPT_ROOT_DIR}"
if [[ -z "$TRUSTED_HARNESS_DIR" || ! -d "$TRUSTED_HARNESS_DIR" ]]; then
  echo "ERROR: trusted live Docker harness directory not found: ${TRUSTED_HARNESS_DIR:-<empty>}." >&2
  exit 1
fi
TRUSTED_HARNESS_DIR="$(cd "$TRUSTED_HARNESS_DIR" && pwd)"
source "$TRUSTED_HARNESS_DIR/scripts/lib/live-docker-auth.sh"
IMAGE_NAME="${AFORA_IMAGE:-afora:local}"
LIVE_IMAGE_NAME="${AFORA_LIVE_IMAGE:-${IMAGE_NAME}-live}"
CONFIG_DIR="${AFORA_CONFIG_DIR:-$HOME/.afora}"
WORKSPACE_DIR="${AFORA_WORKSPACE_DIR:-$HOME/.afora/workspace}"
PROFILE_FILE="$(afora_live_default_profile_file)"
LIVE_GATEWAY_MAX_MODELS="$(afora_live_read_positive_int_env AFORA_LIVE_GATEWAY_MAX_MODELS 8)"
LIVE_GATEWAY_STEP_TIMEOUT_MS="$(afora_live_read_positive_int_env AFORA_LIVE_GATEWAY_STEP_TIMEOUT_MS 45000)"
LIVE_GATEWAY_MODEL_TIMEOUT_MS="$(afora_live_read_positive_int_env AFORA_LIVE_GATEWAY_MODEL_TIMEOUT_MS 90000)"
DOCKER_AUTH_PRESTAGED=0
DOCKER_TRUSTED_HARNESS_CONTAINER_DIR="/trusted-harness"
DOCKER_TRUSTED_HARNESS_MOUNT=(-v "$TRUSTED_HARNESS_DIR":"$DOCKER_TRUSTED_HARNESS_CONTAINER_DIR":ro)
afora_live_init_temp_dirs
afora_live_init_cache_home_dir
afora_live_init_managed_home
afora_live_init_profile_mount

afora_live_collect_auth_for_providers "${AFORA_LIVE_GATEWAY_PROVIDERS:-}"
afora_live_finalize_auth_mounts
CONTAINER_NODE_OPTIONS="$(afora_live_container_node_options)"

read -r -d '' LIVE_TEST_CMD <<'EOF' || true
set -euo pipefail
[ -f "$HOME/.profile" ] && [ -r "$HOME/.profile" ] && source "$HOME/.profile" || true
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export COREPACK_HOME="${COREPACK_HOME:-$XDG_CACHE_HOME/node/corepack}"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$XDG_CACHE_HOME/npm}"
export npm_config_cache="$NPM_CONFIG_CACHE"
mkdir -p "$XDG_CACHE_HOME" "$COREPACK_HOME" "$NPM_CONFIG_CACHE"
chmod 700 "$XDG_CACHE_HOME" "$COREPACK_HOME" "$NPM_CONFIG_CACHE" || true
tmp_dir="$(mktemp -d)"
trusted_scripts_dir="${AFORA_LIVE_DOCKER_SCRIPTS_DIR:-/src/scripts}"
source "$trusted_scripts_dir/lib/live-docker-stage.sh"
afora_live_stage_mounted_auth
afora_live_stage_source_tree "$tmp_dir"
afora_live_stage_node_modules "$tmp_dir"
afora_live_link_runtime_tree "$tmp_dir"
afora_live_stage_state_dir "$tmp_dir/.afora-state"
afora_live_prepare_staged_config
cd "$tmp_dir"
if [[ -f scripts/test-live.mjs ]]; then
  node scripts/test-live.mjs -- src/gateway/gateway-models.profiles.live.test.ts
else
  node --import tsx scripts/test-live.mts -- src/gateway/gateway-models.profiles.live.test.ts
fi
EOF

AFORA_LIVE_DOCKER_REPO_ROOT="$ROOT_DIR" "$TRUSTED_HARNESS_DIR/scripts/test-live-build-docker.sh"
if afora_live_uses_managed_bind_dirs; then
  afora_live_chown_bind_dirs_for_container_user \
    "$LIVE_IMAGE_NAME" \
    "$DOCKER_USER" \
    "$CACHE_HOME_DIR" \
    "${DOCKER_HOME_DIR:-}"
fi

echo "==> Run gateway live model tests (profile keys)"
echo "==> Target: src/gateway/gateway-models.profiles.live.test.ts"
echo "==> Profile file: $PROFILE_STATUS"
echo "==> External auth dirs: ${AUTH_DIRS_CSV:-none}"
echo "==> External auth files: ${AUTH_FILES_CSV:-none}"
DOCKER_RUN_ARGS=()
afora_live_init_docker_run_args DOCKER_RUN_ARGS "${AFORA_LIVE_GATEWAY_DOCKER_RUN_TIMEOUT:-2100s}"
DOCKER_RUN_ARGS+=(--rm -t \
  -u "$DOCKER_USER" \
  --entrypoint bash \
  -e OPENAI_API_KEY \
  -e OPENAI_BASE_URL \
  -e ANTHROPIC_API_KEY \
  -e GEMINI_API_KEY \
  -e GOOGLE_API_KEY \
  -e MINIMAX_API_KEY \
  -e OPENROUTER_API_KEY \
  -e FIREWORKS_API_KEY \
  -e DEEPSEEK_API_KEY \
  -e XAI_API_KEY \
  -e ZAI_API_KEY \
  -e Z_AI_API_KEY \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e HOME=/home/node \
  -e NODE_OPTIONS="$CONTAINER_NODE_OPTIONS" \
  -e AFORA_SKIP_CHANNELS=1 \
  -e AFORA_SUPPRESS_NOTES=1 \
  -e AFORA_DOCKER_AUTH_PRESTAGED="$DOCKER_AUTH_PRESTAGED" \
  -e AFORA_DOCKER_AUTH_DIRS_RESOLVED="$AUTH_DIRS_CSV" \
  -e AFORA_DOCKER_AUTH_FILES_RESOLVED="$AUTH_FILES_CSV" \
  -e AFORA_LIVE_DOCKER_SCRIPTS_DIR="${DOCKER_TRUSTED_HARNESS_CONTAINER_DIR}/scripts" \
  -e AFORA_LIVE_DOCKER_SOURCE_STAGE_MODE="${AFORA_LIVE_DOCKER_SOURCE_STAGE_MODE:-copy}" \
  -e AFORA_LIVE_TEST=1 \
  -e AFORA_LIVE_TEST_QUIET="${AFORA_LIVE_TEST_QUIET:-}" \
  -e AFORA_LIVE_WRAPPER_HEARTBEAT_MS="${AFORA_LIVE_WRAPPER_HEARTBEAT_MS:-}" \
  -e AFORA_LIVE_REQUIRE_PROFILE_KEYS="${AFORA_LIVE_REQUIRE_PROFILE_KEYS:-}" \
  -e AFORA_LIVE_GATEWAY_MODELS="${AFORA_LIVE_GATEWAY_MODELS:-modern}" \
  -e AFORA_LIVE_GATEWAY_PROVIDERS="${AFORA_LIVE_GATEWAY_PROVIDERS:-}" \
  -e AFORA_LIVE_GATEWAY_THINKING="${AFORA_LIVE_GATEWAY_THINKING:-}" \
  -e AFORA_LIVE_GATEWAY_SMOKE="${AFORA_LIVE_GATEWAY_SMOKE:-1}" \
  -e AFORA_LIVE_GATEWAY_MAX_MODELS="$LIVE_GATEWAY_MAX_MODELS" \
  -e AFORA_LIVE_GATEWAY_HEARTBEAT_MS="${AFORA_LIVE_GATEWAY_HEARTBEAT_MS:-}" \
  -e AFORA_LIVE_GATEWAY_STEP_TIMEOUT_MS="$LIVE_GATEWAY_STEP_TIMEOUT_MS" \
  -e AFORA_LIVE_GATEWAY_MODEL_TIMEOUT_MS="$LIVE_GATEWAY_MODEL_TIMEOUT_MS" \
  -e AFORA_VITEST_FS_MODULE_CACHE=0)
afora_live_append_array DOCKER_RUN_ARGS DOCKER_HOME_MOUNT
afora_live_append_array DOCKER_RUN_ARGS DOCKER_TRUSTED_HARNESS_MOUNT
DOCKER_RUN_ARGS+=(\
  -v "$CACHE_HOME_DIR":/home/node/.cache \
  -v "$ROOT_DIR":/src:ro \
  -v "$CONFIG_DIR":/home/node/.afora \
  -v "$WORKSPACE_DIR":/home/node/.afora/workspace)
afora_live_append_array DOCKER_RUN_ARGS EXTERNAL_AUTH_MOUNTS
afora_live_append_array DOCKER_RUN_ARGS PROFILE_MOUNT
DOCKER_RUN_ARGS+=(\
  "$LIVE_IMAGE_NAME" \
  -lc "$LIVE_TEST_CMD")
"${DOCKER_RUN_ARGS[@]}"
