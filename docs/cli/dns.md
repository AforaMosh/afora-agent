---
summary: "CLI reference for `afora dns` (wide-area discovery helpers)"
read_when:
  - You want wide-area discovery (DNS-SD) via Tailscale + CoreDNS
  - You're setting up split DNS for a custom discovery domain (example: afora.internal)
title: "DNS"
---

# `afora dns`

DNS helpers for wide-area discovery (Tailscale + CoreDNS). Currently macOS + Homebrew CoreDNS only.

Related:

- Gateway discovery: [Discovery](/gateway/discovery)
- Wide-area discovery config: [Configuration](/gateway/configuration)

## `dns setup`

Plan or apply CoreDNS setup for unicast DNS-SD discovery.

```bash
afora dns setup
afora dns setup --domain afora.internal
afora dns setup --apply
```

| Option              | Effect                                                                              |
| ------------------- | ----------------------------------------------------------------------------------- |
| `--domain <domain>` | Wide-area discovery domain (for example `afora.internal`).                       |
| `--apply`           | Install/update CoreDNS config and (re)start the service. Requires sudo, macOS only. |

Without `--domain`, Afora uses `discovery.wideArea.domain` from config. Setting that domain enables wide-area discovery.

Without `--apply`, the command only prints:

- Resolved discovery domain and zone file path
- Current tailnet IPs
- Recommended `afora.json` discovery config
- Tailscale Split DNS nameserver/domain values to set in the Tailscale admin console

With `--apply` (macOS only, requires Homebrew CoreDNS):

- Bootstraps the zone file if missing
- Adds the CoreDNS import stanza if missing
- Restarts the `coredns` brew service

## Related

- [CLI reference](/cli)
- [Discovery](/gateway/discovery)
