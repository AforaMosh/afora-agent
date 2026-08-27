---
summary: "Shared Docker VM runtime steps for long-lived Afora Gateway hosts"
read_when:
  - You are deploying Afora on a cloud VM with Docker
  - You need the shared binary bake, persistence, and update flow
title: "Docker VM runtime"
---

Shared runtime steps for VM-based Docker installs such as GCP, Hetzner, and similar VPS providers.

## Bake required binaries into the image

Installing binaries inside a running container is a trap: anything installed
at runtime is lost on restart. Bake every external binary a skill needs into
the image at build time.

The examples below cover three binaries only, alphabetically:

- `gog` (from `gogcli`) for Gmail access
- `goplaces` for Google Places
- `wacli` for WhatsApp

These are examples, not a complete list. Docker Compose builds the repo-root
`Dockerfile`, so extend that file rather than creating a standalone example or
replacing its contents. The repository Dockerfile has required
`workspace-deps`, build, runtime-assets, and final runtime stages. Its manifest
extraction covers the `packages/*` and selected `extensions/*` workspaces before
`pnpm install --frozen-lockfile`.

For Debian packages, prefer the existing build argument:

```bash
export AFORA_IMAGE_APT_PACKAGES="socat"
```

For downloaded release binaries such as `gog`, `goplaces`, or `wacli`, add the
download and install commands to the repo-root `Dockerfile` final runtime stage,
after its package-install blocks and before `USER node`. Preserve the existing
non-root uid 1000 setup, `tini` entrypoint, health check, and `afora` symlink.
Then rebuild and restart the containers.

<Note>
The repository Dockerfile digest-pins its Node and Bun base images. Keep those
reviewed pins instead of changing them to floating `FROM node:24-bookworm`
references. For ARM-based VMs, choose `arm64` release assets for extra binaries;
for reproducible builds, use versioned asset URLs and verify their checksums.
</Note>

## Build and launch

```bash
docker compose build
docker compose up -d afora-gateway
```

If the build fails with `Killed` or exit code 137 during `pnpm install --frozen-lockfile`, the VM is out of memory. Use a larger machine class before retrying.

Verify binaries:

```bash
docker compose exec afora-gateway which gog
docker compose exec afora-gateway which goplaces
docker compose exec afora-gateway which wacli
```

Expected output:

```text
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

Verify the gateway is up:

```bash
docker compose logs -f afora-gateway
curl -fsS http://127.0.0.1:18789/healthz
```

`/healthz` returning a 200 response confirms the gateway process is listening and healthy; the built-in image `HEALTHCHECK` polls the same endpoint.

## What persists where

Afora runs in Docker, but Docker is not the source of truth. All long-lived state must survive restarts, rebuilds, and reboots.

| Component              | Location                                               | Persistence mechanism  | Notes                                                                                                               |
| ---------------------- | ------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Gateway config         | `/home/node/.afora/`                                | Host volume mount      | Includes `afora.json`                                                                                            |
| Channel/provider creds | `/home/node/.afora/credentials/`                    | Host volume mount      | Channel and provider credential material                                                                            |
| Model auth profiles    | `/home/node/.afora/agents/`                         | Host volume mount      | `agents/<agentId>/agent/auth-profiles.json` (OAuth, API keys)                                                       |
| Legacy OAuth key file  | `/home/node/.config/afora/`                         | Host volume mount      | Read-only compat for pre-migration OAuth sidecars; `afora doctor --fix` migrates these into `auth-profiles.json` |
| Skill configs          | `/home/node/.afora/skills/`                         | Host volume mount      | Skill-level state                                                                                                   |
| Agent workspace        | `/home/node/.afora/workspace/`                      | Host volume mount      | Code and agent artifacts                                                                                            |
| WhatsApp session       | `/home/node/.afora/`                                | Host volume mount      | Preserves QR login                                                                                                  |
| Gmail keyring          | `/home/node/.afora/`                                | Host volume + password | Requires `GOG_KEYRING_PASSWORD`                                                                                     |
| Plugin packages        | `/home/node/.afora/npm`, `/home/node/.afora/git` | Host volume mount      | Downloadable plugin package roots                                                                                   |
| External binaries      | `/usr/local/bin/`                                      | Docker image           | Must be baked at build time                                                                                         |
| Node runtime           | Container filesystem                                   | Docker image           | Rebuilt every image build                                                                                           |
| OS packages            | Container filesystem                                   | Docker image           | Do not install at runtime                                                                                           |
| Docker container       | Ephemeral                                              | Restartable            | Safe to destroy                                                                                                     |

## Updates

To update Afora on the VM:

```bash
git pull
docker compose build
docker compose up -d
```

## Related

- [Docker](/install/docker)
- [Podman](/install/podman)
- [ClawDock](/install/clawdock)
