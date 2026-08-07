#!/usr/bin/env bash

# Both package paths use one trusted shim so restart behavior cannot drift.
# shellcheck disable=SC1091
source scripts/e2e/lib/upgrade-survivor/systemctl-shim.sh
# shellcheck disable=SC1091
source scripts/e2e/lib/upgrade-survivor/gateway-start.sh

seed_update_restart_probe_device_auth() {
  node --input-type=module <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const stateDir = process.env.OPENCLAW_STATE_DIR;
if (!stateDir) {
  throw new Error("missing OPENCLAW_STATE_DIR");
}

const base64UrlEncode = (buf) =>
  buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
const spki = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
const rawPublicKey =
  spki.length === ed25519SpkiPrefix.length + 32 &&
  spki.subarray(0, ed25519SpkiPrefix.length).equals(ed25519SpkiPrefix)
    ? spki.subarray(ed25519SpkiPrefix.length)
    : spki;
const publicKeyRaw = base64UrlEncode(rawPublicKey);
const deviceId = crypto.createHash("sha256").update(rawPublicKey).digest("hex");
const token = base64UrlEncode(crypto.randomBytes(32));
const now = Date.now();
const scopes = ["operator.read"];

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
  }
}

writeJson(path.join(stateDir, "identity", "device.json"), {
  version: 1,
  deviceId,
  publicKeyPem,
  privateKeyPem,
  createdAtMs: now,
});
writeJson(path.join(stateDir, "identity", "device-auth.json"), {
  version: 1,
  deviceId,
  tokens: {
    operator: {
      token,
      role: "operator",
      scopes,
      updatedAtMs: now,
    },
  },
});
writeJson(path.join(stateDir, "devices", "paired.json"), {
  [deviceId]: {
    deviceId,
    publicKey: publicKeyRaw,
    displayName: "upgrade survivor restart probe",
    platform: process.platform,
    clientId: "openclaw-cli",
    clientMode: "probe",
    role: "operator",
    roles: ["operator"],
    scopes,
    approvedScopes: scopes,
    tokens: {
      operator: {
        token,
        role: "operator",
        scopes,
        createdAtMs: now,
      },
    },
    createdAtMs: now,
    approvedAtMs: now,
  },
});
writeJson(path.join(stateDir, "devices", "pending.json"), {});
NODE
}

write_update_restart_service_auth_env() {
  mkdir -p "$OPENCLAW_STATE_DIR"
  local dotenv_path="$OPENCLAW_STATE_DIR/.env"
  local tmp_path="$dotenv_path.tmp.$$"
  if [ -f "$dotenv_path" ]; then
    grep -v '^GATEWAY_AUTH_TOKEN_REF=' "$dotenv_path" >"$tmp_path" || true
  else
    : >"$tmp_path"
  fi
  printf 'GATEWAY_AUTH_TOKEN_REF=%s\n' "$GATEWAY_AUTH_TOKEN_REF" >>"$tmp_path"
  mv "$tmp_path" "$dotenv_path"
  printf 'GATEWAY_AUTH_TOKEN_REF=%s\n' "$GATEWAY_AUTH_TOKEN_REF" >"$OPENCLAW_STATE_DIR/gateway.systemd.env"
}

prepare_update_restart_probe_current_install() {
  local port="$1"
  local log_file="$2"
  local command_timeout="${OPENCLAW_UPGRADE_SURVIVOR_COMMAND_TIMEOUT:-900s}"
  local doctor_log="${log_file}.doctor"
  local start_epoch
  local ready_epoch

  echo "Preparing candidate-auth gateway for automatic update restart."
  install_update_restart_systemctl_shim
  seed_update_restart_probe_device_auth
  if ! openclaw_e2e_maybe_timeout "$command_timeout" openclaw doctor --fix --non-interactive >"$doctor_log" 2>&1; then
    echo "candidate device identity migration failed" >&2
    cat "$doctor_log" >&2 || true
    return 1
  fi
  start_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
  upgrade_survivor_start_direct_gateway \
    "$log_file" \
    360 \
    "$port" \
    strict \
    -- \
    env -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD \
    openclaw gateway --port "$port" --bind loopback --allow-unconfigured
  printf '%s\n' "$gateway_pid" >"$OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE"
  ready_epoch="$(node -e "process.stdout.write(String(Date.now()))")"
  start_seconds=$(((ready_epoch - start_epoch + 999) / 1000))
  write_update_restart_service_auth_env
  if ! openclaw_e2e_maybe_timeout "$command_timeout" env -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD openclaw gateway install --force --json >"$OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_JSON" 2>"$OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_ERR"; then
    echo "gateway service install failed" >&2
    cat "$OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_ERR" >&2 || true
    cat "$OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_JSON" >&2 || true
    return 1
  fi
}
