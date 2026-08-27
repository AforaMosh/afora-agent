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
DOCKER_EXTRA_ENV_FILES=()
DOCKER_TRUSTED_HARNESS_CONTAINER_DIR="/trusted-harness"
DOCKER_TRUSTED_HARNESS_MOUNT=(-v "$TRUSTED_HARNESS_DIR":"$DOCKER_TRUSTED_HARNESS_CONTAINER_DIR":ro)
afora_live_init_temp_dirs
afora_live_init_cache_home_dir
afora_live_init_managed_home
afora_live_init_profile_mount

if [[ -n "${OPENAI_API_KEY:-}" || -n "${OPENAI_BASE_URL:-}" || -n "${GEMINI_API_KEY:-}" || -n "${GOOGLE_API_KEY:-}" ]]; then
  docker_env_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/afora-subagent-live-env.XXXXXX")"
  TEMP_DIRS+=("$docker_env_dir")
  docker_env_file="$docker_env_dir/provider.env"
  {
    if [[ -n "${OPENAI_API_KEY:-}" ]]; then
      printf 'AFORA_DOCKER_LIVE_OPENAI_API_KEY=%s\n' "${OPENAI_API_KEY}"
    fi
    if [[ -n "${OPENAI_BASE_URL:-}" ]]; then
      printf 'AFORA_DOCKER_LIVE_OPENAI_BASE_URL=%s\n' "${OPENAI_BASE_URL}"
    fi
    if [[ -n "${GEMINI_API_KEY:-}" ]]; then
      printf 'AFORA_DOCKER_LIVE_GEMINI_API_KEY=%s\n' "${GEMINI_API_KEY}"
    fi
    if [[ -n "${GOOGLE_API_KEY:-}" ]]; then
      printf 'AFORA_DOCKER_LIVE_GOOGLE_API_KEY=%s\n' "${GOOGLE_API_KEY}"
    fi
  } >"$docker_env_file"
  DOCKER_EXTRA_ENV_FILES+=(--env-file "$docker_env_file")
fi

CONTAINER_NODE_OPTIONS="$(afora_live_container_node_options)"

read -r -d '' LIVE_TEST_CMD <<'EOF' || true
set -euo pipefail
[ -f "$HOME/.profile" ] && [ -r "$HOME/.profile" ] && source "$HOME/.profile" || true
if [ -n "${AFORA_DOCKER_LIVE_OPENAI_API_KEY:-}" ]; then
  export OPENAI_API_KEY="$AFORA_DOCKER_LIVE_OPENAI_API_KEY"
  unset AFORA_DOCKER_LIVE_OPENAI_API_KEY
fi
if [ -n "${AFORA_DOCKER_LIVE_OPENAI_BASE_URL:-}" ]; then
  export OPENAI_BASE_URL="$AFORA_DOCKER_LIVE_OPENAI_BASE_URL"
  unset AFORA_DOCKER_LIVE_OPENAI_BASE_URL
fi
if [ -n "${AFORA_DOCKER_LIVE_GEMINI_API_KEY:-}" ]; then
  export GEMINI_API_KEY="$AFORA_DOCKER_LIVE_GEMINI_API_KEY"
  unset AFORA_DOCKER_LIVE_GEMINI_API_KEY
fi
if [ -n "${AFORA_DOCKER_LIVE_GOOGLE_API_KEY:-}" ]; then
  export GOOGLE_API_KEY="$AFORA_DOCKER_LIVE_GOOGLE_API_KEY"
  unset AFORA_DOCKER_LIVE_GOOGLE_API_KEY
fi
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export COREPACK_HOME="${COREPACK_HOME:-$XDG_CACHE_HOME/node/corepack}"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$XDG_CACHE_HOME/npm}"
export npm_config_cache="$NPM_CONFIG_CACHE"
mkdir -p "$XDG_CACHE_HOME" "$COREPACK_HOME" "$NPM_CONFIG_CACHE"
chmod 700 "$XDG_CACHE_HOME" "$COREPACK_HOME" "$NPM_CONFIG_CACHE" || true
tmp_dir="$(mktemp -d)"
trusted_scripts_dir="${AFORA_LIVE_DOCKER_SCRIPTS_DIR:-/src/scripts}"
source "$trusted_scripts_dir/lib/live-docker-stage.sh"
afora_live_stage_source_tree "$tmp_dir"
afora_live_stage_node_modules "$tmp_dir"
afora_live_link_runtime_tree "$tmp_dir"
afora_live_stage_state_dir "$tmp_dir/.afora-state"
afora_live_prepare_staged_config
cd "$tmp_dir"
AFORA_LIVE_TEST=1 \
AFORA_LIVE_SUBAGENT_E2E=1 \
AFORA_VITEST_MAX_WORKERS="${AFORA_VITEST_MAX_WORKERS:-1}" \
node --import tsx scripts/test-live.mts -- src/agents/subagents/announce/subagent-announce.live.test.ts -- --reporter=verbose
EOF

AFORA_LIVE_DOCKER_REPO_ROOT="$ROOT_DIR" "$TRUSTED_HARNESS_DIR/scripts/test-live-build-docker.sh"
if afora_live_uses_managed_bind_dirs; then
  afora_live_chown_bind_dirs_for_container_user \
    "$LIVE_IMAGE_NAME" \
    "$DOCKER_USER" \
    "$CACHE_HOME_DIR" \
    "${DOCKER_HOME_DIR:-}"
fi

echo "==> Run subagent announce live test in Docker"
echo "==> Target: src/agents/subagents/announce/subagent-announce.live.test.ts"
echo "==> Model: ${AFORA_LIVE_SUBAGENT_E2E_MODEL:-openai/gpt-5.6-luna}"
echo "==> Profile file: $PROFILE_STATUS"
DOCKER_RUN_ARGS=()
afora_live_init_docker_run_args DOCKER_RUN_ARGS "${AFORA_LIVE_SUBAGENT_DOCKER_RUN_TIMEOUT:-1200s}"
DOCKER_RUN_ARGS+=(--rm -t \
  -u "$DOCKER_USER" \
  --entrypoint bash \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e HOME=/home/node \
  -e NODE_OPTIONS="$CONTAINER_NODE_OPTIONS" \
  -e AFORA_SKIP_CHANNELS=1 \
  -e AFORA_SUPPRESS_NOTES=1 \
  -e AFORA_LIVE_DOCKER_SCRIPTS_DIR="${DOCKER_TRUSTED_HARNESS_CONTAINER_DIR}/scripts" \
  -e AFORA_LIVE_DOCKER_SOURCE_STAGE_MODE="${AFORA_LIVE_DOCKER_SOURCE_STAGE_MODE:-copy}" \
  -e AFORA_LIVE_TEST=1 \
  -e AFORA_LIVE_TEST_QUIET="${AFORA_LIVE_TEST_QUIET:-}" \
  -e AFORA_LIVE_WRAPPER_HEARTBEAT_MS="${AFORA_LIVE_WRAPPER_HEARTBEAT_MS:-}" \
  -e AFORA_LIVE_SUBAGENT_E2E=1 \
  -e AFORA_LIVE_SUBAGENT_E2E_MODEL="${AFORA_LIVE_SUBAGENT_E2E_MODEL:-}" \
  -e AFORA_VITEST_FS_MODULE_CACHE=0 \
  -e AFORA_VITEST_MAX_WORKERS="${AFORA_VITEST_MAX_WORKERS:-1}")
afora_live_append_array DOCKER_RUN_ARGS DOCKER_EXTRA_ENV_FILES
afora_live_append_array DOCKER_RUN_ARGS DOCKER_HOME_MOUNT
afora_live_append_array DOCKER_RUN_ARGS DOCKER_TRUSTED_HARNESS_MOUNT
DOCKER_RUN_ARGS+=(\
  -v "$CACHE_HOME_DIR":/home/node/.cache \
  -v "$ROOT_DIR":/src:ro \
  -v "$CONFIG_DIR":/home/node/.afora \
  -v "$WORKSPACE_DIR":/home/node/.afora/workspace)
afora_live_append_array DOCKER_RUN_ARGS PROFILE_MOUNT
DOCKER_RUN_ARGS+=(\
  "$LIVE_IMAGE_NAME" \
  -lc "$LIVE_TEST_CMD")
"${DOCKER_RUN_ARGS[@]}"
