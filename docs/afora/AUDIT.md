# afora agent audit: making the fork bespoke and efficient

Against `afora-agent` at `fdc298b2b7c` (openclaw `1ea18c8cd8c`).

Target deployment, from the existing Friday setup: one DigitalOcean droplet (`afora-friday-host`, 2 GB / 1 vCPU, Ubuntu 24.04), Caddy terminating TLS on `*.aforademo.com`, one agent instance per user at `u-<id>.aforademo.com`, spawned by the spine.

**Everything below is static analysis. I have measured nothing.** No instance was started, no RSS sampled, no build run. Each finding names the measurement that would confirm it, and the ones marked MEASURE FIRST should not be acted on until you have the number.

The constraint that shapes every answer: **N instances share 2 GB.** Every megabyte of per-instance baseline multiplies by N. That makes startup footprint, not throughput, the thing to optimize.

---

## Finding 1: you are shipping 149 extensions to run maybe 8

`extensions/` contains 149 directories with an `openclaw.plugin.json`. afora needs a small handful: one model provider, gbrain, whatever channel the product actually uses, and the core web surface.

**You do not need to edit the agent for this.** The mechanism already exists upstream and is wired through the Docker build:

- `Dockerfile:49` runs `scripts/lib/docker-plugin-selection.mjs` with `$OPENCLAW_EXTENSIONS` and writes the chosen set to `/out/openclaw-selected-plugin-dirs`.
- That list gates dependency install (`Dockerfile:51-57`), the build (`Dockerfile:150-158`), and a prune pass.
- `Dockerfile:180` then runs `scripts/prune-docker-plugin-dist.mjs`, which removes omitted plugin files **and their unshared runtime dependencies** from the production output.

So this is a build arg, not a patch:

```
OPENCLAW_EXTENSIONS="anthropic afora-gbrain web ..." docker build .
```

This is almost certainly the single largest win available, it costs one line of build config, and it survives every upstream rebase untouched. Do it before anything else in this document.

**MEASURE:** image size and container RSS at idle, before and after. If it does not move both materially, stop here and re-plan, because the rest of this document assumes extension load dominates.

## Finding 2: 31 extensions activate at startup

```
extensions with "onStartup": true   31
extensions total                    149
```

The 31: `active-memory acpx anthropic browser canvas bonjour cua-computer device-pair diffs diagnostics-prometheus diagnostics-otel diffs-language-pack file-transfer google-meet linux-node linux-canvas llm-task logbook lobster memory-wiki openshell policy ollama reef opencode teams-meetings talk-voice workboard webhooks voice-call zoom-meetings`

Read that list against afora's product. `cua-computer`, `zoom-meetings`, `teams-meetings`, `google-meet`, `voice-call`, `talk-voice`, `bonjour`, `device-pair`, `browser`, `openshell`, and `ollama` are each a process, a port, a watcher, or a native dependency that starts on every instance boot for every user.

Finding 1 removes these by not shipping them, which is the right fix. This finding exists to tell you *which* ones to be deliberate about, and to flag that `onStartup: true` is the field to grep when you add an extension later.

**MEASURE:** startup wall time and RSS delta per extension. `active-memory` and `memory-wiki` are the two to watch, since gbrain replaces both and leaving them enabled would mean two memory systems racing for the same slot.

## Finding 3: no runtime heap cap (this one is a real risk)

```
Dockerfile:13   ARG  ...BUILD_NODE_OPTIONS="--max-old-space-size=8192"   (build only)
Dockerfile:90   NODE_OPTIONS=--max-old-space-size=2048 pnpm install      (build only)
```

Nothing sets `--max-old-space-size` for the **running** agent. V8's default heap limit on a 64-bit host is derived from total system memory, not from a container share, so every instance believes it may grow toward roughly the whole box. With N instances on 2 GB, the failure mode is not graceful degradation, it is the OOM killer picking a victim, and the victim is whichever user happened to be mid-turn.

**Fix:** set a runtime cap per instance, sized to `2 GB / expected N` with headroom, e.g. `NODE_OPTIONS=--max-old-space-size=384` for four instances. Set it in the spine's container spawn, not in the Dockerfile, so it can vary with density.

**MEASURE FIRST:** run one instance through a realistic session and watch peak RSS. Setting the cap too low turns an occasional OOM kill into a reliable crash, which is worse. Get the number before you pick it.

Related: `src/gateway/server-idle-task.ts` and `src/gateway/active-sessions-shutdown-drain.ts` exist and are worth reading for idle eviction, since scaling to zero between sessions beats tuning a heap cap. I did not read either file.

## Finding 4: what owning the agent actually unlocks

These are the things that were impossible as a pure openclaw consumer. This is the part of the audit that answers your actual question.

**4a. Delete rather than disable.** As a consumer you can only turn features off in config; the code still ships and still has a security surface (the push just reported 41 Dependabot vulnerabilities: 1 critical, 16 high, 20 moderate, 4 low, most of which will live in extension dependencies you do not use). Owning the fork means deleting `extensions/` you will never enable. Do this *after* Finding 1 proves the build-arg path works, because build selection gets you the same runtime benefit with no rebase cost. Deleting is for when you want the CVE surface gone too.

**4b. Change agent defaults instead of shipping config to every instance.** Model choice, tool policy, system prompt, workshop autonomy, memory behavior. Today the spine would have to write these into every per-user `afora.json`. In a fork they are defaults in code, which means one place to change and no drift between users. Highest-value targets: default model, `skills.workshop.autonomous.mode`, and the tool allowlist.

**4c. Cut the multi-agent machinery you do not use.** openclaw carries per-agent scoping throughout: `src/config/agent-dirs.ts`, `src/agents/agent-scope.ts`, `src/state/openclaw-agent-db-registry.ts`, `src/fleet/`, agent roster provenance. afora's model is one agent per instance, which means every one of those lookups resolves to a constant. This is genuine dead weight, but it is also load-bearing plumbing threaded through a lot of files. **Do not touch this until 1 through 3 are done and measured.** It is the highest-effort, highest-regret item here.

**4d. A per-user system prompt seam.** If afora wants each user's agent to know who it is working for, that is a fork-level change to prompt assembly. Cheap, and it is the kind of thing that makes the product feel bespoke rather than a rebranded shell. Needs a product decision from you about what it should say.

**4e. Strip the CLI surface.** `src/cli/` carries a large command set your users never invoke, since they reach the agent through the web surface. Lazy version: leave it, it is mostly cold code that costs disk, not RAM. Only worth doing if startup module resolution turns out to be slow, which Finding 1 probably fixes anyway.

## Finding 5: sequencing

1. **Finding 1.** Build arg. Measure image size and idle RSS. One line, biggest win.
2. **Finding 3 measurement.** Peak RSS for one real session. You need this number for capacity planning regardless.
3. **Finding 3 fix.** Heap cap in the spawn path, sized from step 2.
4. **gbrain** (`extensions/afora-gbrain`, per `AFORA-FORK-PLAN.md` section 6), with `active-memory` and `memory-wiki` excluded by step 1 so nothing contends for the memory slot.
5. **Hermes port 1** (curator cron guard, `docs/afora/HERMES-PORTS.md`).
6. **4b defaults.**
7. Everything else only if a measurement says so.

Steps 1 through 3 are a day and are where the efficiency actually lives. Step 4c is a week and might buy nothing. Do not invert that order because 4c sounds more like real engineering.

## What I did not audit

- Did not start an instance, so every performance claim is inference from source.
- Did not read `src/gateway/server-idle-task.ts`, `active-sessions-shutdown-drain.ts`, or the memory-monitor path, all of which bear directly on Finding 3.
- Did not read the spine's container spawn code, so I do not know what env or limits instances get today.
- Did not investigate the 41 Dependabot advisories individually or check which land in extensions Finding 1 would remove.
- Did not look at SQLite footprint per instance, which on N instances sharing one disk may matter as much as heap.
