# BRIEF — Total Afora rebrand of the agent harness (LOOP UNTIL ZERO)

You are a Fable 5 worker running under Claude Code on Reilly's Mac. This file is your
whole assignment. Read it fully before you touch anything. Reilly is away for about an
hour; he expects this branch to be real, building, and loop-verified when he gets back.

## The one sentence version

Make the word "openclaw" disappear from this product, in every form a human or a script
can see, and replace it with Afora branding, without breaking a single tenant that is
running right now.

## Repo and branches

- Repo: `AforaMosh/afora-agent` (a private-org fork of `openclaw/openclaw`).
- Base branch: `afora`. Someone already started: `src/infra/afora-env-alias.ts`,
  `src/config/paths.ts`, `package.json`, `docs/afora/AUDIT.md`. Read those first and
  extend that approach, do not fight it or rewrite it from scratch.
- Your branch: `afora-rebrand` (already created off `afora`; this brief is committed on it).
- Work in `/Users/reilly/cmux-bridge-work/afora-rebrand`. Clone there if it does not exist.
- Commit early and often on `afora-rebrand`. Push after every loop iteration. Do NOT
  merge to `afora` or `main`. Open a PR `afora-rebrand -> afora` once the first full
  green loop lands, then keep pushing to it.

## What "eradicated" means

Every one of these, in source, docs, comments, tests, fixtures, CLI help, log lines,
error strings, system prompts the agent reads about itself, JSON schema descriptions,
plugin manifests, launchd/systemd unit names, Docker labels, and shell scripts:

- `openclaw`, `OpenClaw`, `OPENCLAW`, `Openclaw`, `open claw`, `open-claw`
- `openclaw.ai`, `openclaw.org`, `docs.openclaw.ai`, `github.com/openclaw/openclaw`
- `@openclaw/` scoped package names
- `~/.openclaw`, `.openclaw/`, `openclaw.json`
- the `openclaw` binary/bin name, the npm package name
- the lobster/claw motif in user-facing copy ("the lobster way", the crab emoji) where
  it is branding rather than a joke someone deliberately wrote

Replacements: `afora` / `Afora` / `AFORA`, `afora.ai` where a domain is needed,
`AforaMosh/afora-agent` for the repo URL, `@afora/` for the scope, `~/.afora`,
`afora.json`. When the agent describes itself, it runs on **Afora**, not OpenClaw.

## HARD CONSTRAINT — live tenants must not break

Tenants are running on this harness right now with `~/.openclaw` on disk, `OPENCLAW_*`
in their env, and `openclaw` on their PATH. A clean break bricks them. So every rename
ships with a compatibility shim, and the shim is part of the definition of done:

1. **Binary**: `afora` is the real bin. `openclaw` stays as an additional bin entry that
   is an alias to the same entrypoint. Undocumented, not in help output, but it works.
2. **Config dir**: read `~/.afora` first. If it is absent and `~/.openclaw` exists,
   migrate it once (copy, do not delete, leave a `.migrated-to-afora` marker) and log
   one line about it. If both exist, `~/.afora` wins.
3. **Env vars**: `AFORA_*` is canonical. `OPENCLAW_*` is still honored as a fallback with
   a deprecation note at debug level only. `src/infra/afora-env-alias.ts` already does
   some of this; finish it and make it total.
4. **Config keys**: any `openclaw`-named key inside config JSON keeps working as an alias.
5. **npm scope**: real published `@openclaw/*` dependencies that we consume from the
   registry keep their real names. You cannot rename someone else's published package.
   Only rename first-party packages that we publish or vendor.

## Do NOT touch

- Git remote URLs pointing at `openclaw/openclaw` upstream. We need those to merge
  upstream releases. Same for anything in `.github/workflows` that syncs upstream.
- `LICENSE` and the original-author attribution inside it.
- Lockfile integrity hashes and `node_modules`.
- Any string that IS the compat shim (the alias table, the migration code, the tests
  that assert `OPENCLAW_*` still works). Those must keep saying `openclaw` on purpose.
- Historical entries in changelogs describing what upstream OpenClaw did in a past release.

Put every intentional survivor in an allowlist file at `docs/afora/REBRAND-ALLOWLIST.txt`,
one path-plus-reason per line, so the census can subtract it and Reilly can audit it.

## THE LOOP — this is the actual job

Do not do one pass and declare victory. Run this cycle until it converges:

1. **Census.** Run a case-insensitive ripgrep for every variant listed above across the
   whole tree excluding `.git`, `node_modules`, and the allowlist. Record the raw hit
   count, the count after the allowlist, and the top 15 files by hit count.
2. **Append** that census to `docs/afora/REBRAND-LOG.md` with an iteration number and a
   UTC timestamp taken from `date -u`.
3. **Fix** the largest clusters. Prefer real refactors over blind sed. A blind
   `sed -i s/openclaw/afora/g` will corrupt URLs, package resolution and the shims, so
   go directory by directory and understand what each hit is.
4. **Verify.** Build, typecheck, and run the test suite. Fix what you broke. A loop
   iteration that leaves the build red is not finished.
5. **Commit and push.**
6. **Repeat from 1.**

Convergence means: post-allowlist census is **0**, the build is green, the typecheck is
clean, and the test suite passes. When you hit that, do one more full loop anyway to
confirm it is stable, then keep going on the wider sweep below rather than idling.

## After convergence, keep working

Reilly explicitly does not want you to stop. Once the census is zero, move to:

- Runtime self-description: grep the system prompts, the bootstrap context, the help
  text, and the onboarding copy. Ask the built binary what it says it is (`--help`,
  `--version`, `status`) and make sure not one line says OpenClaw.
- Docs: `docs/` rewritten to Afora, including the doc site config and any URL.
- Package metadata: `description`, `homepage`, `bugs`, `author`, `repository`, keywords.
- Error messages and telemetry strings.
- Then re-run the whole loop from scratch as a fresh auditor, as if you had not done it.

## Token discipline

Keep this session under 250k tokens. As you approach it, commit, push, and write a
`## HANDOFF` section at the bottom of `docs/afora/REBRAND-LOG.md` saying exactly what
iteration you are on, what is left, and what the current census is. Then say clearly in
the session that you are near the cap. Do not silently die mid-refactor.

## Reporting

Every loop iteration, print one line to the session: `ITER <n> census <before> -> <after>
build <green|red>`. That line is how the orchestrator watching you knows you are alive.
When you converge, print `CONVERGED census 0 build green` on its own line.

## Style rules that apply to everything you write

No em dashes and no en dashes, anywhere, including in code comments, docs and commit
messages. Use a period, a comma, a colon, or parentheses.

## ADDENDUM — the real scale, read this before you plan

Baseline census taken 2026-08-27 on branch `afora`:

- **21,474 files** contain a hit
- **251,744 total occurrences**
- Heaviest: `src/agents` 1887 files, `ui/src` 1308, `src/gateway` 1154, `src/infra` 823,
  `src/commands` 785, `src/plugins` 631, `apps/android` 565, `src/auto-reply` 499,
  `src/cli` 464, `extensions/discord` 445, `src/config` 442, `extensions/telegram` 390,
  `apps/macos` 389, `extensions/codex` 385, `test/scripts` 373

You cannot hand-edit 21k files. **Do not try.** The job is to build a codemod and drive it,
not to open files one at a time. Concretely:

1. **Classify first.** Write `scripts/afora/census.sh` that emits every hit bucketed by
   kind: bare identifier, camelCase/PascalCase compound, SCREAMING_CASE, string literal,
   comment, doc prose, URL, npm package specifier, filesystem path, env var name, config
   key, i18n locale value, test fixture, generated file. Commit the bucket counts.
2. **Codemod the safe buckets** with `scripts/afora/rebrand.mjs`: identifiers, compounds,
   comments, doc prose, log and error strings. Case-preserving (openclaw to afora,
   OpenClaw to Afora, OPENCLAW to AFORA, Openclaw to Afora). Idempotent. Re-runnable.
   Give it `--dry-run` and a per-bucket allow/deny list. That single script should retire
   the large majority of the 251k.
3. **Hand-handle the risky buckets** with real judgment: npm specifiers, upstream URLs,
   `~/.openclaw` paths, `OPENCLAW_*` env vars, config keys, wire-protocol and on-disk
   schema strings, and anything a running tenant's existing state depends on. These are
   where the compat shims live. Getting one of these wrong bricks a tenant.
4. **Generated and vendored files**: find what regenerates them and rebrand the generator,
   then regenerate. Never edit generated output by hand.
5. **i18n locale files**: `apps/android` and `apps/macos` and any `locales/` tree carry
   translated product-name strings. Rebrand the product name in every locale.

Report `ITER <n> census <before> -> <after> build <green|red>` after each pass. The number
must move a lot in the first two passes; if it does not, your codemod is too timid.

## Where you are working, and pushing

You are NOT on Reilly's Mac. You are in the Afora container. The clone is at
`/data/friday/u/u-a3e76c605e/home/work/afora-rebrand`, branch `afora-rebrand`, already
checked out with this brief committed.

**This container has NO push access** (403 from GitHub for `drjpaglialunga-sys`). So:
commit locally, often, with real messages. Do not waste time retrying `git push`. The
orchestrator will push the branch the moment Reilly's laptop is back online. Keep the
history clean and bisectable, because that history IS the deliverable.
