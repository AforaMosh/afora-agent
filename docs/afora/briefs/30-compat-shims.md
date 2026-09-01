# Phase `compat-shims` — remove the OpenClaw compatibility surface

Read `docs/afora/briefs/00-COMMON.md` first.

Targets: `src/infra/afora-env-alias.ts` (maps `OPENCLAW_*` to `AFORA_*`), the
`"openclaw": "afora.mjs"` bin alias in `package.json`, the `- "openclaw"` entry in
`pnpm-workspace.yaml`, `openclaw@20xx.*` upgrade-test baselines, `openclaw.json` /
`.openclaw` / `openclaw.plugin.json` / `openclaw.extensions` path handling in
`src/config/paths.ts`, `src/infra/fs-safe.ts`, `src/infra/secret-file.ts`,
`src/infra/boundary-path.ts`, `src/infra/boundary-file-read.ts`,
`packages/memory-host-sdk/src/host/fs-utils.ts` and their tests, and every line marked
with the `afora-compat` marker.

Existing installs have real data in `~/.openclaw` and real `OPENCLAW_*` env vars, so a
blind delete loses tenant state. Do this instead:

1. Make `.afora` / `afora.json` / `afora.plugin.json` / `afora.extensions` the ONLY names
   the code knows. No dual-read, no fallback branch, no `openclaw` string anywhere in the
   resolution path.
2. Add a one-shot migration that runs before config load: if the legacy directory or file
   exists and the new one does not, MOVE it (rename, not copy), log one line, continue.
   Put it in a single new module named for migration, not for the old brand. It may
   contain the legacy path strings, because it is the one place that must: mark those
   lines `afora-migration` and add exactly one `path:` allowlist entry for that file.
   That single file is the only permitted survivor from this phase.
3. Delete `src/infra/afora-env-alias.ts` and its call sites. `AFORA_*` only.
4. Delete the `openclaw` bin alias and the `openclaw` workspace/release-age entries.
5. Repoint upgrade-test baselines at Afora releases, or delete the tests if no Afora
   release exists yet and say which you did.
6. Update docs that tell users about `~/.openclaw`, `openclaw.json` or `OPENCLAW_*`.
7. Remove every entry you retired from `docs/afora/REBRAND-ALLOWLIST.txt`.
