# @afora/brave-plugin

Official Brave Search provider plugin for Afora.

This plugin registers Brave as a `web_search` provider. It supports normal Brave web search and Brave LLM Context API mode.

## Install

```bash
afora plugins install @afora/brave-plugin
```

Restart the Gateway after installing or updating the plugin.

## Configure

Store a Brave Search API key in plugin config or expose `BRAVE_API_KEY` to the Gateway:

```bash
afora config set plugins.entries.brave.enabled true
afora config set tools.web.search.provider brave
```

Provider-specific options live under `plugins.entries.brave.config.webSearch.*`.

## Docs

Full setup, config examples, search modes, and tool parameters:

- https://docs.afora.ai/tools/brave-search

## Package

- Plugin id: `brave`
- Package: `@afora/brave-plugin`
- Minimum Afora host: `2026.4.10`
