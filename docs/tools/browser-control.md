---
summary: "Afora browser control API, CLI reference, and scripting actions"
read_when:
  - Scripting or debugging the agent browser via the local control API
  - Looking for the `afora browser` CLI reference
  - Adding custom browser automation with snapshots and refs
title: "Browser control API"
---

For setup, configuration, and troubleshooting, see [Browser](/tools/browser).
This page is the reference for the local control HTTP API, the `afora browser`
CLI, and scripting patterns (snapshots, refs, waits, debug flows).

## Control API (optional)

For local integrations only, the Gateway exposes a small loopback HTTP API.
This standalone server is opt-in — set the environment variable
`AFORA_EAGER_BROWSER_CONTROL_SERVER=1` in the gateway service environment
and restart the gateway before the HTTP endpoints become available. Without
this variable the browser control runtime still works through the CLI and
agent tools, but nothing listens on the loopback control port.

- Status/start/stop: `GET /`, `GET /doctor`, `POST /start`, `POST /stop`, `POST /reset-profile`
- Profiles: `GET /profiles`, `POST /profiles/create`, `DELETE /profiles/:name`
- Tabs: `GET /tabs`, `POST /tabs/open`, `POST /tabs/focus`, `DELETE /tabs/:targetId`, `POST /tabs/action`
- Snapshot/screenshot: `GET /snapshot`, `POST /screenshot`
- Actions: `POST /navigate`, `POST /act`
- Hooks: `POST /hooks/file-chooser`, `POST /hooks/dialog`
- Downloads: `POST /download`, `POST /wait/download`
- Permissions: `POST /permissions/grant`
- Debugging: `GET /console`, `POST /pdf`
- Debugging: `GET /errors`, `GET /requests`, `GET /dialogs`, `POST /trace/start`, `POST /trace/stop`, `POST /highlight`
- Network: `POST /response/body`
- State: `GET /cookies`, `POST /cookies/set`, `POST /cookies/clear`
- State: `GET /storage/:kind`, `POST /storage/:kind/set`, `POST /storage/:kind/clear`
- Settings: `POST /set/offline`, `POST /set/headers`, `POST /set/credentials`, `POST /set/geolocation`, `POST /set/media`, `POST /set/timezone`, `POST /set/locale`, `POST /set/device`

`POST /tabs/action` is the batched form the CLI uses internally for
`browser tab` subcommands (`{"action":"new"|"label"|"select"|"close"|"list", ...}`);
prefer the single-purpose tab routes above when scripting directly.

All endpoints accept `?profile=<name>`. `POST /start?headless=true` requests a
one-shot headless launch for local managed profiles without changing persisted
browser config; attach-only, remote CDP, and existing-session profiles reject
that override because Afora does not launch those browser processes.

For tab endpoints, `targetId` is the compatibility field name. Prefer passing
`suggestedTargetId` from `GET /tabs` or `POST /tabs/open`; labels and `tabId`
handles such as `t1` are also accepted. Raw CDP target ids and unique raw
target-id prefixes still work, but they are volatile diagnostic handles.

If shared-secret gateway auth is configured, browser HTTP routes require auth too:

- `Authorization: Bearer <gateway token>`
- `x-afora-password: <gateway password>` or HTTP Basic auth with that password

Notes:

- This standalone loopback browser API does **not** consume trusted-proxy or
  Tailscale Serve identity headers.
- If `gateway.auth.mode` is `none` or `trusted-proxy`, these loopback browser
  routes do not inherit those identity-bearing modes; keep them loopback-only.

### `/act` error contract

`POST /act` uses a structured error response for route-level validation and
policy failures:

```json
{ "error": "<message>", "code": "ACT_*" }
```

Current `code` values:

- `ACT_KIND_REQUIRED` (HTTP 400): `kind` is missing or unrecognized.
- `ACT_INVALID_REQUEST` (HTTP 400): action payload failed normalization or validation.
- `ACT_SELECTOR_UNSUPPORTED` (HTTP 400): `selector` was used with an unsupported action kind.
- `ACT_EVALUATE_DISABLED` (HTTP 403): `evaluate` (or `wait --fn`) is disabled by config.
- `ACT_TARGET_ID_MISMATCH` (HTTP 403): top-level or batched `targetId` conflicts with request target.
- `ACT_EXISTING_SESSION_UNSUPPORTED` (HTTP 501): action is not supported for existing-session profiles.

Other runtime failures may still return `{ "error": "<message>" }` without a
`code` field.

### Playwright requirement

Some features (navigate/act/AI snapshot/role snapshot, element
screenshots, PDF) require Playwright. If Playwright isn't installed, those endpoints return
a clear 501 error.

What still works without Playwright:

- ARIA snapshots
- Role-style accessibility snapshots (`--interactive`, `--compact`,
  `--depth`, `--efficient`) when a per-tab CDP WebSocket is available. This is
  a fallback for inspection and ref discovery; Playwright remains the primary
  action engine.
- Page screenshots for the managed `afora` browser when a per-tab CDP
  WebSocket is available
- Page screenshots for `existing-session` / Chrome MCP profiles
- `existing-session` ref-based screenshots (`--ref`) from snapshot output

What still needs Playwright:

- `navigate`
- `act`
- AI snapshots that depend on Playwright's native AI snapshot format
- CSS-selector element screenshots (`--element`)
- full browser PDF export

Element screenshots also reject `--full-page`; the route returns `fullPage is
not supported for element screenshots`.

If you see `Playwright is not available in this gateway build`, the packaged
Gateway is missing the core browser runtime dependency. Reinstall or update
Afora, then restart the gateway. For Docker, also install the Chromium
browser binaries as shown below.

#### Docker Playwright install

If your Gateway runs in Docker, avoid `npx playwright` (npm override conflicts).
For custom images, bake Chromium into the image:

```bash
AFORA_INSTALL_BROWSER=1 ./scripts/docker/setup.sh
```

The browser also needs system libraries, so installing Chromium in a one-off
Compose container is not durable. Rebuild the image with
`AFORA_INSTALL_BROWSER=1` instead. To persist browser downloads and other
caches, persist `/home/node` with `AFORA_HOME_VOLUME` or a bind mount. See
[Docker](/install/docker).

## How it works (internal)

A small loopback control server accepts HTTP requests and connects to Chromium-based browsers via CDP. Advanced actions (click/type/snapshot/PDF) go through Playwright on top of CDP; when Playwright is missing, only non-Playwright operations are available. The agent sees one stable interface while local/remote browsers and profiles swap freely underneath.

## CLI quick reference

All commands accept `--browser-profile <name>` to target a specific profile, and `--json` for machine-readable output.

<AccordionGroup>

<Accordion title="Basics: status, tabs, open/focus/close">

```bash
afora browser status
afora browser doctor
afora browser doctor --deep    # add a live snapshot probe
afora browser start
afora browser start --headless # one-shot local managed headless launch
afora browser stop            # also clears emulation on attach-only/remote CDP
afora browser reset-profile   # moves the profile's browser data to Trash
afora browser tabs
afora browser tab             # shortcut for current tab
afora browser tab new
afora browser tab new --label research
afora browser tab label abcd1234 research
afora browser tab select 2
afora browser tab close 2
afora browser open https://example.com
afora browser focus abcd1234
afora browser close abcd1234
```

</Accordion>

<Accordion title="Profiles: list, create, delete">

```bash
afora browser profiles
afora browser create-profile --name research --color "#0066CC"
afora browser create-profile --name attach --driver existing-session --cdp-url http://127.0.0.1:9222
afora browser delete-profile --name research
```

</Accordion>

<Accordion title="Inspection: screenshot, snapshot, console, errors, requests">

```bash
afora browser screenshot
afora browser screenshot --full-page
afora browser screenshot --ref 12        # or --ref e12
afora browser screenshot --labels
afora browser snapshot
afora browser snapshot --format aria --limit 200
afora browser snapshot --interactive --compact --depth 6
afora browser snapshot --efficient
afora browser snapshot --labels
afora browser snapshot --urls
afora browser snapshot --selector "#main" --interactive
afora browser snapshot --frame "iframe#main" --interactive
afora browser snapshot --out snapshot.txt
afora browser console --level error
afora browser errors --clear
afora browser requests --filter api --clear
afora browser pdf
afora browser responsebody "**/api" --max-chars 5000
```

</Accordion>

<Accordion title="Actions: navigate, click, type, drag, wait, evaluate">

```bash
afora browser navigate https://example.com
afora browser resize 1280 720
afora browser click 12 --double           # or e12 for role refs
afora browser click-coords 120 340        # viewport coordinates
afora browser type 23 "hello" --submit
afora browser press Enter
afora browser hover 44
afora browser scrollintoview e12
afora browser drag 10 11
afora browser select 9 OptionA OptionB
afora browser download e12 report.pdf
afora browser waitfordownload report.pdf
afora browser upload /tmp/afora/uploads/file.pdf
afora browser upload /tmp/afora/uploads/file.pdf --ref e12
afora browser upload media://inbound/file.pdf
afora browser fill --fields '[{"ref":"1","type":"text","value":"Ada"}]'
afora browser dialog --accept
afora browser dialog --dismiss --dialog-id d1
afora browser wait --text "Done"
afora browser wait "#main" --url "**/dash" --load networkidle --fn "window.ready===true"
afora browser evaluate --fn '(el) => el.textContent' --ref 7
afora browser evaluate --fn 'const title = document.title; return title;'
afora browser evaluate --timeout-ms 30000 --fn 'async () => { await window.ready; return true; }'
afora browser highlight e12
afora browser trace start
afora browser trace stop
```

</Accordion>

<Accordion title="State: cookies, storage, offline, headers, geo, device">

```bash
afora browser cookies
afora browser cookies set session abc123 --url "https://example.com"
afora browser cookies clear
afora browser storage local get
afora browser storage local set theme dark
afora browser storage session clear
afora browser set offline on
afora browser set headers --headers-json '{"X-Debug":"1"}'
afora browser set credentials user pass            # --clear to remove
afora browser set geo 37.7749 -122.4194 --origin "https://example.com"
afora browser set media dark
afora browser set timezone America/New_York
afora browser set locale en-US
afora browser set device "iPhone 14"
```

</Accordion>

</AccordionGroup>

Notes:

- The agent-facing `browser` tool exposes `action=download` (required `ref` and
  `path`) and `action=waitfordownload` (optional `path`). Both return the saved
  download URL, suggested filename, and guarded local path. Explicit download
  interception is available for managed Playwright profiles; existing-session
  profiles return an unsupported-operation error.
- Prefer atomic chooser uploads: pass the trigger `--ref` with the upload so Afora arms and clicks in one request. Paths-only `upload` remains supported when a later trigger is intentional. Use `--input-ref` or `--element` to set a file input directly. `dialog` is an arming call; run it before the click/press that triggers the dialog. If an action opens a modal, the action response includes `blockedByDialog` and `browserState.dialogs.pending`; pass that `dialogId` to respond directly. Dialogs handled outside Afora appear under `browserState.dialogs.recent`.
- `click`/`type`/etc require a `ref` from `snapshot` (numeric `12`, role ref `e12`, or actionable ARIA ref `ax12`). CSS selectors are intentionally not supported for actions. Use `click-coords` when the visible viewport position is the only reliable target.
- Download and trace paths are constrained to Afora temp roots: `/tmp/afora{,/downloads}` (fallback: `${os.tmpdir()}/afora/...`).
- `upload` accepts files from the Afora temp uploads root and
  Afora-managed inbound media. Managed inbound media can be referenced as
  `media://inbound/<id>`, sandbox-relative `media/inbound/<id>`, or a resolved
  path inside the managed inbound media directory. Nested media refs,
  traversal, symlinks, hardlinks, and arbitrary local paths are still rejected.
- `upload` can also set file inputs directly via `--input-ref` or `--element`.

Stable tab ids and labels survive Chromium raw-target replacement when Afora
can prove the replacement tab, such as a unique old/new pair for the same URL or
a single old tab becoming a single new tab after form submission. Ambiguous
duplicate-URL replacements receive fresh handles. Raw target ids are still
volatile; prefer `suggestedTargetId` from `tabs` in scripts.

Snapshot flags at a glance:

- `--format ai` (default with Playwright): AI snapshot with numeric refs (`aria-ref="<n>"`).
- `--format aria`: accessibility tree with `axN` refs. When Playwright is available, Afora binds refs with backend DOM ids to the live page so follow-up actions can use them; otherwise treat the output as inspection-only.
- `--efficient` (or `--mode efficient`): compact role snapshot preset. Set `browser.snapshotDefaults.mode: "efficient"` to make this the default (see [Gateway configuration](/gateway/configuration-reference#browser)).
- `--interactive`, `--compact`, `--depth`, `--selector` force a role snapshot with `ref=e12` refs. `--frame "<iframe>"` scopes role snapshots to an iframe.
- With Playwright, `--labels` adds a screenshot with overlayed ref labels
  (prints `MEDIA:<path>`) plus an `annotations` array with each ref's bounding
  box. On `screenshot`, Playwright-backed labels work with `--full-page`,
  `--ref`, and `--element`; on `snapshot`, the accompanying screenshot remains
  viewport-only. Existing-session/chrome-mcp profiles render overlay labels on
  page screenshots but do not return `annotations` or use the Playwright
  full-page/ref/element projection helper. Without Playwright or chrome-mcp,
  labeled screenshots are not available.
- `--urls` appends discovered link destinations to AI snapshots.

## Snapshots and refs

Afora supports two "snapshot" styles:

- **AI snapshot (numeric refs)**: `afora browser snapshot` (default; `--format ai`)
  - Output: a text snapshot that includes numeric refs.
  - Actions: `afora browser click 12`, `afora browser type 23 "hello"`.
  - Internally, the ref is resolved via Playwright's `aria-ref`.

- **Role snapshot (role refs like `e12`)**: `afora browser snapshot --interactive` (or `--compact`, `--depth`, `--selector`, `--frame`)
  - Output: a role-based list/tree with `[ref=e12]` (and optional `[nth=1]`).
  - Actions: `afora browser click e12`, `afora browser highlight e12`.
  - Internally, the ref is resolved via `getByRole(...)` (plus `nth()` for duplicates).
  - Add `--labels` to include a screenshot with overlayed `e12` labels. On
    Playwright-backed profiles this also returns per-ref bounding-box metadata
    (`annotations[]`).
  - Add `--urls` when link text is ambiguous and the agent needs concrete
    navigation targets.

- **ARIA snapshot (ARIA refs like `ax12`)**: `afora browser snapshot --format aria`
  - Output: the accessibility tree as structured nodes.
  - Actions: `afora browser click ax12` works when the snapshot path can bind
    the ref through Playwright and Chrome backend DOM ids.
- If Playwright is unavailable, ARIA snapshots can still be useful for
  inspection, but refs may not be actionable. Re-snapshot with `--format ai`
  or `--interactive` when you need action refs.
- When the driver exposes stable document identity, consecutive AI and role
  snapshots for the same profile, tab, document, and option family append
  `[new]` to ref-bearing lines absent from the previous snapshot. Navigation
  starts a fresh unmarked baseline; existing-session snapshots omit deltas.
  The first snapshot establishes the baseline without markers; later responses
  also expose `newElements`, and add a count footer when the value is nonzero.
  Structured `--format aria` snapshots with `axN` refs do not use delta markers.
- Docker proof for the raw-CDP fallback path: `pnpm test:docker:browser-cdp-snapshot`
  starts Chromium with CDP, runs `browser doctor --deep`, and verifies role
  snapshots include link URLs, cursor-promoted clickables, and iframe metadata.

Ref behavior:

- Refs are **not stable across navigations**; if something fails, re-run `snapshot` and use a fresh ref.
- A batch stops after a committed main-frame navigation—including a same-URL
  reload—or after the page closes. Its `aborted` summary reports the action
  number and skipped count; take a fresh snapshot before issuing dependent
  actions, or use separate act calls when navigation is expected.
- `/act` returns the current raw `targetId` after action-triggered replacement
  when it can prove the replacement tab. Keep using stable tab ids/labels for
  follow-up commands.
- If the role snapshot was taken with `--frame`, role refs are scoped to that iframe until the next role snapshot.
- Unknown or stale `axN` refs fail fast instead of falling through to
  Playwright's `aria-ref` selector. Run a fresh snapshot on the same tab when
  that happens.

## Browser batch CLI

`afora browser batch` runs an array of nested `/act` actions in one `/act`
call (the same `kind="batch"` runtime reached through the agent tool), so CLI
users and scripts can combine actions like `wait`, `click`, `type`, and
`evaluate` into a single replayable plan without per-action round trips. Each
entry in `actions[]` is a `BrowserActRequest` — the closed union the `/act`
route accepts (`click`, `clickCoords`, `type`, `press`, `hover`,
`scrollIntoView`, `drag`, `select`, `fill`, `resize`, `wait`, `evaluate`,
`close`, `batch`) — not arbitrary `afora browser` subcommands. `batch` is
not supported on `profile="user"` and other existing-session (chrome-mcp)
profiles; send actions individually there.

- CLI: `afora browser batch --actions '<json>'`, `afora browser batch
--actions-file plan.json`, or `afora browser batch --actions-file -` to
  read the JSON array from stdin. `--continue` sets `stopOnError=false`; the
  default is to stop on first error. `--target-id` scopes the whole batch to
  one tab.
- Ref lifecycle: refs come from a `snapshot` run before the batch (snapshot is
  not a nested action). A nested action that changes page state — such as a
  `click` that triggers navigation, or an `evaluate` that mutates the DOM — can
  invalidate earlier refs for the rest of the batch. Put state-changing actions
  first, or split into a follow-up batch after re-snapshotting. Navigation and
  re-snapshotting happen outside the batch (`afora browser navigate` /
  `snapshot`), since `open`, `navigate`, and `snapshot` are not `/act` kinds.
- Target id conflicts: a nested action may omit `targetId` or repeat the
  request-level `targetId`; an explicit nested `targetId` that resolves to a
  different tab is rejected with `ACT_TARGET_ID_MISMATCH` before any action
  runs. Batched actions share the request's tab by design.
- Error summary: the response is `{ "results": [{ "ok": true }, { "ok": false,
"error": "<message>" }, ...] }`, one entry per action in order. When
  `stopOnError` is the default, the array ends at the first failure; with
  `--continue` it covers every action. Any failed entry makes the CLI exit
  nonzero; pass `--json` to preserve the full ordered response for scripts.

## Wait power-ups

You can wait on more than just time/text:

- Wait for URL (globs supported by Playwright):
  - `afora browser wait --url "**/dash"`
- Wait for load state:
  - `afora browser wait --load networkidle`
  - Supported on managed `afora` and raw/remote CDP profiles. Profiles using the `existing-session` driver (including the default `user` profile) reject `networkidle`; use `--url`, `--text`, a selector, or `--fn` waits there.
- Wait for a JS predicate:
  - `afora browser wait --fn "window.ready===true"`
- Wait for a selector to become visible:
  - `afora browser wait "#main"`

These can be combined:

```bash
afora browser wait "#main" \
  --url "**/dash" \
  --load networkidle \
  --fn "window.ready===true" \
  --timeout-ms 15000
```

## Debug workflows

When an action fails (e.g. "not visible", "strict mode violation", "covered"):

1. `afora browser snapshot --interactive`
2. Use `click <ref>` / `type <ref>` (prefer role refs in interactive mode)
3. If it still fails: `afora browser highlight <ref>` to see what Playwright is targeting
4. If the page behaves oddly:
   - `afora browser errors --clear`
   - `afora browser requests --filter api --clear`
5. For deep debugging: record a trace:
   - `afora browser trace start`
   - reproduce the issue
   - `afora browser trace stop` (prints `TRACE:<path>`)

## JSON output

`--json` is for scripting and structured tooling.

Examples:

```bash
afora browser --json status
afora browser --json snapshot --interactive
afora browser --json requests --filter api
afora browser --json cookies
```

Role snapshots in JSON include `refs` plus a small `stats` block (lines/chars/refs/interactive) so tools can reason about payload size and density.

## State and environment knobs

These are useful for "make the site behave like X" workflows:

- Cookies: `cookies`, `cookies set`, `cookies clear`
- Storage: `storage local|session get|set|clear`
- Offline: `set offline on|off`
- Headers: `set headers --headers-json '{"X-Debug":"1"}'` (or the positional form `set headers '{"X-Debug":"1"}'`)
- HTTP basic auth: `set credentials user pass` (or `--clear`)
- Geolocation: `set geo <lat> <lon> --origin "https://example.com"` (or `--clear`)
- Media: `set media dark|light|no-preference|none`
- Timezone / locale: `set timezone ...`, `set locale ...`
- Device / viewport:
  - `set device "iPhone 14"` (Playwright device presets)
  - `set viewport 1280 720`

## Security and privacy

- The afora browser profile may contain logged-in sessions; treat it as sensitive.
- `browser act kind=evaluate` / `afora browser evaluate` and `wait --fn`
  execute arbitrary JavaScript in the page context. Prompt injection can steer
  this. Disable it with `browser.evaluateEnabled=false` if you do not need it.
- `afora browser evaluate --fn` accepts a function source, an expression, or
  a statement body. Statement bodies are wrapped as async functions, so use
  `return` for the value you want back. Use `--timeout-ms <ms>` when the
  page-side function may need longer than the default evaluate timeout.
- For logins and anti-bot notes (X/Twitter, etc.), see [Browser login + X/Twitter posting](/tools/browser-login).
- Keep the Gateway/node host private (loopback or tailnet-only).
- Remote CDP endpoints are powerful; tunnel and protect them.

Strict-mode example (block private/internal destinations by default):

```json5
{
  browser: {
    ssrfPolicy: {
      dangerouslyAllowPrivateNetwork: false,
      allowedHostnames: ["*.example.com", "example.com", "localhost"],
    },
  },
}
```

## Related

- [Browser](/tools/browser) - overview, configuration, profiles, security
- [Browser login](/tools/browser-login) - signing in to sites
- [Browser Linux troubleshooting](/tools/browser-linux-troubleshooting)
- [Browser WSL2 troubleshooting](/tools/browser-wsl2-windows-remote-cdp-troubleshooting)
