# Phase `tooling` — retire the rebrand machinery itself

Read `docs/afora/briefs/00-COMMON.md` first. Run this phase LAST.

Targets: `docs/afora/**` (the working docs, which quote openclaw deliberately),
`scripts/afora/rebrand.mjs`, `scripts/afora/census.sh`,
`docs/afora/REBRAND-ALLOWLIST.txt`, and these brief files.

By now the allowlist should be empty or hold only the single migration file. Then:

1. Delete `scripts/afora/rebrand.mjs` and the allowlist. The codemod has done its job and
   keeping it keeps the old name alive in the tree.
2. Keep `scripts/afora/census.sh` ONLY if you rewrite it to take zero allowlist input and
   simply assert that `git grep -icI -e openclaw -e gbrain` returns nothing outside
   `LICENSE`, `THIRD_PARTY_NOTICES.md`, vendored package licenses, and the migration
   file. Wire it into `pnpm check:changed` as a permanent regression guard. Otherwise
   delete it.
3. Delete or rewrite `docs/afora/AUDIT.md`, `docs/afora/BRIEF-REBRAND.md`,
   `docs/afora/HERMES-PORTS.md` and `docs/afora/briefs/**` so no working doc still quotes
   the old brand. Keep any content that documents Afora itself; move it somewhere sane.
4. Final check: run the census. Report the exact remaining count and every file it names.
