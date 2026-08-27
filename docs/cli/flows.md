---
summary: "Redirect: flow commands live under `afora tasks flow`"
read_when:
  - You encounter `afora flows` in older docs or release notes
  - You want a quick TaskFlow inspection reference
title: "Flows (redirect)"
---

# `afora tasks flow`

There is no top-level `afora flows` command. Durable TaskFlow inspection lives under `afora tasks flow`.

## Subcommands

```bash
afora tasks flow list   [--json] [--status <name>]
afora tasks flow show   <lookup> [--json]
afora tasks flow cancel <lookup>
```

| Subcommand | Description                | Arguments / options                                                                   |
| ---------- | -------------------------- | ------------------------------------------------------------------------------------- |
| `list`     | List tracked TaskFlows.    | `--json` machine-readable output; `--status <name>` filter (see status values below). |
| `show`     | Show one TaskFlow.         | `<lookup>` flow id or owner key; `--json` machine-readable output.                    |
| `cancel`   | Cancel a running TaskFlow. | `<lookup>` flow id or owner key.                                                      |

`<lookup>` accepts either a flow id (returned by `list` / `show`) or the flow's owner key (the stable identifier the owning subsystem uses to track the flow).

### Status filter values

`--status` on `list` accepts one of: `queued`, `running`, `waiting`, `blocked`, `succeeded`, `failed`, `cancelled`, `lost`.

## Examples

```bash
afora tasks flow list
afora tasks flow list --status running
afora tasks flow list --json
afora tasks flow show flow_abc123
afora tasks flow show flow_abc123 --json
afora tasks flow cancel flow_abc123
```

For TaskFlow concepts and authoring, see [TaskFlow](/automation/taskflow). For the parent `tasks` command, see [tasks CLI reference](/cli/tasks).

## Related

- [CLI reference](/cli)
- [Automation](/automation)
- [TaskFlow](/automation/taskflow)
