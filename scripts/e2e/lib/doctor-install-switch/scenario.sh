#!/usr/bin/env bash
set -euo pipefail
source scripts/lib/afora-e2e-instance.sh
afora_e2e_eval_test_state_from_b64 "${AFORA_TEST_STATE_FUNCTION_B64:?missing AFORA_TEST_STATE_FUNCTION_B64}"

# Keep logs focused; the npm global install step can emit noisy deprecation warnings.
export npm_config_loglevel=error
export npm_config_fund=false
export npm_config_audit=false
export AFORA_DISABLE_BUNDLED_PLUGINS=1

# Stub systemd/loginctl so doctor + daemon flows work in Docker.
export PATH="/tmp/afora-bin:$PATH"
mkdir -p /tmp/afora-bin
cp scripts/e2e/lib/doctor-install-switch/shims/systemctl /tmp/afora-bin/systemctl
cp scripts/e2e/lib/doctor-install-switch/shims/loginctl /tmp/afora-bin/loginctl
chmod +x /tmp/afora-bin/systemctl /tmp/afora-bin/loginctl

package_tgz="${AFORA_CURRENT_PACKAGE_TGZ:?missing AFORA_CURRENT_PACKAGE_TGZ}"
git_root="/tmp/afora-git"
mkdir -p "$git_root"
# The git-style install fixture is unpacked from the tarball so this lane does
# not depend on checkout source files being present in the Docker image.
tar -xzf "$package_tgz" -C "$git_root" --strip-components=1
node scripts/e2e/lib/package-git-fixture.mjs prepare "$git_root"
(
  cd "$git_root"
  afora_e2e_maybe_timeout "${AFORA_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install --omit=optional --no-fund --no-audit >/tmp/afora-git-install.log 2>&1
  git init -q
  git config user.email "docker-e2e@afora.local"
  git config user.name "Afora Docker E2E"
  git add -A --
  git commit -qm "test fixture"
)
npm_log="/tmp/afora-doctor-switch-npm-install.log"
if ! afora_e2e_maybe_timeout "${AFORA_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install -g --prefix /tmp/npm-prefix --omit=optional "$package_tgz" >"$npm_log" 2>&1; then
  afora_e2e_print_log "$npm_log"
  exit 1
fi

npm_bin="/tmp/npm-prefix/bin/afora"
npm_root="/tmp/npm-prefix/lib/node_modules/afora"
if [ -f "$npm_root/dist/index.mjs" ]; then
  npm_entry="$npm_root/dist/index.mjs"
else
  npm_entry="$npm_root/dist/index.js"
fi

if [ -f "$git_root/dist/index.mjs" ]; then
  git_entry="$git_root/dist/index.mjs"
else
  git_entry="$git_root/dist/index.js"
fi
git_cli="$git_root/afora.mjs"

package_version="$(node -p "require(\"$npm_root/package.json\").version")"
update_doctor_env="AFORA_UPDATE_IN_PROGRESS=1"
update_doctor_env+=" AFORA_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE=1"
update_doctor_env+=" AFORA_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART=1"
update_doctor_env+=" AFORA_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR=1"
update_doctor_env+=" AFORA_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION=0"

use_default_service_identity() {
  local account_home
  account_home="$(node -p 'require("node:os").userInfo().homedir')"

  # Service mutation is intentionally restricted to the OS account home. Keep
  # these disposable-container flows isolated without pretending a temp HOME owns it.
  rm -rf \
    "$account_home/.afora" \
    "$account_home/.config/systemd/user/afora-gateway.service" \
    "$account_home/.config/fish" \
    "$account_home/.config/powershell" \
    "$account_home/.local/bin/afora-wrapper" \
    "$account_home/afora-wrapper-argv.log"
  export HOME="$account_home"
  export USERPROFILE="$account_home"
  unset AFORA_HOME AFORA_STATE_DIR AFORA_CONFIG_PATH
}

is_legacy_package_acceptance_compat() {
  [ "$(node scripts/e2e/lib/package-compat.mjs "$1")" = "1" ]
}

assert_entrypoint() {
  local unit_path="$1"
  local expected="$2"
  local exec_line=""
  exec_line=$(grep -m1 "^ExecStart=" "$unit_path" || true)
  if [ -z "$exec_line" ]; then
    echo "Missing ExecStart in $unit_path"
    exit 1
  fi
  exec_line="${exec_line#ExecStart=}"
  entrypoint=$(echo "$exec_line" | awk "{print \$2}")
  entrypoint="${entrypoint%\"}"
  entrypoint="${entrypoint#\"}"
  if [ "$entrypoint" != "$expected" ]; then
    echo "Expected entrypoint $expected, got $entrypoint"
    exit 1
  fi
}

assert_exec_arg() {
  local unit_path="$1"
  local index="$2"
  local expected="$3"
  local exec_line=""
  local actual=""
  exec_line=$(grep -m1 "^ExecStart=" "$unit_path" || true)
  if [ -z "$exec_line" ]; then
    echo "Missing ExecStart in $unit_path"
    exit 1
  fi
  exec_line="${exec_line#ExecStart=}"
  actual=$(echo "$exec_line" | awk -v field="$index" "{print \$field}")
  actual="${actual%\"}"
  actual="${actual#\"}"
  if [ "$actual" != "$expected" ]; then
    echo "Expected ExecStart arg $index to be $expected, got $actual"
    cat "$unit_path"
    exit 1
  fi
}

assert_env_value() {
  local unit_path="$1"
  local key="$2"
  local expected="$3"
  if ! grep -Fxq "Environment=${key}=${expected}" "$unit_path"; then
    echo "Expected Environment=${key}=${expected} in $unit_path"
    cat "$unit_path"
    exit 1
  fi
}

assert_no_env_key() {
  local unit_path="$1"
  local key="$2"
  if grep -q "^Environment=${key}=" "$unit_path"; then
    echo "Expected no Environment=${key}= line in $unit_path"
    cat "$unit_path"
    exit 1
  fi
}

# Each flow: install service with one variant, run doctor from the other,
# and verify ExecStart entrypoint switches accordingly.
run_flow() {
  local name="$1"
  local install_cmd="$2"
  local install_expected="$3"
  local doctor_cmd="$4"
  local doctor_expected="$5"
  local install_log="/tmp/afora-doctor-switch-${name}-install.log"
  local doctor_log="/tmp/afora-doctor-switch-${name}-doctor.log"
  local command_timeout="${AFORA_DOCKER_DOCTOR_SWITCH_COMMAND_TIMEOUT:-900s}"

  echo "== Flow: $name =="
  afora_test_state_create "switch-${name}" empty
  use_default_service_identity
  export USER="testuser"

  if ! afora_e2e_maybe_timeout "$command_timeout" bash -c "$install_cmd" >"$install_log" 2>&1; then
    afora_e2e_print_log "$install_log"
    exit 1
  fi
  rm -f "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"
  rm -rf "$HOME/.config/fish" "$HOME/.config/powershell"

  unit_path="$HOME/.config/systemd/user/afora-gateway.service"
  if [ ! -f "$unit_path" ]; then
    echo "Missing unit file: $unit_path"
    exit 1
  fi
  assert_entrypoint "$unit_path" "$install_expected"

  if ! afora_e2e_maybe_timeout "$command_timeout" bash -c "$doctor_cmd" >"$doctor_log" 2>&1; then
    afora_e2e_print_log "$doctor_log"
    exit 1
  fi

  assert_entrypoint "$unit_path" "$doctor_expected"
}

run_flow \
  "npm-to-git" \
  "$npm_bin daemon install --force" \
  "$npm_entry" \
  "$update_doctor_env node $git_cli doctor --repair --force --yes --non-interactive" \
  "$git_entry"

run_flow \
  "git-to-npm" \
  "node $git_cli daemon install --force" \
  "$git_entry" \
  "$update_doctor_env $npm_bin doctor --repair --force --yes --non-interactive" \
  "$npm_entry"

plugin_binding_approval_count() {
  local database_path="$1"
  if [ ! -f "$database_path" ]; then
    echo "0"
    return
  fi
  node --no-warnings - "$database_path" <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const database = new DatabaseSync(process.argv[2]);
const table = database
  .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
  .get("plugin_binding_approvals");
const row = table
  ? database.prepare("SELECT COUNT(*) AS count FROM plugin_binding_approvals").get()
  : { count: 0 };
database.close();
process.stdout.write(String(row.count));
NODE
}

run_cross_state_approval_flow() {
  local name="cross-state-approvals"
  local automated_log="/tmp/afora-doctor-switch-${name}-automated.log"
  local direct_log="/tmp/afora-doctor-switch-${name}-direct.log"
  local command_timeout="${AFORA_DOCKER_DOCTOR_SWITCH_COMMAND_TIMEOUT:-900s}"

  echo "== Flow: $name =="
  afora_test_state_create "switch-${name}" empty
  export USER="testuser"

  local default_state_dir="$HOME/.afora"
  local custom_state_dir="$HOME/custom-state"
  local exec_source="$default_state_dir/exec-approvals.json"
  local plugin_source="$default_state_dir/plugin-binding-approvals.json"
  local state_database="$custom_state_dir/state/afora.sqlite"
  mkdir -p "$default_state_dir" "$custom_state_dir"
  printf '%s\n' '{"version":1,"socket":{"token":"legacy-token"},"defaults":{"security":"deny","ask":"always"}}' >"$exec_source"
  printf '%s\n' '{"version":1,"approvals":[{"pluginRoot":"/plugins/codex-a","pluginId":"codex","channel":"telegram","accountId":"default","approvedAt":2345}]}' >"$plugin_source"
  local exec_source_hash
  local plugin_source_hash
  exec_source_hash="$(sha256sum "$exec_source" | awk '{print $1}')"
  plugin_source_hash="$(sha256sum "$plugin_source" | awk '{print $1}')"

  if ! afora_e2e_maybe_timeout "$command_timeout" env \
    AFORA_STATE_DIR="$custom_state_dir" \
    AFORA_CONFIG_PATH="$custom_state_dir/afora.json" \
    AFORA_UPDATE_IN_PROGRESS=1 \
    "$npm_bin" doctor --repair --yes --non-interactive >"$automated_log" 2>&1; then
    afora_e2e_print_log "$automated_log"
    exit 1
  fi

  test "$(sha256sum "$exec_source" | awk '{print $1}')" = "$exec_source_hash"
  test "$(sha256sum "$plugin_source" | awk '{print $1}')" = "$plugin_source_hash"
  test ! -e "$exec_source.migrated"
  test ! -e "$plugin_source.migrated"
  test ! -e "$custom_state_dir/exec-approvals.json"
  test "$(plugin_binding_approval_count "$state_database")" = "0"

  if ! afora_e2e_maybe_timeout "$command_timeout" env \
    -u AFORA_UPDATE_IN_PROGRESS \
    AFORA_STATE_DIR="$custom_state_dir" \
    AFORA_CONFIG_PATH="$custom_state_dir/afora.json" \
    "$npm_bin" doctor --repair --yes --non-interactive >"$direct_log" 2>&1; then
    afora_e2e_print_log "$direct_log"
    exit 1
  fi

  test "$(sha256sum "$exec_source" | awk '{print $1}')" = "$exec_source_hash"
  test "$(sha256sum "$plugin_source" | awk '{print $1}')" = "$plugin_source_hash"
  test ! -e "$exec_source.migrated"
  test ! -e "$plugin_source.migrated"
  test ! -e "$custom_state_dir/exec-approvals.json"
  test "$(plugin_binding_approval_count "$state_database")" = "0"
}

run_cross_state_approval_flow

run_proxy_env_flow() {
  local name="proxy-env-cleanup"
  local install_log="/tmp/afora-doctor-switch-${name}-install.log"
  local doctor_log="/tmp/afora-doctor-switch-${name}-doctor.log"
  local command_timeout="${AFORA_DOCKER_DOCTOR_SWITCH_COMMAND_TIMEOUT:-900s}"

  echo "== Flow: $name =="
  afora_test_state_create "switch-${name}" empty
  use_default_service_identity
  export USER="testuser"

  unit_path="$HOME/.config/systemd/user/afora-gateway.service"
  if ! afora_e2e_maybe_timeout "$command_timeout" env \
    HTTP_PROXY="http://proxy.local:7890" \
    HTTPS_PROXY="https://proxy.local:7890" \
    NO_PROXY="localhost,127.0.0.1" \
    "$npm_bin" gateway install --force >"$install_log" 2>&1; then
    afora_e2e_print_log "$install_log"
    exit 1
  fi
  assert_no_env_key "$unit_path" "HTTP_PROXY"
  assert_no_env_key "$unit_path" "HTTPS_PROXY"
  assert_no_env_key "$unit_path" "NO_PROXY"

  {
    printf "%s\n" "Environment=HTTP_PROXY=http://stale-proxy.local:7890"
    printf "%s\n" "Environment=HTTPS_PROXY=https://stale-proxy.local:7890"
  } >>"$unit_path"
  if ! afora_e2e_maybe_timeout "$command_timeout" env \
    AFORA_UPDATE_IN_PROGRESS=1 \
    AFORA_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE=1 \
    AFORA_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART=1 \
    AFORA_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR=1 \
    AFORA_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION=0 \
    node "$git_cli" doctor --repair --force --yes --non-interactive >"$doctor_log" 2>&1; then
    afora_e2e_print_log "$doctor_log"
    exit 1
  fi
  assert_no_env_key "$unit_path" "HTTP_PROXY"
  assert_no_env_key "$unit_path" "HTTPS_PROXY"
}

run_proxy_env_flow

run_wrapper_flow() {
  local name="wrapper-persistence"
  local install_log="/tmp/afora-doctor-switch-${name}-install.log"
  local reinstall_log="/tmp/afora-doctor-switch-${name}-reinstall.log"
  local env_repair_log="/tmp/afora-doctor-switch-${name}-env-repair.log"
  local doctor_log="/tmp/afora-doctor-switch-${name}-doctor.log"
  local clear_log="/tmp/afora-doctor-switch-${name}-clear.log"
  local command_timeout="${AFORA_DOCKER_DOCTOR_SWITCH_COMMAND_TIMEOUT:-900s}"

  echo "== Flow: $name =="
  afora_test_state_create "switch-${name}" empty
  use_default_service_identity
  export USER="testuser"
  mkdir -p "$HOME/.local/bin"
  local wrapper="$HOME/.local/bin/afora-wrapper"
  node scripts/e2e/lib/doctor-install-switch/write-wrapper.mjs \
    "$wrapper" \
    "$npm_bin" \
    "$HOME/afora-wrapper-argv.log"

  local unit_path="$HOME/.config/systemd/user/afora-gateway.service"

  if ! afora_e2e_maybe_timeout "$command_timeout" "$npm_bin" gateway install --wrapper "$wrapper" --force >"$install_log" 2>&1; then
    afora_e2e_print_log "$install_log"
    exit 1
  fi
  assert_exec_arg "$unit_path" 1 "$wrapper"
  assert_exec_arg "$unit_path" 2 "gateway"
  assert_env_value "$unit_path" "AFORA_WRAPPER" "$wrapper"

  if ! afora_e2e_maybe_timeout "$command_timeout" "$npm_bin" gateway install --force >"$reinstall_log" 2>&1; then
    afora_e2e_print_log "$reinstall_log"
    exit 1
  fi
  assert_exec_arg "$unit_path" 1 "$wrapper"
  assert_exec_arg "$unit_path" 2 "gateway"
  assert_env_value "$unit_path" "AFORA_WRAPPER" "$wrapper"

  sed -i "/^Environment=AFORA_WRAPPER=/d" "$unit_path"
  if ! afora_e2e_maybe_timeout "$command_timeout" "$npm_bin" gateway install --wrapper "$wrapper" >"$env_repair_log" 2>&1; then
    afora_e2e_print_log "$env_repair_log"
    exit 1
  fi
  assert_exec_arg "$unit_path" 1 "$wrapper"
  assert_env_value "$unit_path" "AFORA_WRAPPER" "$wrapper"

  sed -i "s#^Environment=AFORA_WRAPPER=.*#Environment=AFORA_WRAPPER=/tmp/stale-afora-wrapper#" "$unit_path"
  if ! afora_e2e_maybe_timeout "$command_timeout" "$npm_bin" gateway install --wrapper "$wrapper" >"$env_repair_log" 2>&1; then
    afora_e2e_print_log "$env_repair_log"
    exit 1
  fi
  assert_exec_arg "$unit_path" 1 "$wrapper"
  assert_env_value "$unit_path" "AFORA_WRAPPER" "$wrapper"

  if ! afora_e2e_maybe_timeout "$command_timeout" node "$git_cli" doctor --repair --force --yes >"$doctor_log" 2>&1; then
    afora_e2e_print_log "$doctor_log"
    exit 1
  fi
  if ! grep -Fq "Gateway service invokes AFORA_WRAPPER:" "$doctor_log"; then
    echo "Expected doctor to report active wrapper"
    afora_e2e_print_log "$doctor_log"
    exit 1
  fi
  assert_exec_arg "$unit_path" 1 "$wrapper"
  assert_env_value "$unit_path" "AFORA_WRAPPER" "$wrapper"

  if ! afora_e2e_maybe_timeout "$command_timeout" env AFORA_WRAPPER= "$npm_bin" gateway install --force >"$clear_log" 2>&1; then
    afora_e2e_print_log "$clear_log"
    exit 1
  fi
  assert_no_env_key "$unit_path" "AFORA_WRAPPER"
  assert_entrypoint "$unit_path" "$npm_entry"
}

if "$npm_bin" gateway install --help 2>&1 | grep -q -- "--wrapper"; then
  run_wrapper_flow
elif is_legacy_package_acceptance_compat "$package_version"; then
  # Legacy compatibility: 2026.4.25 and older did not ship gateway install --wrapper.
  echo "Skipping wrapper persistence; package gateway install does not support --wrapper."
else
  echo "Package $package_version must support gateway install --wrapper." >&2
  exit 1
fi
