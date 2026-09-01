# Phase `history` — kill the upstream release history

Read `docs/afora/briefs/00-COMMON.md` first.

Targets, roughly 15,000 of the ~16,000 remaining references:
`CHANGELOG.md`, `docs/releases/**`, `appcast.xml`, `docs/releases/index.md`.

These are upstream OpenClaw's historical release notes and Sparkle feed. Afora is a fork
and does not ship someone else's release history.

Do this:

1. Replace `CHANGELOG.md` with a fresh Afora changelog: a header, a short note that
   history before the fork point lives in upstream's repo, and one `## Unreleased`
   section. Do not carry any upstream entries forward.
2. Delete `docs/releases/**` entirely, including `index.md`. Remove or repoint every
   link into it. Search the docs tree and the UI for links to release notes and fix them.
3. Replace `appcast.xml` with a valid, empty Afora feed (correct XML, Afora title and
   link, zero `<item>` entries), or delete it and remove its references if nothing reads
   it. Check `scripts/` and the Sparkle/macOS app config before deciding.
4. Fix anything that reads these paths: `scripts/check-changelog-attributions.mts`,
   docs navigation/sidebar config, any release tooling. Tests included.
5. Remove the matching `path:` lines from `docs/afora/REBRAND-ALLOWLIST.txt`.
