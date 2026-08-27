---
summary: "Uninstall Afora completely (CLI, service, state, workspace)"
read_when:
  - You want to remove Afora from a machine
  - The gateway service is still running after uninstall
title: "Uninstall"
---

Two paths:

- **Easy path** if `afora` is still installed.
- **Manual service removal** if the CLI is gone but the service is still running.

## Easy path (CLI still installed)

Recommended: use the built-in uninstaller:

```bash
afora uninstall
```

State removal preserves configured workspace directories unless you also select `--workspace`.

Preview what will be removed (safe):

```bash
afora uninstall --dry-run --all
```

Non-interactive (automation / npx). Use with caution and only after confirming scopes:

```bash
afora uninstall --all --yes --non-interactive
npx -y afora uninstall --all --yes --non-interactive
```

Flags: `--service`, `--state`, `--workspace`, `--app` select individual scopes; `--all` selects all four.

Manual steps provide a complete removal path, but a raw state-directory deletion
does not have the built-in uninstaller's workspace-preservation behavior. If
you want the equivalent of `afora uninstall --state`, preserve every
configured workspace before deleting state.

1. Stop the gateway service:

```bash
afora gateway stop
```

2. Uninstall the gateway service (launchd/systemd/schtasks):

```bash
afora gateway uninstall
```

3. Decide whether to preserve the workspace.

`afora uninstall --state` deliberately preserves configured workspace
directories, including the default `~/.afora/workspace`. Before using the
manual `rm -rf` below, move any workspace you want to keep outside the state
directory. If you want to remove it too, no separate deletion is needed when it
lives inside the state directory.

4. Delete state + config:

```bash
rm -rf "${AFORA_STATE_DIR:-$HOME/.afora}"
```

If you set `AFORA_CONFIG_PATH` to a custom location outside the state dir, delete that file too.
Restore any preserved workspace to its configured path after recreating the
parent directory, or update the workspace path in your next installation.

5. Delete a workspace stored outside the state directory only if you want to
   remove its agent files too:

```bash
rm -rf /path/to/external/workspace
```

6. Remove the CLI install (pick the one you used):

```bash
npm rm -g afora
pnpm remove -g afora
bun remove -g afora
```

7. If you installed the macOS app:

```bash
rm -rf /Applications/Afora.app
```

Notes:

- If you used profiles (`--profile` / `AFORA_PROFILE`), repeat steps 3-4 for each state dir (defaults are `~/.afora-<profile>`).
- In remote mode, the state dir lives on the **gateway host**, so run steps 1-4 there too.

## Manual service removal (CLI not installed)

Use this if the gateway service keeps running but `afora` is missing.

### macOS (launchd)

Default label is `ai.afora.gateway` (or `ai.afora.<profile>` with a profile):

```bash
launchctl bootout gui/$UID/ai.afora.gateway
rm -f ~/Library/LaunchAgents/ai.afora.gateway.plist
```

If you used a profile, replace the label and plist name with `ai.afora.<profile>`.

### Linux (systemd user unit)

Default unit name is `afora-gateway.service` (or `afora-gateway-<profile>.service`). A pre-rename `clawdbot-gateway.service` unit may still exist on machines upgraded from very old installs; `afora uninstall` / `afora gateway uninstall` detects and removes it automatically.

```bash
systemctl --user disable --now afora-gateway.service
rm -f ~/.config/systemd/user/afora-gateway.service
systemctl --user daemon-reload
```

### Windows (Scheduled Task)

Default task name is `Afora Gateway` (or `Afora Gateway (<profile>)`).
The task launches a windowless `gateway.vbs` script under your state dir, which in turn
runs `gateway.cmd`; remove both.

```powershell
schtasks /Delete /F /TN "Afora Gateway"
Remove-Item -Force "$env:USERPROFILE\.afora\gateway.cmd" -ErrorAction SilentlyContinue
Remove-Item -Force "$env:USERPROFILE\.afora\gateway.vbs" -ErrorAction SilentlyContinue
```

If you used a profile, delete the matching task name and the `gateway.cmd` /
`gateway.vbs` files under `~\.afora-<profile>`.

## Normal install vs source checkout

### Normal install (install.sh / npm / pnpm / bun)

If you used `https://afora.ai/install.sh` or `install.ps1`, the CLI was installed with `npm install -g afora@latest`.
Remove it with `npm rm -g afora` (or `pnpm remove -g` / `bun remove -g` if you installed that way).

### Source checkout (git clone)

If you run from a repo checkout (`git clone` + `afora ...` / `bun run afora ...`):

1. Uninstall the gateway service **before** deleting the repo (use the easy path above or manual service removal).
2. Delete the repo directory.
3. Remove state + workspace as shown above.

## Related

- [Install overview](/install)
- [Migration guide](/install/migrating)
