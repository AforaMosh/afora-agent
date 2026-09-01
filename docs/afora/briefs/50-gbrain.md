# Phase `gbrain` — retire the gbrain name

Read `docs/afora/briefs/00-COMMON.md` first.

Only ~6 files and ~23 lines, but the name has to go. New name: **Afora Brain**, package
`@afora/brain`, CLI binary `afora-brain`, on-disk state dir `.afora/brain`.

Do this:

1. Rename every `gbrain` identifier, import, path, config key, doc mention and CLI
   invocation to the names above. Case-correct: `gbrain` to `afora-brain`, `GBrain` to
   `AforaBrain`, `GBRAIN_` env prefix to `AFORA_BRAIN_`.
2. If a config key or state path changes, extend the migration module created in the
   `compat-shims` phase rather than adding a second migration.
3. Grep the whole tree afterwards, docs and tests included, and confirm zero hits.
