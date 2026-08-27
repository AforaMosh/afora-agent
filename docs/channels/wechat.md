---
summary: "WeChat channel setup through the external afora-weixin plugin"
read_when:
  - You want to connect Afora to WeChat or Weixin
  - You are installing or troubleshooting the afora-weixin channel plugin
  - You need to understand how external channel plugins run beside the Gateway
title: "WeChat"
---

Afora connects to WeChat through Tencent's external
`@tencent-weixin/afora-weixin` channel plugin.

Status: external plugin, maintained by the Tencent Weixin team. Direct chats and
media are supported. Group chats are not advertised by the plugin capability
metadata (it declares direct chats only).

## Naming

- **WeChat** is the user-facing name in these docs.
- **Weixin** is the name used by Tencent's package and by the plugin id.
- `afora-weixin` is the Afora channel id (`weixin` and `wechat` work as aliases).
- `@tencent-weixin/afora-weixin` is the npm package.

Use `afora-weixin` in CLI commands and config paths.

## How it works

The WeChat code does not live in the Afora core repo. Afora provides the
generic channel plugin contract, and the external plugin provides the
WeChat-specific runtime:

1. `afora plugins install` installs `@tencent-weixin/afora-weixin`.
2. The Gateway discovers the plugin manifest and loads the plugin entrypoint.
3. The plugin registers channel id `afora-weixin`.
4. `afora channels login --channel afora-weixin` starts QR login.
5. The plugin stores account credentials under the Afora state directory
   (`~/.afora` by default).
6. When the Gateway starts, the plugin starts its Weixin monitor for each
   configured account.
7. Inbound WeChat messages are normalized through the channel contract, routed to
   the selected Afora agent, and sent back through the plugin outbound path.

That separation matters: Afora core stays channel-agnostic. WeChat login,
Tencent iLink API calls, media upload/download, context tokens, and account
monitoring are owned by the external plugin.

## Install

Quick install:

```bash
npx -y @tencent-weixin/afora-weixin-cli install
```

Manual install:

```bash
afora plugins install "@tencent-weixin/afora-weixin"
afora config set plugins.entries.afora-weixin.enabled true
```

Restart the Gateway after install:

```bash
afora gateway restart
```

## Login

Run QR login on the same machine that runs the Gateway:

```bash
afora channels login --channel afora-weixin
```

Scan the QR code with WeChat on your phone and confirm the login. The plugin saves
the account token locally after a successful scan.

To add another WeChat account, run the same login command again. For multiple
accounts, isolate direct-message sessions by account, channel, and sender:

```bash
afora config set session.dmScope per-account-channel-peer
```

## Access control

Direct messages use the normal Afora pairing and allowlist model for channel
plugins.

Approve new senders:

```bash
afora pairing list afora-weixin
afora pairing approve afora-weixin <CODE>
```

For the full access-control model, see [Pairing](/channels/pairing).

## Compatibility

The plugin checks the host Afora version at startup.

| Plugin line | Afora version                                                | npm tag  |
| ----------- | --------------------------------------------------------------- | -------- |
| `2.x`       | `>=2026.5.12` (current 2.4.6; early 2.x accepted `>=2026.3.22`) | `latest` |
| `1.x`       | `>=2026.1.0 <2026.3.22`                                         | `legacy` |

If the plugin reports that your Afora version is too old, either update
Afora or install the legacy plugin line:

```bash
afora plugins install @tencent-weixin/afora-weixin@legacy
```

## Sidecar process

The WeChat plugin can run helper work beside the Gateway while it monitors the
Tencent iLink API. In issue #68451, that helper path exposed a bug in Afora's
generic stale-Gateway cleanup: a child process could try to clean up the parent
Gateway process, causing restart loops under process managers such as systemd.

Current Afora startup cleanup excludes the current process and its ancestors,
so a channel helper cannot kill the Gateway that launched it. This fix is
generic; it is not a WeChat-specific path in core.

## Troubleshooting

Check install and status:

```bash
afora plugins list
afora channels status --probe
afora --version
```

If the channel shows as installed but does not connect, confirm that the plugin is
enabled and restart:

```bash
afora config set plugins.entries.afora-weixin.enabled true
afora gateway restart
```

If the Gateway restarts repeatedly after enabling WeChat, update both Afora and
the plugin:

```bash
npm view @tencent-weixin/afora-weixin version
afora plugins install "@tencent-weixin/afora-weixin" --force
afora gateway restart
```

If startup reports that the installed plugin package `requires compiled runtime
output for TypeScript entry`, the npm package was published without the compiled
JavaScript runtime files Afora needs. Update/reinstall after the plugin
publisher ships a fixed package, or temporarily disable/uninstall the plugin.

Temporary disable:

```bash
afora config set plugins.entries.afora-weixin.enabled false
afora gateway restart
```

## Related docs

- Channel overview: [Chat Channels](/channels)
- Pairing: [Pairing](/channels/pairing)
- Channel routing: [Channel Routing](/channels/channel-routing)
- Plugin architecture: [Plugin Architecture](/plugins/architecture)
- Channel plugin SDK: [Channel Plugin SDK](/plugins/sdk-channel-plugins)
- External package: [@tencent-weixin/afora-weixin](https://www.npmjs.com/package/@tencent-weixin/afora-weixin)
