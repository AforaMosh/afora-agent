---
summary: "Run OpenClaw as a self-contained ACP agent"
read_when:
  - Setting up ACP-based IDE or agent-host integrations
  - Debugging local ACP sessions, tools, or model authentication
title: "ACP"
---

Run OpenClaw as an [Agent Client Protocol (ACP)](https://agentclientprotocol.com/)
agent over stdio:

```bash
openclaw acp
```

The command is self-contained. It runs the OpenClaw agent loop and tools in the
ACP process. It does not connect to, start, or require an OpenClaw Gateway.

This matters for ACP hosts such as editors, desktop apps, and relay workers:
environment variables and credentials supplied to the launched process are
available to the same process that executes local tools.

If you want an external MCP client to talk directly to OpenClaw channel
conversations, use [`openclaw mcp serve`](/cli/mcp) instead.

## What this is not

`openclaw acp` means an ACP client launches OpenClaw as its agent runtime.

This is different from [ACP Agents](/tools/acp-agents), where a running OpenClaw
instance launches an external harness such as Codex or Claude Code through
`acpx`.

Quick rule:

- ACP client wants to launch OpenClaw: use `openclaw acp`
- OpenClaw should launch another ACP harness: use `/acp spawn` and
  [ACP Agents](/tools/acp-agents)

## Model setup

OpenClaw ACP uses the normal OpenClaw provider and model configuration.

Configure it directly:

```bash
openclaw acp --configure-model
```

ACP clients that support terminal authentication also receive a
`Configure OpenClaw model` authentication method. That method launches the same
model-only setup flow.

Runtime startup and model authentication are separate:

- `openclaw acp` owns the local ACP runtime lifecycle
- normal OpenClaw setup owns provider credentials and model defaults
- no Gateway URL, token, password, or service setup is involved

## Runtime discovery

ACP hosts can verify the execution model without starting an agent:

```bash
openclaw acp info
```

The command prints a machine-readable compatibility contract:

```json
{ "schemaVersion": 1, "protocol": "acp", "transport": "stdio", "execution": "embedded" }
```

## Protocol support

| ACP area                                        | Status      | Notes                                                                                                       |
| ----------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `initialize`, `newSession`, `prompt`, `cancel`  | Implemented | Core local session and turn lifecycle                                                                       |
| `listSessions`, `resumeSession`, `closeSession` | Implemented | Uses canonical local OpenClaw session storage                                                               |
| `loadSession`                                   | Implemented | Replays complete ACP ledger history or falls back to stored user/assistant transcript text                  |
| Session modes and config options                | Partial     | Exposes supported OpenClaw thinking, verbosity, reasoning, usage, elevated, fast-mode, and timeout controls |
| Prompt text, embedded resources, and images     | Implemented | Runs through the normal local OpenClaw agent ingress                                                        |
| Thought and tool streaming                      | Implemented | Emits ACP session updates from local agent events                                                           |
| Exec and plugin approvals                       | Implemented | Uses ACP `session/request_permission` for run-owned approval decisions                                      |
| Per-session MCP servers (`mcpServers`)          | Unsupported | Configure MCP through OpenClaw instead                                                                      |
| ACP client filesystem methods                   | Unsupported | OpenClaw tools execute locally in the ACP process                                                           |
| ACP client terminal methods                     | Unsupported | OpenClaw uses its normal local tool runtime                                                                 |

## Sessions

By default, a new ACP session receives an isolated OpenClaw session key.

Use a known key or label when the ACP client should attach to existing local
OpenClaw state:

```bash
openclaw acp --session agent:main:main
openclaw acp --session-label "support inbox"
```

Require the target to exist:

```bash
openclaw acp --session agent:main:main --require-existing
```

Reset the target before binding:

```bash
openclaw acp --session agent:main:main --reset-session
```

ACP request metadata can override routing per session:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true,
    "requireExisting": true
  }
}
```

Session setup and reset operations are serialized by canonical OpenClaw session
key. Unrelated sessions can run concurrently.

## ACP client

Use the built-in client to test the local runtime without an editor:

```bash
openclaw acp client
```

Override the working directory or server command:

```bash
openclaw acp client --cwd /path/to/project
openclaw acp client --server node --server-args openclaw.mjs acp
```

The debug client uses a conservative permission policy:

- trusted read-only core tools can be auto-approved
- file reads are scoped to the active working directory
- exec-capable, mutating, unknown, and interactive tools require approval
- server-provided tool metadata is not treated as authorization

This policy is separate from ACPX harness permission modes.

## Editor setup

Example Zed custom agent configuration:

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

To bind the editor to an existing OpenClaw session:

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": ["acp", "--session", "agent:design:main"],
      "env": {}
    }
  }
}
```

For a source checkout, invoke the direct CLI entrypoint so stdout remains a
clean ACP stream:

```bash
env OPENCLAW_HIDE_BANNER=1 OPENCLAW_SUPPRESS_NOTES=1 node openclaw.mjs acp
```

## Options

- `--session <key>`: default local OpenClaw session key
- `--session-label <label>`: resolve an existing local session by label
- `--require-existing`: fail if the selected key or label does not exist
- `--reset-session`: reset the selected session before binding
- `--no-prefix-cwd`: do not add the ACP working directory to prompt context
- `--provenance <off|meta|meta+receipt>`: control ACP ingress provenance
- `--configure-model`: run model provider/default setup and exit
- `--verbose, -v`: write verbose ACP diagnostics to stderr

### `acp client` options

- `--cwd <dir>`: working directory for the ACP session
- `--server <command>`: ACP server command, default `openclaw`
- `--server-args <args...>`: extra arguments passed to the ACP server
- `--server-verbose`: enable verbose server diagnostics
- `--verbose, -v`: enable verbose client diagnostics

## Security

The ACP process can expose normal OpenClaw tools, including terminal and code
execution. The host must provide an appropriate human approval contract or
restrict who can invoke the agent.

Each unattended integration should use its own credentials and identity. Do not
reuse a human owner or administrator credential for an automated ACP agent.

## Related

- [CLI reference](/cli)
- [ACP agents](/tools/acp-agents)
- [ACP agent setup](/tools/acp-agents-setup)
