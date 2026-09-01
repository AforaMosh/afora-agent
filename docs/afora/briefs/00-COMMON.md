# Debrand briefs: common rules

Goal (Reilly, 2026-09-01): **every single OpenClaw- and gbrain-branded thing is gone**
from this repo. The old `docs/afora/REBRAND-ALLOWLIST.txt` recorded deliberate survivors.
Those survivors are no longer acceptable. Your job is to remove the survivor category
your brief names, and delete its entries from the allowlist as you go.

Rules for every phase:

- Work only inside `~/work/afora-rebrand`, on the current branch. Do not push.
- The product is **Afora**. Scope is `@afora`. CLI is `afora`. Config dir is `.afora`,
  config file `afora.json`, env prefix `AFORA_`. Docs host is `docs.afora.ai`.
- Never remove or alter upstream copyright lines in `LICENSE` or
  `THIRD_PARTY_NOTICES.md`. Those are legally required attribution and are OUT OF SCOPE
  for every phase. Leave them exactly as they are.
- After your edits, `pnpm check:changed` must pass. Run it yourself and fix what you break.
  If a check is unrelated-broken before you start, say so in your report and move on.
- Do not leave TODOs, dead compat branches, or commented-out old names.
- Write a short report to `docs/afora/briefs/reports/<phase-id>.md`: what you changed,
  what you could not change and exactly why, and the remaining reference count from
  `git grep -icI -e openclaw -e gbrain`.
- Do not commit. The driver commits after the gate passes.
