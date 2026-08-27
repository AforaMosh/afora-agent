# @afora/acpx

Official ACP runtime backend for Afora.

ACPx lets Afora run external coding harnesses through the Agent Client Protocol while Afora still owns sessions, channels, delivery, permissions, and Gateway state.

## Install

```bash
afora plugins install @afora/acpx
```

Restart the Gateway after installing or updating the plugin.

## What it provides

- ACP-backed agent runtime sessions.
- Plugin-owned session and transport management.
- MCP bridge helpers for Afora tools and plugin tools.
- Static runtime assets used by the ACP process bridge.

## Configure

Use the ACP docs for harness-specific setup, permission modes, and model/runtime selection:

- https://docs.afora.ai/tools/acp-agents-setup
- https://docs.afora.ai/tools/acp-agents

## Package

- Plugin id: `acpx`
- Package: `@afora/acpx`
- Minimum Afora host: `2026.4.25`
