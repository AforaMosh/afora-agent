# @afora/openshell-sandbox

Official NVIDIA OpenShell sandbox backend for Afora.

This plugin lets Afora use OpenShell-managed sandboxes with mirrored local workspaces and SSH command execution.

Configuring an OpenShell workspace requires OpenShell `v0.0.88` or newer. The
plugin supports OpenShell control-plane workspaces through
`plugins.entries.openshell.config.workspace`; this is separate from Afora's
local/remote filesystem workspace mode. The setting applies to the whole plugin
instance, not individual agents or sessions. When unset, the plugin preserves
the OpenShell CLI's ambient `OPENSHELL_WORKSPACE` selection, or its `default`
fallback when no ambient selection exists.

## Install

```bash
afora plugins install @afora/openshell-sandbox
```

Restart the Gateway after installing or updating the plugin.

## Configure

Use the OpenShell docs for credentials, workspace mirroring, runtime selection, and troubleshooting:

- https://docs.afora.ai/gateway/openshell

## Package

- Plugin id: `openshell`
- Package: `@afora/openshell-sandbox`
- Minimum Afora host: `2026.5.12-beta.1`
