# Phase `vendor-pkgs` — vendor the five external @openclaw packages

Read `docs/afora/briefs/00-COMMON.md` first.

These are published npm packages owned by upstream, imported throughout the tree:
`@openclaw/uirouter`, `@openclaw/fs-safe` (and its subpaths: `/advanced`, `/durability`,
`/test-hooks`, `/path`, `/temp`, `/secret`, `/root`), `@openclaw/crabline`,
`@openclaw/proxyline`, `@openclaw/libterminal` (and `/browser`).

Decision already made: **vendor them in-tree.** Do not depend on the published names.

Do this, one package at a time, smallest first:

1. Create `packages/<name>/` in this workspace as `@afora/<name>`, sourced from the
   installed copy in `node_modules/@openclaw/<name>` (use its published source, keep its
   exports map and subpath entry points identical so imports only change scope).
2. Preserve the package's own LICENSE file inside `packages/<name>/` verbatim. That is
   required attribution and stays.
3. Rewrite every import in the repo from `@openclaw/<name>` to `@afora/<name>`, subpaths
   included. Add the package to `pnpm-workspace.yaml`.
4. Drop the old dependency from every `package.json` that declares it.
5. Run `pnpm install` so the lockfile picks up the workspace packages, then
   `pnpm check:changed`. Fix type errors caused by the move.
6. If a package cannot be vendored (native build, private source, license forbids it),
   STOP on that one, leave it untouched, and explain precisely why in your report.
   Do the others.
7. Remove the matching `pattern:` lines from `docs/afora/REBRAND-ALLOWLIST.txt` for each
   package you actually vendored.
