# @afora/pixverse-provider

Official PixVerse video generation provider plugin for Afora.

This plugin registers PixVerse as a `video_generate` provider for text-to-video and image-to-video workflows.

## Install

```bash
afora plugins install @afora/pixverse-provider
```

Restart the Gateway after installing or updating the plugin.

## Configure

Store your PixVerse API key in Afora config or expose the supported environment variable to the Gateway. Then select PixVerse as a video generation provider.

Full setup and model/provider examples:

- https://docs.afora.ai/providers/pixverse

## Package

- Plugin id: `pixverse`
- Package: `@afora/pixverse-provider`
- Minimum Afora host: `2026.5.26`
