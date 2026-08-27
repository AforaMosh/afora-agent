#!/usr/bin/env bash
# Exercises package-to-git and git-to-package update channel switching in Docker.
# Both package and git fixtures are derived from the same prepared npm tarball.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "afora-update-channel-switch-e2e" AFORA_UPDATE_CHANNEL_SWITCH_E2E_IMAGE)"
SKIP_BUILD="${AFORA_UPDATE_CHANNEL_SWITCH_E2E_SKIP_BUILD:-0}"
cleanup() {
  docker_e2e_cleanup_package_tgz "${PACKAGE_TGZ:-}"
}
trap cleanup EXIT

PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz update-channel-switch "${AFORA_CURRENT_PACKAGE_TGZ:-}")"
# Bare lanes mount the package artifact instead of baking app sources into the image.
docker_e2e_package_mount_args "$PACKAGE_TGZ"
AFORA_TEST_STATE_SCRIPT_B64="$(
  node --import tsx "$ROOT_DIR/scripts/lib/afora-test-state.mts" shell \
    --label update-channel-switch \
    --scenario update-stable |
    base64 |
    tr -d '\n'
)"

docker_e2e_build_or_reuse "$IMAGE_NAME" update-channel-switch "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "bare" "$SKIP_BUILD"

echo "Running update channel switch E2E..."
docker_e2e_run_with_harness \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e AFORA_SKIP_CHANNELS=1 \
  -e AFORA_SKIP_PROVIDERS=1 \
  -e "AFORA_TEST_STATE_SCRIPT_B64=$AFORA_TEST_STATE_SCRIPT_B64" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  "$IMAGE_NAME" \
  bash -lc 'set -euo pipefail
source scripts/lib/afora-e2e-instance.sh

export npm_config_loglevel=error
export npm_config_fund=false
export npm_config_audit=false
export npm_config_prefix=/tmp/npm-prefix
export NPM_CONFIG_PREFIX=/tmp/npm-prefix
export PNPM_HOME=/tmp/pnpm-home
export PATH="/tmp/npm-prefix/bin:/tmp/pnpm-home:$PATH"
export CI=true
export AFORA_DISABLE_BUNDLED_PLUGINS=1
export AFORA_NO_ONBOARD=1
export AFORA_NO_PROMPT=1

package_tgz="${AFORA_CURRENT_PACKAGE_TGZ:?missing AFORA_CURRENT_PACKAGE_TGZ}"
git_root="/tmp/afora-git"
mkdir -p "$git_root"
# Build the fake git install from the packed package contents, not the checkout.
tar -xzf "$package_tgz" -C "$git_root" --strip-components=1
node scripts/e2e/lib/package-git-fixture.mjs prepare "$git_root"
# The package-derived fixture can carry patchedDependencies whose targets are
# absent from the trimmed tarball install; that should not block update preflight.
node scripts/e2e/lib/update-channel-switch/assertions.mjs prepare-git-fixture "$git_root"
(
  cd "$git_root"
  if ! afora_e2e_maybe_timeout "${AFORA_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install --omit=optional --no-fund --no-audit >/tmp/afora-git-install.log 2>&1; then
    afora_e2e_print_log /tmp/afora-git-install.log >&2
    exit 1
  fi
)
node scripts/e2e/lib/update-channel-switch/assertions.mjs write-control-ui "$git_root"

git config --global user.email "docker-e2e@afora.local"
git config --global user.name "Afora Docker E2E"
git config --global gc.auto 0
git -C "$git_root" init -q
git -C "$git_root" config gc.auto 0
git -C "$git_root" add -A
git -C "$git_root" add -f dist/control-ui/index.html
git -C "$git_root" commit -qm "test fixture"
fixture_sha="$(git -C "$git_root" rev-parse HEAD)"

pkg_tgz_path="$package_tgz"

package_install_log="/tmp/afora-update-channel-switch-package-install.log"
if ! afora_e2e_maybe_timeout "${AFORA_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install -g --prefix /tmp/npm-prefix --omit=optional "$pkg_tgz_path" >"$package_install_log" 2>&1; then
  afora_e2e_print_log "$package_install_log" >&2
  exit 1
fi
package_version="$(node -p "JSON.parse(require(\"node:fs\").readFileSync(\"/tmp/npm-prefix/lib/node_modules/afora/package.json\", \"utf8\")).version")"
AFORA_PACKAGE_ACCEPTANCE_LEGACY_COMPAT="$(
  node scripts/e2e/lib/package-compat.mjs "$package_version"
)"
export AFORA_PACKAGE_ACCEPTANCE_LEGACY_COMPAT
command -v afora >/dev/null
afora_e2e_enable_afora_cli_timeout

registry_port_file=/tmp/afora-update-channel-registry.port
registry_log=/tmp/afora-update-channel-registry.log
registry_pid=""
cleanup_registry() {
  if [ -n "$registry_pid" ]; then
    kill "$registry_pid" 2>/dev/null || true
    wait "$registry_pid" 2>/dev/null || true
  fi
}
trap cleanup_registry EXIT
rm -f "$registry_port_file"
AFORA_NPM_REGISTRY_DIST_TAGS="latest=0.0.0,beta=$package_version" \
  AFORA_NPM_REGISTRY_UPSTREAM=https://registry.npmjs.org \
  node scripts/e2e/lib/plugins/npm-registry-server.mjs \
    "$registry_port_file" \
    afora \
    "$package_version" \
    "$package_tgz" \
    >"$registry_log" 2>&1 &
registry_pid="$!"
for _ in $(seq 1 100); do
  if [ -s "$registry_port_file" ]; then
    break
  fi
  if ! kill -0 "$registry_pid" 2>/dev/null; then
    afora_e2e_print_log "$registry_log" >&2
    exit 1
  fi
  sleep 0.1
done
if [ ! -s "$registry_port_file" ]; then
  afora_e2e_print_log "$registry_log" >&2
  echo "Timed out waiting for update-channel npm fixture registry." >&2
  exit 1
fi
export NPM_CONFIG_REGISTRY="http://127.0.0.1:$(cat "$registry_port_file")"
export npm_config_registry="$NPM_CONFIG_REGISTRY"

afora_e2e_eval_test_state_from_b64 "${AFORA_TEST_STATE_SCRIPT_B64:?missing AFORA_TEST_STATE_SCRIPT_B64}"

export AFORA_GIT_DIR="$git_root"
export AFORA_UPDATE_DEV_TARGET_REF="$fixture_sha"

echo "==> package stable -> package beta channel"
set +e
beta_json="$(afora update --channel beta --yes --json --no-restart)"
beta_status=$?
set -e
printf "%s\n" "$beta_json"
if [ "$beta_status" -ne 0 ]; then
  exit "$beta_status"
fi
UPDATE_JSON="$beta_json" node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-update beta
node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-config-channel beta
node scripts/e2e/lib/update-channel-switch/assertions.mjs \
  assert-installed-version \
  /tmp/npm-prefix/lib/node_modules/afora \
  "$package_version"

status_json="$(afora update status --json)"
printf "%s\n" "$status_json"
STATUS_JSON="$status_json" node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-status-kind package

echo "==> package -> git dev channel"
set +e
dev_json="$(afora update --channel dev --yes --json --no-restart)"
dev_status=$?
set -e
printf "%s\n" "$dev_json"
if [ "$dev_status" -ne 0 ]; then
  exit "$dev_status"
fi
UPDATE_JSON="$dev_json" node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-update dev
node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-config-channel dev

status_json="$(afora update status --json)"
printf "%s\n" "$status_json"
STATUS_JSON="$status_json" node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-status-kind git

echo "==> git -> package stable channel"
set +e
stable_json="$(afora update --channel stable --tag "$pkg_tgz_path" --yes --json --no-restart)"
stable_status=$?
set -e
printf "%s\n" "$stable_json"
if [ "$stable_status" -ne 0 ]; then
  exit "$stable_status"
fi
UPDATE_JSON="$stable_json" node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-update stable
node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-config-channel stable

status_json="$(afora update status --json)"
printf "%s\n" "$status_json"
STATUS_JSON="$status_json" node scripts/e2e/lib/update-channel-switch/assertions.mjs assert-status-kind package

echo "OK"
'
