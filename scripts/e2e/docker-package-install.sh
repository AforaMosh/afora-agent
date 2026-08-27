#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "afora-docker-e2e-bare:local")"
PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz docker-package-install "${AFORA_CURRENT_PACKAGE_TGZ:-}")"
IDENTITY_PATH="${AFORA_DOCKER_ARTIFACT_IDENTITY_PATH:-$ROOT_DIR/.artifacts/docker-tests/docker-package-install-identities.json}"
NPM_PROOF_CONTAINER="afora-package-npm-proof-$$"
PNPM_PROOF_CONTAINER="afora-package-pnpm-proof-$$"
BUN_PROOF_CONTAINER="afora-package-bun-proof-$$"
DOCKER_RUN_TIMEOUT="${AFORA_DOCKER_PACKAGE_INSTALL_RUN_TIMEOUT:-120s}"
BUN_HARNESS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/afora-bun-harness.XXXXXX")"

cleanup() {
  docker_e2e_docker_cmd rm -f \
    "$NPM_PROOF_CONTAINER" \
    "$PNPM_PROOF_CONTAINER" \
    "$BUN_PROOF_CONTAINER" >/dev/null 2>&1 || true
  docker_e2e_cleanup_package_tgz "$PACKAGE_TGZ"
  rm -rf "$BUN_HARNESS_DIR"
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" docker-package-install "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" bare

for harness_path in \
  scripts/e2e/bun-global-install-smoke.sh \
  scripts/e2e/lib/bun-global-install/assertions.mjs \
  scripts/lib/docker-e2e-container.sh \
  scripts/lib/docker-e2e-logs.sh \
  scripts/lib/docker-e2e-package.sh \
  scripts/lib/docker-e2e-resource-diagnostics.sh; do
  mkdir -p "$BUN_HARNESS_DIR/$(dirname "$harness_path")"
  cp "$ROOT_DIR/$harness_path" "$BUN_HARNESS_DIR/$harness_path"
done
chmod -R a+rX "$BUN_HARNESS_DIR"

echo "Installing the real Afora package artifact with npm..."
DOCKER_COMMAND_TIMEOUT="$DOCKER_RUN_TIMEOUT" docker_e2e_docker_run_cmd run -d \
  --name "$NPM_PROOF_CONTAINER" \
  -v "$PACKAGE_TGZ:/tmp/afora-current.tgz:ro" \
  "$IMAGE_NAME" \
  bash -lc '
    set -euo pipefail
    npm install -g --prefix /tmp/afora-proof /tmp/afora-current.tgz --no-fund --no-audit
    export PATH="/tmp/afora-proof/bin:$PATH"
    package_root=/tmp/afora-proof/lib/node_modules/afora
    test "$(command -v afora)" = "/tmp/afora-proof/bin/afora"
    afora --version > /tmp/afora-version
    afora --help > /tmp/afora-help
    test -s /tmp/afora-help
    touch /tmp/afora-proof-ready
    exec sleep infinity
  ' >/dev/null

echo "Installing the real Afora package artifact with pnpm..."
DOCKER_COMMAND_TIMEOUT="$DOCKER_RUN_TIMEOUT" docker_e2e_docker_run_cmd run -d \
  --name "$PNPM_PROOF_CONTAINER" \
  -v "$PACKAGE_TGZ:/tmp/afora-current.tgz:ro" \
  "$IMAGE_NAME" \
  bash -lc '
    set -euo pipefail
    export PNPM_HOME=/tmp/pnpm-home
    export PATH="$PNPM_HOME:$PATH"
    corepack prepare pnpm@11.15.1 --activate
    pnpm config set global-bin-dir "$PNPM_HOME"
    pnpm config set global-dir /tmp/pnpm-global
    pnpm add --global --allow-build=afora /tmp/afora-current.tgz
    test "$(command -v afora)" = "$PNPM_HOME/afora"
    package_root="$(pnpm root --global)/afora"
    printf "%s\n" "$package_root" > /tmp/afora-package-root
    afora --version > /tmp/afora-version
    afora --help > /tmp/afora-help
    test -s /tmp/afora-help
    touch /tmp/afora-proof-ready
    exec sleep infinity
  ' >/dev/null

echo "Installing the real Afora package artifact with Bun..."
DOCKER_COMMAND_TIMEOUT="$DOCKER_RUN_TIMEOUT" docker_e2e_docker_run_cmd run -d \
  --name "$BUN_PROOF_CONTAINER" \
  -v "$PACKAGE_TGZ:/tmp/afora-current.tgz:ro" \
  -v "$BUN_HARNESS_DIR:/repo:ro" \
  "$IMAGE_NAME" \
  bash -lc '
    set -euo pipefail
    npm install -g --prefix /tmp/bun-runtime bun@1.3.14 --no-fund --no-audit
    cd /repo
    BUN_BIN=/tmp/bun-runtime/bin/bun \
      AFORA_BUN_GLOBAL_SMOKE_HOST_BUILD=0 \
      AFORA_BUN_GLOBAL_SMOKE_PACKAGE_TGZ=/tmp/afora-current.tgz \
      AFORA_BUN_GLOBAL_SMOKE_PROOF_PATH=/tmp/afora-bun-proof.json \
      bash scripts/e2e/bun-global-install-smoke.sh
    touch /tmp/afora-proof-ready
    exec sleep infinity
  ' >/dev/null

wait_for_proof() {
  local container_name="$1"
  for _ in $(seq 1 240); do
    if docker exec "$container_name" test -f /tmp/afora-proof-ready; then
      return 0
    fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$container_name")" != "true" ]; then
      docker logs "$container_name" >&2
      return 1
    fi
    sleep 1
  done
  docker logs "$container_name" >&2
  return 1
}

for container_name in "$NPM_PROOF_CONTAINER" "$PNPM_PROOF_CONTAINER" "$BUN_PROOF_CONTAINER"; do
  wait_for_proof "$container_name"
done

NPM_PACKAGE_ROOT="/tmp/afora-proof/lib/node_modules/afora"
NPM_INSTALLED_VERSION="$(docker exec "$NPM_PROOF_CONTAINER" cat /tmp/afora-version | tr -d '\r\n')"
PNPM_PACKAGE_ROOT="$(docker exec "$PNPM_PROOF_CONTAINER" cat /tmp/afora-package-root | tr -d '\r\n')"
PNPM_INSTALLED_VERSION="$(docker exec "$PNPM_PROOF_CONTAINER" cat /tmp/afora-version | tr -d '\r\n')"
BUN_AFORA_PATH="$(
  docker exec "$BUN_PROOF_CONTAINER" \
    node -p 'JSON.parse(require("node:fs").readFileSync("/tmp/afora-bun-proof.json", "utf8")).aforaPath'
)"
BUN_INSTALLED_VERSION="$(
  docker exec "$BUN_PROOF_CONTAINER" \
    node -p 'JSON.parse(require("node:fs").readFileSync("/tmp/afora-bun-proof.json", "utf8")).aforaVersion'
)"
PACKAGE_VERSION="$(docker exec "$NPM_PROOF_CONTAINER" node -p "require('$NPM_PACKAGE_ROOT/package.json').version")"
for installed_version in "$NPM_INSTALLED_VERSION" "$PNPM_INSTALLED_VERSION" "$BUN_INSTALLED_VERSION"; do
  if [[ "$installed_version" != *"$PACKAGE_VERSION"* ]]; then
    echo "installed CLI output $installed_version does not contain package version $PACKAGE_VERSION" >&2
    exit 1
  fi
done

node --import tsx "$ROOT_DIR/scripts/e2e/lib/docker-artifact-proof/write-identities.ts" \
  --scenario docker-package-install \
  --output "$IDENTITY_PATH" \
  --image "$IMAGE_NAME" \
  --package "$PACKAGE_TGZ" \
  --container "npm=$NPM_PROOF_CONTAINER" \
  --container "pnpm=$PNPM_PROOF_CONTAINER" \
  --container "bun=$BUN_PROOF_CONTAINER" \
  --detail "npm:installedPackageRoot=$NPM_PACKAGE_ROOT" \
  --detail "npm:installedPackageVersion=$PACKAGE_VERSION" \
  --detail "npm:aforaVersion=$NPM_INSTALLED_VERSION" \
  --detail "npm:aforaPath=/tmp/afora-proof/bin/afora" \
  --detail "npm:helpCommand=passed" \
  --detail "pnpm:installedPackageRoot=$PNPM_PACKAGE_ROOT" \
  --detail "pnpm:installedPackageVersion=$PACKAGE_VERSION" \
  --detail "pnpm:aforaVersion=$PNPM_INSTALLED_VERSION" \
  --detail "pnpm:aforaPath=/tmp/pnpm-home/afora" \
  --detail "pnpm:helpCommand=passed" \
  --detail "bun:installedPackageVersion=$PACKAGE_VERSION" \
  --detail "bun:aforaVersion=$BUN_INSTALLED_VERSION" \
  --detail "bun:aforaPath=$BUN_AFORA_PATH" \
  --detail "bun:helpCommand=passed"

echo "npm, pnpm, and Bun package artifact proofs passed."
