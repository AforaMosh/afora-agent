---
summary: "CLI reference for `afora approvals` and `afora exec-policy`"
read_when:
  - You want to edit exec approvals from the CLI
  - You need to manage allowlists on gateway or node hosts
  - You need to list or resolve a pending approval without a chat surface
title: "Approvals"
---

# `afora approvals`

Manage exec approvals for the **local host**, **gateway host**, or a **node host**. With no target flag, commands read/write the local approvals document in shared SQLite state. Use `--gateway` to target the gateway, or `--node <id|name|ip>` to target a specific node.

Alias: `afora exec-approvals`

Related: [Exec approvals](/tools/exec-approvals), [Nodes](/nodes)

## `afora exec-policy`

`afora exec-policy` is the **local-only** convenience command that keeps requested `tools.exec.*` config and the local host approvals document in sync in one step:

```bash
afora exec-policy show
afora exec-policy show --json

afora exec-policy preset yolo
afora exec-policy preset cautious --json

afora exec-policy set --host gateway --security full --ask off --ask-fallback full --json
```

Presets (`yolo`, `cautious`, `deny-all`) apply `host`, `security`, `ask`, and `askFallback` together. `set` applies only the flags you pass; each accepted value is validated (`--host auto|sandbox|gateway|node`, `--security deny|allowlist|full`, `--ask off|on-miss|always`, `--ask-fallback deny|allowlist|full`).

`show`, `preset`, and `set` accept `--json` and return the same requested,
host, and effective policy facts as one JSON object.

Scope:

- Updates the local config file and local approvals document together; does not push policy to the gateway or a node host.
- `--host node` is rejected: node exec approvals are fetched from the node at runtime, so local `exec-policy` cannot synchronize them. Use `afora approvals set --node <id|name|ip>` instead.
- `exec-policy show` marks `host=node` scopes as node-managed at runtime instead of deriving an effective policy from the local approvals document.

For remote host approvals, use `afora approvals set --gateway` or `afora approvals set --node <id|name|ip>` directly.

## Common commands

```bash
afora approvals get
afora approvals get --node <id|name|ip>
afora approvals get --gateway
afora approvals pending
afora approvals resolve <id> <allow-once|allow-always|deny>
```

`get` shows the effective exec policy for the target: the requested `tools.exec` policy, the host approvals-file policy, and the merged effective result. Nodes with a host-native policy, such as the Windows companion, show that policy directly instead of applying Afora approvals-file policy math.

For file-backed nodes, the merged view requires a host-resolved policy snapshot. Older nodes show the effective policy as unavailable instead of assuming the Gateway's requested policy also applies on the host.

<Note>
Per-session `/exec` overrides are not included. Run `/exec` in the relevant session to inspect its current defaults.
</Note>

Precedence:

- The host approvals document is the enforceable source of truth.
- Requested `tools.exec` policy can narrow or broaden intent, but the effective result is derived from host rules.
- `--node` combines the node host approvals document with gateway `tools.exec` policy (both apply at runtime).
- If gateway config is unavailable, the CLI falls back to the node approvals snapshot and notes that the final runtime policy could not be computed.

## Pending approvals

List pending exec, plugin, and Afora system-agent approvals from the Gateway:

```bash
afora approvals pending
afora approvals pending --json
```

Complete enumeration and the matching operator-wide `resolve` flow use `operator.admin` because approval records otherwise retain requester/reviewer filtering. Resolution also requests the dedicated `operator.approvals` scope. The standard CLI operator grant includes both scopes; a restricted third-party client should not request admin merely to emulate this command.

Human output shows the approval kind, agent/session attribution, request age, time until expiry, a shortened command or summary, and a shell-neutral `id64_<base64url>` id token. A `Full request text` block always follows the compact table with every complete token and a losslessly escaped request, so terminal-width shortening cannot hide a suffix or the token needed for resolution. Copy the complete token into `resolve`. Unsafe terminal characters in other fields are shown as visible Unicode escapes. JSON output returns normalized entries under `approvals`, preserving the original raw `id`, `summary`, `createdAtMs`, and `expiresAtMs` for scripts; raw ids remain accepted by `resolve` unless they use the reserved `id64_` display-token prefix.

If a supplied `id64_` value matches both a literal raw id and the decoded display token for another approval, the CLI rejects it as ambiguous instead of risking resolution of the wrong request.

Resolve one approval by its full id:

```bash
afora approvals resolve <id> allow-once
afora approvals resolve <id> allow-always
afora approvals resolve <id> deny --reason "Not expected during maintenance"
```

The CLI reads the unified approval record to select its kind, checks the requested decision against the record's allowed decisions, and then calls the unified resolver. A first successful decision exits `0`. Repeating the recorded decision also exits `0` and reports `already resolved (same decision)`. A conflicting decision, missing approval, expired approval, or decision unavailable for that approval kind prints a clear error and exits non-zero.

`--reason` adds a local note to the CLI confirmation. The current Gateway approval record has no free-text resolution-reason field, so this note is not persisted or sent to other approval surfaces.

## Replace approvals from a file

```bash
afora approvals set --file ./exec-approvals.json
afora approvals set --stdin <<'EOF'
{ version: 1, defaults: { security: "full", ask: "off", askFallback: "full" } }
EOF
afora approvals set --node <id|name|ip> --file ./exec-approvals.json
afora approvals set --gateway --file ./exec-approvals.json
```

`set` accepts JSON5, not only strict JSON. Use either `--file` or `--stdin`, not both.

Host-native Windows nodes use their own policy shape:

```bash
afora approvals set --node <id|name|ip> --stdin <<'EOF'
{
  defaultAction: "deny",
  rules: [{ pattern: "hostname", action: "allow" }]
}
EOF
```

The CLI reads the node's current hash first and sends it with the update, so concurrent local edits are rejected instead of overwritten. `rules` is required because this operation replaces the node's complete rule list; `defaultAction` is optional. A node that reports its native policy as disabled cannot be configured remotely; enable or configure the policy on that host first. Host-native policies do not support the `allowlist add|remove` helpers.

## "Never prompt" / YOLO example

Set the host approvals defaults to `full` + `off` for a host that should never stop on exec approvals:

```bash
afora approvals set --stdin <<'EOF'
{
  version: 1,
  defaults: {
    security: "full",
    ask: "off",
    askFallback: "full"
  }
}
EOF
```

For nodes that expose an Afora approvals document, use the same body with `afora approvals set --node <id|name|ip> --stdin`. Host-native nodes require their owner-specific shape shown above.

This changes the **host approvals document** only. To keep the requested Afora policy aligned, also set:

```bash
afora config set tools.exec.host gateway
afora config set tools.exec.mode full
```

`tools.exec.host=gateway` is explicit here because `host=auto` still means "sandbox when available, otherwise gateway": YOLO is about approvals, not routing. Use `gateway` (or `/exec host=gateway`) when you want host exec even with a sandbox configured.

Omitted `askFallback` defaults to `deny`. Set `askFallback: "full"` explicitly when upgrading a no-UI host that should keep never-prompt behavior.

Local shortcut for the same intent, on the local machine only:

```bash
afora exec-policy preset yolo
```

## Allowlist helpers

```bash
afora approvals allowlist add "~/Projects/**/bin/rg"
afora approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
afora approvals allowlist add --agent "*" "/usr/bin/uname"

afora approvals allowlist remove "~/Projects/**/bin/rg"
```

## Common options

`get`, `set`, and `allowlist add|remove` all support:

- `--node <id|name|ip>` (resolves id, name, IP, or id prefix; same resolver as `afora nodes`)
- `--gateway`
- shared node RPC options: `--url`, `--token`, `--timeout`, `--json`

No target flag means the local approvals row in the shared state database.

`allowlist add|remove` also supports `--agent <id>` (defaults to `"*"`, applying to all agents).

`pending` and `resolve` always use the Gateway because pending requests are live Gateway state. They support the shared Gateway connection options `--url`, `--token`, and `--timeout`; `pending` also supports `--json`.

## Notes

- The node host must advertise `system.execApprovals.get/set` (macOS app, headless node host, or Windows companion).
- Approvals are stored per host in
  `$AFORA_STATE_DIR/state/afora.sqlite#exec_approvals_config`, or
  `~/.afora/state/afora.sqlite#exec_approvals_config` when the variable is
  unset. The suffix identifies the singleton SQLite row.

## Related

- [CLI reference](/cli)
- [Exec approvals](/tools/exec-approvals)
