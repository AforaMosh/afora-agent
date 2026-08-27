---
summary: "Gateway runtime on macOS (external launchd service)"
read_when:
  - Packaging Afora.app
  - Debugging the macOS gateway launchd service
  - Installing the gateway CLI for macOS
title: "Gateway on macOS"
---

Afora.app does not bundle Node or the Gateway runtime. The macOS app
expects an **external** `afora` CLI install, does not spawn the Gateway as
a child process, and manages a per-user launchd service to keep the Gateway
running (or attaches to an already-running local Gateway).

## Automatic setup

On a fresh Mac, choose **This Mac** during onboarding. The app runs its
signed, bundled installer script before the Gateway wizard: it installs a
user-space Node runtime and the matching `afora` CLI under `~/.afora`,
then installs and starts the per-user launchd service. This path needs no
Terminal, Homebrew, or administrator access.

The app bundles the installer script only, not the Node or Gateway payload;
setup needs an internet connection to download the runtime and matching
Afora package.

## Manual recovery

For a manual install, use Node 26 (recommended) or another supported release:
Node 22.22.3+, Node 24.15+, or Node 25.9+. Install `afora` globally:

The command below is for npm 12 or npm 11.16+. On npm 11.12 and earlier,
omit `--allow-scripts=afora`; upgrade npm 11.13–11.15 first.

```bash
npm install -g afora@<version> --allow-scripts=afora
```

Use **Retry setup** after a failed automatic setup. If that still fails,
install the CLI manually with the command above, then choose **Check again**
in onboarding.

## Launchd (Gateway as LaunchAgent)

Label: `ai.afora.gateway` (default profile), or `ai.afora.<profile>`
for a named profile.

Plist location (per-user): `~/Library/LaunchAgents/ai.afora.gateway.plist`
(or `ai.afora.<profile>.plist`).

The macOS app owns LaunchAgent install/update for the default profile in
Local mode. The CLI can also install it directly: `afora gateway install`
(named profiles are selected via the `AFORA_PROFILE` env var).

Behavior:

- "Afora Active" enables/disables the LaunchAgent.
- Quitting the app does **not** stop the Gateway (launchd keeps it alive).
- If a Gateway is already running on the configured port, the app attaches to
  it instead of starting a new one.

Use the CLI for lifecycle checks and recovery:

```bash
afora gateway status --deep
afora gateway restart
```

Launchd provides auto-start at login, crash restarts, and one predictable log
location without tying the Gateway lifetime to the app process.

### Attach-only development

When another process already owns the local Gateway, run the development app
without installing or changing its LaunchAgent:

```bash
scripts/restart-mac.sh --attach-only
```

Launching the app directly with `--attach-only` or `--no-launchd` has the same
effect. The override persists in `~/.afora/disable-launchagent`; remove that
file to restore app-managed launchd behavior.

Logging:

- launchd stdout: `~/Library/Logs/afora/gateway.log` (profiles use
  `gateway-<profile>.log`)
- launchd stderr: suppressed
- If the host loops with repeated `EADDRINUSE` or fast restarts, check for
  duplicate `ai.afora.gateway` / `ai.afora.node` LaunchAgents and the
  launchd-marker workaround in
  [Gateway troubleshooting](/gateway/troubleshooting#macos-launchd-supervisor-loop-with-duplicate-gateway%2Fnode-launchagents).

## Version compatibility

The macOS app checks the Gateway version against its own version. Onboarding
automatically runs managed setup when an existing CLI is missing or
incompatible. Use **Retry setup** to repeat installation, or **Check again**
after repairing an external CLI.

## State directory on macOS

Keep Afora state on a local, non-synced disk. Avoid iCloud Drive and other
cloud-synced folders; sync latency and file locks can affect sessions,
credentials, and Gateway state.

Set `AFORA_STATE_DIR` to a local path only when you need an override.
`afora doctor` warns about common cloud-synced state paths and recommends
moving back to local storage. See
[environment variables](/help/environment#path-related-env-vars) and
[Doctor](/gateway/doctor).

## Debug app connectivity

Use the macOS debug CLI from a source checkout to exercise the same Gateway
WebSocket handshake and discovery logic the app uses:

```bash
cd apps/macos
swift run afora-mac connect --json
swift run afora-mac discover --timeout 3000 --json
```

`connect` accepts `--url`, `--token`, `--timeout`, `--probe`, and `--json`
(plus client-identity overrides; run with `--help` for the full list).
`discover` accepts `--timeout`, `--json`, and `--include-local`. Compare
discovery output with `afora gateway discover --json` when you need to
separate CLI discovery from app-side connection issues.

## Smoke check

```bash
afora --version

AFORA_SKIP_CHANNELS=1 \
AFORA_SKIP_CANVAS_HOST=1 \
afora gateway --port 18999 --bind loopback
```

Then:

```bash
afora gateway call health --port 18999 --timeout 3000
```

## Related

- [macOS app](/platforms/macos)
- [Gateway runbook](/gateway)
