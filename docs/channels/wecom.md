---
summary: "Install the official WeCom plugin and find its versioned setup documentation"
read_when:
  - You want to connect Afora to WeCom
  - You need the supported WeCom plugin and its setup documentation
title: "WeCom"
---

Afora exposes WeCom through the external
`@wecom/wecom-afora-plugin` package maintained by the Tencent WeCom team.
The plugin is listed in Afora's official channel catalog but is not bundled
with the core install.

## Install

```bash
afora channels add --channel wecom
afora gateway restart
afora channels status --channel wecom
```

The Afora catalog installs an exact version of
`@wecom/wecom-afora-plugin`.

## Configure

WeCom credentials, connection modes, callback routes, and access-control
behavior belong to the external plugin and can change independently of
Afora. Follow the
[package documentation](https://www.npmjs.com/package/@wecom/wecom-afora-plugin)
for the installed release before configuring the channel.

When upgrading the plugin independently, keep using the documentation for the
installed version.
