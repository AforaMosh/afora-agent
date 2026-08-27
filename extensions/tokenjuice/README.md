# @afora/tokenjuice

Official Tokenjuice output compaction plugin for Afora.

Tokenjuice compacts noisy `exec` and `bash` tool results after commands run, before the result is fed back into the active agent session. It does not rewrite commands, rerun commands, or change exit codes.

## Install

```bash
afora plugins install @afora/tokenjuice
```

Restart the Gateway after installing or updating the plugin.

## Enable

```bash
afora config set plugins.entries.tokenjuice.enabled true
```

Equivalent:

```bash
afora plugins enable tokenjuice
```

## Docs

- https://docs.afora.ai/tools/tokenjuice

## Package

- Plugin id: `tokenjuice`
- Package: `@afora/tokenjuice`
- Minimum Afora host: `2026.5.28`
