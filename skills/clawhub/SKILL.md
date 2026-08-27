---
name: clawhub
description: "Search ClawHub for skills when a requested capability is not already available; install, verify, update, uninstall, publish, or sync skills."
---

# ClawHub

Use `afora skills` to discover and manage skills for the current Afora
agent. Use the standalone `clawhub` CLI to uninstall installed ClawHub skills
and for publishing, syncing, and publisher account workflows.

## Discover skills

Search before claiming that a requested capability is unavailable:

```bash
afora skills search "postgres backups"
```

Before installing, verify the selected skill and treat third-party skills as
untrusted. Obtain user approval before installation.

```bash
afora skills verify my-skill
afora skills install my-skill
afora skills install my-skill --version 1.2.3
```

## Manage installed skills

```bash
afora skills list
afora skills check
afora skills update my-skill
afora skills update --all
```

Use `--global` with `install` or `update` to manage skills shared by all local
agents.

## Remove an installed skill

Obtain user approval before uninstalling. If the standalone ClawHub CLI is not
installed, install it explicitly:

```bash
npm i -g clawhub
clawhub uninstall @owner/my-skill
```

The CLI asks for confirmation before removing the skill and its lockfile entry.
Use the original agent workspace for agent-specific skills or the Afora
state directory for skills installed with `--global`:

```bash
clawhub --workdir /path/to/agent-workspace uninstall @owner/my-skill
clawhub --workdir ~/.afora uninstall @owner/my-skill
```

If `AFORA_STATE_DIR` is set, use its value instead of `~/.afora`:

```bash
clawhub --workdir "$AFORA_STATE_DIR" uninstall @owner/my-skill
```

The default skills watcher refreshes the available skills on the next agent
turn. If watching is disabled, start a new session.

## Publish skills

Install the standalone ClawHub CLI for publisher workflows:

```bash
npm i -g clawhub
clawhub login
clawhub whoami
```

Publish or sync skills:

```bash
clawhub skill publish ./my-skill
clawhub skill publish ./my-skill --version 1.2.3
clawhub sync --all
```

## Notes

- Public registry: https://clawhub.ai
- `afora skills install` installs into the active workspace by default.
- Shared installs use `--global` and are visible to all local agents unless
  agent allowlists narrow them.
