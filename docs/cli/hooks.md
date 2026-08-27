---
summary: "CLI reference for `afora hooks` (agent hooks)"
read_when:
  - You want to manage agent hooks
  - You want to inspect hook availability or enable workspace hooks
title: "Hooks"
---

# `afora hooks`

Manage agent hooks (event-driven automations for commands like `/new`, `/reset`, and gateway startup). Bare `afora hooks` is equivalent to `afora hooks list`.

Related: [Hooks](/automation/hooks) - [Plugin hooks](/plugins/hooks)

## List hooks

```bash
afora hooks --agent <id> --json
afora hooks list [--agent <id>] [--eligible] [--json] [-v|--verbose]
```

Bare `afora hooks` and `afora hooks --json` use the same list operation as
`afora hooks list`. The command discovers hooks from workspace, managed,
extra, and bundled directories.

- `--eligible`: only hooks whose requirements are met.
- `--agent <id>`: inspect hooks for that agent's workspace. Required when multiple agents are configured without an implicit owner.
- `--json`: structured output.
- `-v, --verbose`: include a Missing column with unmet requirements.

```
Hooks (4/5 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📎 bootstrap-extra-files ✓ - Inject additional workspace bootstrap files during agent bootstrap
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new or /reset command is issued
```

## Get hook info

```bash
afora hooks info <name> [--agent <id>] [--json]
```

`<name>` is the hook name or hook key (for example `session-memory`). Shows source, file/handler paths, homepage, events, and per-requirement status (binaries, env, config, OS).

## Check eligibility

```bash
afora hooks check [--agent <id>] [--json]
```

Prints a ready/not-ready count summary; with hooks not ready, lists each with its blocking reason.

## Enable a hook

```bash
afora hooks enable <name> [--agent <id>]
```

Adds/updates `hooks.internal.entries.<name>.enabled = true` in config and also flips the `hooks.internal.enabled` master switch on (the gateway does not load any internal hook handler until at least one is configured). Fails if the hook does not exist, is plugin-managed, or is not eligible (missing requirements).

`--agent <id>` selects the workspace used to discover the hook and is required
when multiple agents are configured without an implicit owner. The persisted
hook entry is global and applies wherever that hook key is discovered.

Plugin-managed hooks show `plugin:<id>` in `hooks list` and cannot be enabled/disabled here; enable or disable the owning plugin instead.

Restart the gateway after enabling (macOS menu bar app restart, or restart your gateway process in dev) so it reloads hooks.

## Disable a hook

```bash
afora hooks disable <name> [--agent <id>]
```

Sets `hooks.internal.entries.<name>.enabled = false`. Restart the gateway afterward.

## Install and update hook packs

```bash
afora plugins install <package>        # npm by default
afora plugins install npm:<package>    # npm only
afora plugins install <package> --pin  # pin resolved version
afora plugins install <path>           # local directory or archive
afora plugins install -l <path>        # link a local directory instead of copying

afora plugins update <id>
afora plugins update --all
afora plugins update --dry-run
```

Hook packs install through the unified plugins installer/updater; `afora hooks install` / `afora hooks update` still work as deprecated aliases that print a warning and forward to the `plugins` commands.

- Npm specs are registry-only: package name plus an optional exact version or dist-tag. Git/URL/file specs and semver ranges are rejected. Dependency installs run project-local with `--ignore-scripts`.
- Bare specs and `@latest` stay on the stable track; if npm resolves to a prerelease, Afora stops and asks you to opt in explicitly (`@beta`, `@rc`, or an exact prerelease version).
- Supported archives: `.zip`, `.tgz`, `.tar.gz`, `.tar`.
- `-l, --link` links a local directory instead of copying it (adds it to `hooks.internal.load.extraDirs`); linked hook packs are managed hooks from an operator-configured directory, not workspace hooks.
- `--pin` records npm installs as an exact resolved `name@version` in shared SQLite state.
- Install copies the pack into `~/.afora/hooks/<id>`, enables its hooks under `hooks.internal.entries.*`, and records install provenance in shared SQLite state.
- If a stored integrity hash no longer matches the fetched artifact, Afora warns and prompts before continuing; pass global `--yes` to bypass the prompt (for example in CI).

## Bundled hooks

| Hook                  | Events                                            | What it does                                                                            |
| --------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| boot-md               | `gateway:startup`                                 | Runs `BOOT.md` at gateway startup for each configured agent scope                       |
| bootstrap-extra-files | `agent:bootstrap`                                 | Injects extra bootstrap files (for example monorepo `AGENTS.md`) during agent bootstrap |
| command-logger        | `command`                                         | Logs command events to `~/.afora/logs/commands.log`                                  |
| compaction-notifier   | `session:compact:before`, `session:compact:after` | Sends visible chat notices when session compaction starts and finishes                  |
| session-memory        | `command:new`, `command:reset`                    | Saves session context to memory on `/new` or `/reset`                                   |

Enable any bundled hook with `afora hooks enable <hook-name>`. Full details, config keys, and defaults: [Bundled hooks](/automation/hooks#bundled-hooks).

### command-logger log file

```bash
tail -n 20 ~/.afora/logs/commands.log        # recent commands
cat ~/.afora/logs/commands.log | jq .          # pretty-print
grep '"action":"new"' ~/.afora/logs/commands.log | jq .   # filter by action
```

## Notes

- `hooks list --json`, `info --json`, and `check --json` write structured JSON directly to stdout.
- `hooks list`, `info`, and `check` pass `--agent` to a running Gateway and preserve it when falling back to local read-only discovery against an older or unavailable Gateway.

## Related

- [CLI reference](/cli)
- [Automation hooks](/automation/hooks)
