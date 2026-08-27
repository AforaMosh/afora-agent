---
summary: "Install and use Agent Plugins, Codex, Claude, and Cursor bundles as Afora plugins"
read_when:
  - You want to install an Agent Plugins, Codex, Claude, or Cursor-compatible bundle
  - You need to understand how Afora maps bundle content into native features
  - You are debugging bundle detection or missing capabilities
title: "Plugin bundles"
---

Afora can install plugins from four external ecosystems: the vendor-neutral
[**Agent Plugins**](https://agent-plugins.org) standard, plus **Codex**,
**Claude**, and **Cursor**. These are called **bundles** - content and metadata
packs that Afora maps into native features like skills, hooks, and MCP tools.

<Info>
  Bundles are **not** the same as native Afora plugins. Native plugins run
  in-process and can register any capability. Bundles are content packs with
  selective feature mapping and a narrower trust boundary.
</Info>

## Why bundles exist

Many useful plugins are published in the Agent Plugins, Codex, Claude, or
Cursor format. Instead of requiring authors to rewrite them as native Afora
plugins, Afora detects these formats and maps their supported content into
the native feature set. You can install an Agent Plugins package, a Claude
command pack, or a Codex skill bundle and use it immediately.

## Install a bundle

<Steps>
  <Step title="Install from a directory, archive, or marketplace">
    ```bash
    # Local directory
    afora plugins install ./my-bundle

    # Archive
    afora plugins install ./my-bundle.tgz

    # Claude marketplace
    afora plugins marketplace list <source>
    afora plugins install <plugin> --marketplace <source>
    ```

    `<source>` is a local marketplace path/repo or a git/GitHub source.

  </Step>

  <Step title="Verify detection">
    ```bash
    afora plugins list
    afora plugins inspect <id>
    ```

    Bundles show `Format: bundle` plus a `Bundle format:` value of
    `agent (Agent Plugins)`, `codex`, `claude`, or `cursor`.

  </Step>

  <Step title="Restart and use">
    ```bash
    afora gateway restart
    ```

    Mapped features (skills, hooks, MCP tools, LSP defaults) are available in the next session.

  </Step>
</Steps>

## What Afora maps from bundles

Not every bundle feature runs in Afora today. Here is what works and what
is detected but not yet wired.

### Supported now

| Feature       | How it maps                                                                                       | Applies to     |
| ------------- | ------------------------------------------------------------------------------------------------- | -------------- |
| Skill content | Bundle skill roots load as normal Afora skills                                                 | All formats    |
| Commands      | `commands/` and `.cursor/commands/` treated as skill roots                                        | Claude, Cursor |
| Hook packs    | Afora-style `HOOK.md` + `handler.ts` layouts                                                   | Codex          |
| MCP tools     | Bundle MCP config merged into embedded Afora settings; supported stdio and HTTP servers loaded | All formats    |
| Env contract  | `PLUGIN_ROOT` and `PLUGIN_DATA` env vars plus placeholder expansion for stdio MCP servers         | Agent Plugins  |
| LSP servers   | Claude `.lsp.json` and manifest-declared `lspServers` merged into embedded Afora LSP defaults  | Claude         |
| Settings      | Claude `settings.json` imported as embedded Afora defaults                                     | Claude         |

#### Skill content

- Bundle skill roots load as normal Afora skill roots.
- Claude `commands/` roots are treated as additional skill roots.
- Cursor `.cursor/commands/` roots are treated as additional skill roots.

Claude markdown command files and Cursor command markdown both work through the
normal Afora skill loader.

#### Hook packs

Bundle hook roots work **only** when they use the normal Afora hook-pack
layout: `HOOK.md` plus `handler.ts` or `handler.js`. Today this is primarily
the Codex-compatible case.

#### MCP for embedded Afora

- Enabled bundles can contribute MCP server config.
- Afora merges bundle MCP config into the effective embedded Afora
  settings as `mcpServers`.
- Afora exposes supported bundle MCP tools during embedded Afora agent
  turns by launching stdio servers or connecting to HTTP servers.
- The `coding` and `messaging` tool profiles include bundle MCP tools by
  default; use `tools.deny: ["bundle-mcp"]` to opt out for an agent or gateway.
- Project-local embedded agent settings still apply after bundle defaults, so
  workspace settings can override bundle MCP entries when needed.
- Bundle MCP tool catalogs are sorted deterministically before registration, so
  upstream `listTools()` order changes do not thrash prompt-cache tool blocks.

##### Transports

MCP servers can use stdio or HTTP transport.

**Stdio** launches a child process:

```json
{
  "mcp": {
    "servers": {
      "my-server": {
        "command": "node",
        "args": ["server.js"],
        "env": { "PORT": "3000" }
      }
    }
  }
}
```

**HTTP** connects to a running MCP server, defaulting to `sse` unless
`streamable-http` is requested:

```json
{
  "mcp": {
    "servers": {
      "my-server": {
        "url": "http://localhost:3100/mcp",
        "transport": "streamable-http",
        "headers": {
          "Authorization": "Bearer ${MY_SECRET_TOKEN}"
        },
        "connectionTimeoutMs": 30000
      }
    }
  }
}
```

- `transport` accepts `"streamable-http"` or `"sse"`; omitted defaults to `sse`.
- `type: "http"` is a CLI-native downstream shape; use `transport: "streamable-http"` in Afora config. `afora mcp set` and `afora doctor --fix` normalize the common alias.
- Only `http:` and `https:` URL schemes are allowed.
- `headers` values support `${ENV_VAR}` interpolation.
- A server entry with both `command` and `url` is rejected.
- URL credentials (userinfo and query params) are redacted from tool
  descriptions and logs.
- `connectionTimeoutMs` overrides the default 30-second connection timeout for
  both stdio and HTTP transports. Request timeout defaults to 60 seconds and
  can be overridden with `requestTimeoutMs`.

##### Tool naming

Afora registers bundle MCP tools with provider-safe names in the form
`serverName__toolName`. For example, a server keyed `"vigil-harbor"` exposing a
`memory_search` tool registers as `vigil-harbor__memory_search`.

- Characters outside `A-Za-z0-9_-` are replaced with `-`.
- Fragments that would start with a non-letter get a letter prefix, so numeric
  server keys such as `12306` become provider-safe tool prefixes.
- Server prefixes are capped at 30 characters.
- Full tool names are capped at 64 characters.
- Empty server names fall back to `mcp`.
- Colliding sanitized names are disambiguated with numeric suffixes.
- Final exposed tool order is deterministic by safe name, keeping repeated
  embedded-agent turns cache-stable.
- Profile filtering treats every tool from one bundle MCP server as
  plugin-owned by `bundle-mcp`, so profile allow/deny lists can reference
  either individual exposed tool names or the `bundle-mcp` plugin key.

#### Embedded Afora settings

Claude `settings.json` is imported as default embedded Afora settings when
the bundle is enabled. Afora sanitizes shell override keys before applying
them:

- `shellPath`
- `shellCommandPrefix`

#### Embedded Afora LSP

- Enabled Claude bundles can contribute LSP server config.
- Afora loads `.lsp.json` plus any manifest-declared `lspServers` paths.
- Bundle LSP config is merged into the effective embedded Afora LSP
  defaults.
- Only supported stdio-backed LSP servers are runnable today; unsupported
  transports still show up in `afora plugins inspect <id>`.

### Detected but not executed

These are recognized and shown in diagnostics, but Afora does not run them:

- Claude `agents`, `hooks/hooks.json` automation, `outputStyles`
- Cursor `.cursor/agents`, `.cursor/hooks.json`, `.cursor/rules`
- Codex `.app.json` metadata beyond capability reporting

## Bundle formats

<AccordionGroup>
  <Accordion title="Agent Plugins bundles">
    Marker: `plugin.json` at the package root, per the open
    [Agent Plugins 1.0.0 standard](https://agent-plugins.org)

    Optional content: `skills/`, `mcp.json`

    Format behavior:

    - The manifest is strict JSON (not JSON5). Afora requires a non-empty
      `name`; other manifest fields are optional and unknown fields are ignored
    - Immediate child directories of `skills/` that contain a `SKILL.md` load as
      skills; children without one are skipped with a warning, and deeper
      directories are not scanned
    - `mcp.json` must declare the 1.0.0 `$schema` and an `mcpServers` object
      only; `stdio`, `streamable-http`, and legacy `sse` transports are
      supported
    - stdio servers launch with `PLUGIN_ROOT` (the plugin root) and
      `PLUGIN_DATA` (a persistent per-plugin data directory Afora creates
      under its state dir) in their environment; `${PLUGIN_ROOT}` and
      `${PLUGIN_DATA}` placeholders expand in `args`, `env` values, and `cwd`
      in a single pass
    - A stdio `command` must be a bare executable name or a `./`-relative path
      inside the plugin; `cwd` must stay inside `PLUGIN_ROOT` or `PLUGIN_DATA`
    - Invalid `mcp.json` disables MCP for the plugin with a diagnostic while
      skills keep loading; invalid individual server entries are skipped
    - `.mcp.json` (dot-prefixed) and inline manifest `mcpServers` are **not**
      read for this format; the standard's closed schema wins
    - Afora reads `extensions["ai.afora"]`; it currently supports
      `activation` with the same semantics as other bundle manifests
    - Other manifest extension namespaces are ignored and reserved for their
      clients
    - Reverse-domain client directories are ignored and reserved

  </Accordion>

  <Accordion title="Codex bundles">
    Markers: `.codex-plugin/plugin.json`

    Optional content: `skills/`, `hooks/`, `.mcp.json`, `.app.json`

    Codex bundles fit Afora best when they use skill roots and Afora-style
    hook-pack directories (`HOOK.md` + `handler.ts`).

  </Accordion>

  <Accordion title="Claude bundles">
    Two detection modes:

    - **Manifest-based:** `.claude-plugin/plugin.json`
    - **Manifestless:** default Claude layout (`skills/`, `commands/`, `agents/`, `hooks/`, `.mcp.json`, `.lsp.json`, `settings.json`)

    Claude-specific behavior:

    - `commands/` is treated as skill content
    - `settings.json` is imported into embedded Afora settings (shell override keys are sanitized)
    - `.mcp.json` exposes supported stdio tools to embedded Afora
    - `.lsp.json` plus manifest-declared `lspServers` paths load into embedded Afora LSP defaults
    - `hooks/hooks.json` is detected but not executed
    - Custom component paths in the manifest are additive; they extend defaults, not replace them

  </Accordion>

  <Accordion title="Cursor bundles">
    Markers: `.cursor-plugin/plugin.json`

    Optional content: `skills/`, `.cursor/commands/`, `.cursor/agents/`, `.cursor/rules/`, `.cursor/hooks.json`, `.mcp.json`

    - `.cursor/commands/` is treated as skill content
    - `.cursor/rules/`, `.cursor/agents/`, and `.cursor/hooks.json` are detect-only

  </Accordion>
</AccordionGroup>

## Detection precedence

Afora checks for native plugin format first:

1. `afora.plugin.json` or a valid `package.json` with `afora.extensions` - treated as a **native plugin**
2. Client-specific bundle markers (`.codex-plugin/`, `.cursor-plugin/`, `.claude-plugin/`) - treated as a **bundle** in that format
3. A root `plugin.json` - treated as an **Agent Plugins bundle**
4. Default manifestless Claude layout (`skills/`, `commands/`, `.mcp.json`, ...) - treated as a **Claude bundle**

If a package carries both a client-specific marker and a root `plugin.json`,
the client-specific format wins so its richer mappings (commands, hooks,
settings) are preserved. If a directory contains both a native manifest and
bundle markers, Afora uses the native path. This prevents dual-format
packages from being partially installed as bundles.

## Runtime dependencies and cleanup

- Third-party compatible bundles do not get startup `npm install` repair. They
  should be installed through `afora plugins install` and ship everything
  they need in the installed plugin directory.
- Afora-owned bundled plugins are either shipped lightweight in core or
  downloadable through the plugin installer. Gateway startup never runs a
  package manager for them.
- `afora doctor --fix` removes stale local bundled-plugin install records
  and can recover downloadable plugins that are missing from the local plugin
  index when config still references them.

## Security

Bundles have a narrower trust boundary than native plugins:

- Afora does **not** load arbitrary bundle runtime modules in-process.
- Skills and hook-pack paths must stay inside the plugin root (boundary-checked).
- Settings files are read with the same boundary checks.
- Supported stdio MCP servers may be launched as subprocesses.

This makes bundles safer by default, but you should still treat third-party
bundles as trusted content for the features they do expose.

## Troubleshooting

<AccordionGroup>
  <Accordion title="Bundle is detected but capabilities do not run">
    Run `afora plugins inspect <id>`. If a capability is listed but marked as
    not wired, that is a product limit, not a broken install.
  </Accordion>

  <Accordion title="Claude command files do not appear">
    Make sure the bundle is enabled and the markdown files are inside a detected
    `commands/` or `skills/` root.
  </Accordion>

  <Accordion title="Claude settings do not apply">
    Only embedded Afora settings from `settings.json` are supported. Afora does
    not treat bundle settings as raw config patches.
  </Accordion>

  <Accordion title="Claude hooks do not execute">
    `hooks/hooks.json` is detect-only. If you need runnable hooks, use the
    Afora hook-pack layout or ship a native plugin.
  </Accordion>
</AccordionGroup>

## Related

- [Install and Configure Plugins](/tools/plugin)
- [Building Plugins](/plugins/building-plugins) - create a native plugin
- [Plugin Manifest](/plugins/manifest) - native manifest schema
