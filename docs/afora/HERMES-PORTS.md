# What is worth taking from hermes-agent

Source analysis: `COMPARE-openclaw-vs-hermes.md`, against hermes-agent `c86197e60` and openclaw `1ea18c8cd8c`.

Ranked by value per hour of work. Items 1 to 4 are patches to files upstream owns, so keep each to one tight hunk marked `// afora:` so you can find them on a rebase. Items 5 and 6 are new code and conflict with nothing.

The short version: hermes is worse than openclaw at almost everything structural, but it is better at **judgment encoded as guardrails**. That is what is worth stealing. Do not port hermes architecture; port its hard-won rules.

---

## 1. Curator cron guard (do this first, ~20 lines)

**Problem it fixes:** a skill referenced only by a cron job that fires monthly looks unused to a usage-counter-driven curator. It gets archived. Next fire, the job breaks. You find out from a customer.

**hermes:** `agent/curator.py:334-341`. Any skill named by any cron job, including paused and disabled ones, is treated exactly like a pinned skill and never auto-transitioned. The reasoning in the comment is the important part: the scheduler only bumps usage when a job actually fires, so jobs firing less often than `archive_after_days`, paused jobs, and far-future one-shots would all have their skills aged out from under them.

**Where it goes:** `src/skills/workshop/curator.ts`. Needs a `referencedSkillNames()` equivalent reading from `src/cron/store.ts`. hermes's version fails soft (`agent/curator.py:296-302`: a cron import error or corrupt job store yields an empty set, so the curator never crashes on it). Copy that failure mode.

**Verify with:** a test that creates a paused cron job referencing a skill with `lastUsedAtMs` older than the archive window, runs the curator, asserts the skill is still `active`.

---

## 2. Declarative-not-imperative memory rule (~10 lines of prompt)

**Problem it fixes:** a memory that says "Always respond concisely" gets re-read as a standing directive in a later session and silently overrides what the user is asking for right now. This is a real and subtle failure mode in any system that injects stored text into a system prompt, which is exactly what gbrain will do.

**hermes:** `agent/prompt_builder.py:186-191`. Memories must be declarative facts, not instructions. "User prefers concise responses" is correct; "Always respond concisely" is not. "Project uses pytest with xdist" is correct; "Run tests with pytest -n 4" is not. Procedures belong in skills, not memory.

**Where it goes:** gbrain's capture prompt, in `extensions/afora-gbrain/memory-policy.ts`. Not `extensions/memory-core` unless you keep that plugin active.

---

## 3. Seven-day staleness rule (~8 lines of prompt)

**Problem it fixes:** openclaw's dreaming promotion is purely score-based (`src/memory-host-sdk/dreaming.ts:44-52`: composite score >= 0.75, 3+ recalls, 3+ unique queries, 14-day half-life). A fact can clear all of that and still be garbage, because frequently-recalled is not the same as durable. "PR #4412 is blocked on review" gets recalled constantly for three days and is worthless on day eight.

**hermes:** `agent/prompt_builder.py:179-185`. Categorical exclusion: no PR numbers, issue numbers, commit SHAs, "fixed bug X", "submitted PR Y", "Phase N done", file counts. The test is stated plainly: if a fact will be stale in a week, it does not belong in memory. Route those to session search instead.

**Where it goes:** same file as item 2. A categorical filter is the right complement to a numeric gate; neither alone is enough.

---

## 4. Aux-model digest policy (real money on a 2 GB VPS)

**Problem it fixes:** openclaw's experience review builds a fresh prompt of up to 60,000 characters after qualifying runs (`src/skills/workshop/experience-review-prompt.ts:6`). On a box you pay for, per turn, that adds up.

**hermes:** `agent/background_review.py:33-45`. The policy is one sentence: run the review on the **main** model by default, because the transcript is already warm in the prompt cache and cache reads are cheap. Only when a user routes the review to a *different* model does the fork replay a compact **digest** instead of the full transcript, because a different model cannot reuse the parent's cache and a full replay would cold-write the whole thing for nothing.

**Where it goes:** `src/skills/workshop/experience-review.ts` model selection, plus a digest builder next to `experience-review-prompt.ts`.

**Measure before and after.** This is the only item here whose value is a number, so get the number.

---

## 5. Journey view (new code, no conflict, highest user-visible value)

**Problem it fixes:** openclaw accumulates strictly more learned state than hermes (workshop proposals, skill lifecycle, usage counters, dreaming artifacts, memory entries) and has no single place to look at it. Users do not trust what they cannot see, and an agent that silently edits its own skills is unsettling without a window into it.

**hermes:** `agent/learning_graph.py` builds the payload, `agent/learning_graph_render.py` draws it, `hermes_cli/journey.py` is the terminal view, and `agent/learning_mutations.py` gives one code path for edit and delete shared by CLI, TUI, and GUI.

**What to copy and what not to.** Copy the *concept* and the mutation design. Do not copy the edge-building: hermes derives memory-to-skill edges by lexical token overlap (`agent/learning_graph.py:227-245`, score 6 if the skill name appears verbatim plus 1 per shared 3-char token, top 4 per card). That is a placeholder. gbrain has real embeddings, so use cosine similarity and get a graph that means something.

**Where it goes:** `ui/` against the existing `skill_lifecycle`, `skill_usage`, and `skill_workshop_proposals` tables, plus gbrain's store. Build it as a read view first; add mutation after.

---

## 6. Bundled-skill manifest with divergence detection

**Problem it fixes:** you ship afora's default skills. A user edits one. You ship an update. Their edit is silently destroyed.

**hermes:** `tools/skills_sync.py:1-23`. Record the origin hash of every bundled skill at the moment it was copied into the user directory. On update, three cases: bundled unchanged, skip without even reading the user copy; bundled changed and user copy still matches the origin hash, safe to update; bundled changed and user copy diverged, the user customized it, **skip**. A skill in the manifest but absent from disk was deleted on purpose and is never re-added.

**Where it goes:** `src/skills/lifecycle/`. openclaw has install and uninstall machinery there but I did not find this specific three-way check.

---

## Deliberately not porting

- **hermes's memory model.** Two markdown files with 2,200 and 1,375 character caps (`tools/memory_tool.py:165`), consolidated by hand by the model, which counts its own failures at doing so (`:174-201`). gbrain is strictly better. The only thing worth taking is the frozen-snapshot discipline, and openclaw already does the equivalent.
- **hermes's curator defaults.** `DEFAULT_CONSOLIDATE = False`, 7-day interval, first run deferred a full interval (`agent/curator.py:70-78`, `:261-276`). This is why hermes's "grows with you" is thinner than its marketing. openclaw defaults the equivalent to on (`src/skills/workshop/config.ts:18-25`). Keep openclaw's default.
- **`batch_runner.py` and the trajectory pipeline.** Offline dataset generation for model training (`batch_runner.py:14-20`, `agent/trajectory.py:31-56`). Nous trains models; unless afora does, this is dead weight.
- **The delegate/subagent design.** `tools/delegate_tool.py`. openclaw's subagent implementation plus its per-agent scoping is more capable.
- **Anything structural.** hermes ships `cli.py` at 20,298 lines and `gateway/run.py` at 29,000+. Do not import that shape.

---

## Order

1, then 2 and 3 together (both are gbrain prompt text, ship with gbrain), then 4 once you have a token bill to compare against, then 6, then 5 when you want something to demo.
