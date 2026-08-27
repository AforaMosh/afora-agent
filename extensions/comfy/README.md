# @afora/comfy-provider

Official ComfyUI image, video, and music generation provider plugin for
Afora.

## Install

```bash
afora plugins install @afora/comfy-provider
afora gateway restart
```

## Configure

Local ComfyUI workflows do not require credentials. Comfy Cloud workflows use
`COMFY_API_KEY` or `COMFY_CLOUD_API_KEY`.

Full workflow, model, and provider configuration:

- https://docs.afora.ai/providers/comfy

## Package

- Plugin id: `comfy`
- Package: `@afora/comfy-provider`
- Minimum Afora host: `2026.7.2`
