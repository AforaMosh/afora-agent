# REBRAND-LOG: openclaw to Afora, loop record

Methodology: census counts every case and spacing variant of the brand
(regex `open[ _-]?claw`, case-insensitive) across git-tracked files, then
subtracts the allowlist (docs/afora/REBRAND-ALLOWLIST.txt): whole-path
entries, span patterns, and lines carrying the afora-compat marker.
Counting logic is scripts/afora/rebrand.mjs --census, wrapped by
scripts/afora/census.sh, so the census and the codemod share one
definition of "survivor".

## ITER 1 (2026-08-27T22:44Z) baseline

- raw 251851
- allowlisted-by-path 8929 (LICENSE, CHANGELOG.md, docs/releases, pnpm-lock.yaml, patches, appcast.xml, docs/afora, scripts/afora, env shim)
- protected spans 303 (external @openclaw registry packages, bin alias, workspace release-age entry)
- post-allowlist 242619
- buckets: titlecase 87200, plain 83616, env-var 33416, npm-specifier 12044, url 10550, compound 8993, file-name 3045, fs-path 2959, config-key 564, screaming 232
- top files: docs/releases/2026.7.1.md 5797 (now allowlisted), apps/.i18n/native-source.json 4391, apps/macos Localizable.xcstrings 2325, apps/ios Localizable.xcstrings 1242, docs/releases/2026.6.11.md 1087, then large test files and CI workflows
- note: docs/releases/** added to the allowlist after this baseline (historical upstream release notes, same rationale as CHANGELOG.md), so the ITER 2 allowlisted-by-path number will grow by roughly 12k
- plan: hand-write compat shims first (state dir migration, env alias both directions, plugin manifest legacy filename, sqlite legacy basenames), then run the codemod over content, then rename tracked paths, regenerate the lockfile importers, typecheck and build
