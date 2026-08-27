#!/usr/bin/env bash
set -euo pipefail

export HOME=/tmp/afora-docker-selected-plugins
export AFORA_STATE_DIR="$HOME/.afora"
export AFORA_CONFIG_PATH="$AFORA_STATE_DIR/afora.json"
export AFORA_DISABLE_BUNDLED_SOURCE_OVERLAYS=1

mkdir -p "$AFORA_STATE_DIR"
node --input-type=module <<'NODE'
import fs from "node:fs";

const entries = Object.fromEntries(
  ["clickclack", "slack", "msteams"].map((id) => [id, { enabled: true }]),
);
fs.writeFileSync(
  process.env.AFORA_CONFIG_PATH,
  `${JSON.stringify({ plugins: { entries } }, null, 2)}\n`,
  { mode: 0o600 },
);
NODE

for plugin_id in clickclack slack msteams clawrouter; do
  node /app/afora.mjs plugins inspect "$plugin_id" --runtime --json \
    >"/tmp/afora-${plugin_id}-inspect.json"
done

node /afora-e2e/assertions.mjs
