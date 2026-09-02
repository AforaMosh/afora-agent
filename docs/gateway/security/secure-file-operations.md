---
summary: "How Afora handles local file access safely, and why optional fs-safe native acceleration is off by default"
read_when:
  - Changing file access, archive extraction, workspace storage, or plugin filesystem helpers
title: "Secure file operations"
---

Afora uses the vendored `@afora/fs-safe` package (`packages/fs-safe`) for security-sensitive local file operations: root-bounded reads/writes, atomic replacement, archive extraction, temp workspaces, JSON state, and secret-file handling.

It is a **library guardrail** for trusted Afora code that receives untrusted path names, not a sandbox. Host filesystem permissions, OS users, containers, and the agent/tool policy still define the real blast radius.

## Default: JavaScript fallback

Afora sets fs-safe's optional native helper to **off** by default:

- Afora bundles fs-safe into its own build and ships no native platform binding;
- the guarded JavaScript paths support Afora's normal filesystem operations;
- disabling native loading keeps runtime behavior deterministic across desktop, Docker, CI, and bundled-app environments.

Afora only changes the _default_. An explicit setting always wins:

```bash
# Default Afora behavior: guarded JavaScript fs-safe paths.
AFORA_FS_SAFE_NATIVE_MODE=off

# Prefer native primitives when the platform package is installed.
AFORA_FS_SAFE_NATIVE_MODE=auto

# Fail closed when an operation needs native support and the binding is unavailable.
AFORA_FS_SAFE_NATIVE_MODE=require
```

The generic fs-safe environment name also works: `FS_SAFE_NATIVE_MODE`.

fs-safe 0.5 temporarily maps the retired `FS_SAFE_PYTHON_MODE` and `AFORA_FS_SAFE_PYTHON_MODE` values to native modes and emits a deprecation warning. Migrate those names before fs-safe 0.6; Python interpreter path settings are no longer used.

`auto` uses the guarded JavaScript implementation when the platform binding is unavailable, which is always the case for an Afora install. `require` fails closed on every operation that needs the binding.

## What stays protected without native acceleration

With the helper off, Afora still gets fs-safe's Node-only guardrails:

- rejects relative-path escapes (`..`), absolute paths, and path separators where only bare names are allowed;
- resolves operations through a trusted root handle instead of ad-hoc `path.resolve(...).startsWith(...)` checks;
- refuses symlink and hardlink patterns on APIs that require that policy;
- opens files with identity checks where the API returns or consumes file contents;
- writes state/config files via atomic sibling-temp + rename;
- enforces byte limits for reads and archive extraction;
- applies private file modes for secrets and state files where the API requires them.

This covers Afora's normal threat model: trusted gateway code handling untrusted model/plugin/channel path input inside a single trusted operator boundary.

## What native acceleration adds

The optional platform package provides policy-free filesystem primitives used by fs-safe for create-only writes, guarded hard-link publication, asynchronous sidecar creation, and explicit no-replace rename publication. Linux uses `openat2` and `renameat2`; macOS uses descriptor-relative component checks and `renameatx_np`; Windows uses handle-relative operations and replacement-disabled rename.

The TypeScript layer still owns policy, validation, retries, cleanup, and fallback decisions. Native support narrows filesystem race windows; it does not turn fs-safe into a sandbox.

Afora does not ship those bindings, so the sections above describe upstream fs-safe capability that an Afora install cannot enable. Deployments that need native primitives must supply their own fs-safe build; `AFORA_FS_SAFE_NATIVE_MODE=require` alone only makes the affected operations fail closed.

## Plugin and core guidance

- Plugin-facing file access should go through `afora/plugin-sdk/*` helpers, not raw `fs`, when a path comes from a message, model output, config, or plugin input.
- Core code should use the fs-safe wrappers under `src/infra/*` so Afora's process policy applies consistently.
- Archive extraction should use the fs-safe archive helpers with explicit size, entry-count, link, and destination limits.
- Secrets should use Afora secret helpers or fs-safe secret/private-state helpers; do not hand-roll mode checks around `fs.writeFile`.
- For hostile local-user isolation, do not rely on fs-safe alone. Run separate gateways under separate OS users/hosts, or use sandboxing.

Related: [Security](/gateway/security), [Sandboxing](/gateway/sandboxing), [Exec approvals](/tools/exec-approvals), [Secrets](/gateway/secrets).
