# Phase `lockfile` — lockfile and patches

Read `docs/afora/briefs/00-COMMON.md` first.

Targets: `pnpm-lock.yaml` (16 lines), `patches/**`.

Never hand-edit either. After the earlier phases removed the `@openclaw/*` dependencies
and the `openclaw` workspace entry, regenerate:

1. `pnpm install --lockfile-only`, then confirm the lockfile no longer names openclaw.
2. If a `patches/` file still patches an `@openclaw/*` package, that package is now
   vendored: fold the patch into the vendored source in `packages/`, delete the patch
   file, and drop its `pnpm.patchedDependencies` entry.
3. If any openclaw reference survives in the lockfile, it means a transitive dependency
   still pulls an upstream package. Name that dependency chain exactly in your report
   (`pnpm why`) rather than editing the lockfile.
4. Remove the matching `path:` lines from `docs/afora/REBRAND-ALLOWLIST.txt`.
