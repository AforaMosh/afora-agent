---
summary: "CLI reference for `afora browser` (lifecycle, profiles, tabs, actions, state, and debugging)"
read_when:
  - You use `afora browser` and want examples for common tasks
  - You want to control a browser running on another machine via a node host
  - You want to attach to your local signed-in Chrome via Chrome MCP
title: "Browser"
---

# `afora browser`

Manage Afora's browser control surface and run browser actions: lifecycle, profiles, tabs, snapshots, screenshots, navigation, input, state emulation, and debugging.

Related: [Browser tool](/tools/browser)

## Common flags

- `--url <gatewayWsUrl>`: Gateway WebSocket URL (defaults to config).
- `--token <token>`: Gateway token (if required).
- `--timeout <ms>`: request timeout in ms (default: `30000`).
- `--expect-final`: wait for a final Gateway response.
- `--browser-profile <name>`: choose a browser profile (default: `afora`, or `browser.defaultProfile`).
- `--json`: machine-readable output (where supported). This is a browser-level option, so
  place it before the subcommand for an unambiguous form, such as
  `afora browser --json status`. Trailing placement such as
  `afora browser status --json` also works when the selected child command does not
  define its own `--json`.

## Quick start (local)

```bash
afora browser profiles
afora browser --browser-profile afora start
afora browser --browser-profile afora open https://example.com
afora browser --browser-profile afora snapshot
```

Agents can run the same readiness check with `browser({ action: "doctor" })`.

## Quick troubleshooting

If `start` fails with `not reachable after start`, troubleshoot CDP readiness first. If `start` and `tabs` succeed but `open` or `navigate` fails, the browser control plane is healthy and the failure is usually a navigation SSRF policy block.

Minimal sequence:

```bash
afora browser --browser-profile afora doctor
afora browser --browser-profile afora start
afora browser --browser-profile afora tabs
afora browser --browser-profile afora open https://example.com
```

Detailed guidance: [Browser troubleshooting](/tools/browser#cdp-startup-failure-vs-navigation-ssrf-block)

## Lifecycle

```bash
afora browser status
afora browser doctor
afora browser doctor --deep
afora browser start
afora browser start --headless
afora browser stop
afora browser --browser-profile afora reset-profile
```

- `doctor --deep` adds a live snapshot probe: useful when basic CDP readiness is green but you want proof the current tab can be inspected.
- For a running local managed profile, `status` and `doctor` report cached
  graphics diagnostics from Chrome: hardware/software classification, renderer,
  backend, device/driver, feature and disabled-status details, and accelerated
  video capabilities. `afora browser --json status` returns the full structured payload.
  Passive status never launches Chrome just to collect these facts.
- `stop` closes the active control session and clears temporary emulation overrides even for `attachOnly` and remote CDP profiles where Afora did not launch the browser process itself. For local managed profiles, `stop` also stops the spawned browser process.
- `start --headless` applies only to that start request, and only when Afora launches a local managed browser. It does not rewrite `browser.headless` or profile config, and is a no-op for an already-running browser.
- On Linux hosts without `DISPLAY` or `WAYLAND_DISPLAY`, local managed profiles run headless automatically unless `AFORA_BROWSER_HEADLESS=0`, `browser.headless=false`, or `browser.profiles.<name>.headless=false` explicitly requests a visible browser.

## If the command is missing

If `afora browser` is an unknown command, check `plugins.allow` in `~/.afora/afora.json`. When `plugins.allow` is present, list the bundled browser plugin explicitly unless the config already has a root `browser` block:

```json5
{
  plugins: {
    allow: ["telegram", "browser"],
  },
}
```

An explicit root `browser` block (for example `browser.enabled=true` or `browser.profiles.<name>`) also activates the bundled browser plugin under a restrictive plugin allowlist.

Related: [Browser tool](/tools/browser#missing-browser-command-or-tool)

## Profiles

Profiles are named browser routing configs:

- `afora` (default): launches or attaches to a dedicated Afora-managed Chrome instance (isolated user data dir).
- `user`: controls your existing signed-in Chrome session via Chrome DevTools MCP.
- custom CDP profiles: point at a local or remote CDP endpoint.

```bash
afora browser profiles
afora browser system-profiles
afora browser system-profiles --browser brave
afora browser import-profile --browser chrome --system Default --into imported
afora browser import-profile --system "Profile 1" --into work --domains google.com,youtube.com
afora browser create-profile --name work --color "#FF5A36"
afora browser create-profile --name chrome-live --driver existing-session
afora browser create-profile --name remote --cdp-url https://browser-host.example.com
afora browser delete-profile --name work
```

Use a specific profile with `--browser-profile <name>` on any subcommand, for example `afora browser --browser-profile work tabs`.

On macOS, `system-profiles` lists real Chrome, Brave, Edge, or Chromium profiles available on the host. `import-profile` decrypts their cookies after one macOS Keychain/Touch ID consent prompt and injects them into a fresh Afora-managed profile. It imports cookies only; local storage and IndexedDB are unchanged. Some Google sessions use device-bound session credentials (DBSC) and can still require re-authentication after import.

When the macOS app uses a local Gateway, it can offer this import once and make the isolated imported profile the default for agent browsing. Import always requires an explicit click; successful import or dismissal suppresses later automatic prompts, and **Settings → General → Browser login** remains available for re-import.

System-profile import is enabled by default. Set `browser.allowSystemProfileImport=false` to disable both CLI and agent-triggered imports. Import is host-local and cannot run through the browser node proxy.

### Cookie sync to a remote Gateway

`import-profile` targets a managed profile on the same host. When your Afora Gateway and agent browser run on a separate computer, use `cookie-sync` to decrypt cookies on this Mac and push them into a managed profile on that remote Gateway over the operator connection:

```bash
afora browser cookie-sync --domains github.com,news.ycombinator.com --into work
afora browser --url wss://gateway.example.com cookie-sync --domains github.com --into work --watch
```

- `--domains` is required. Cookie sync copies live session cookies, so it never sends an unrestricted cookie jar; a missing or empty allowlist is a hard error.
- `--into` selects the target managed profile on the Gateway (default `imported`); `--gateway`/`--url` selects a remote Gateway (default is the configured/local one).
- `--watch` keeps the command running and re-pushes when the source Cookies database changes. The macOS Keychain secret is read once per watch session, so you approve a single consent prompt rather than one per change.
- Decryption is host-local (macOS only) and reuses the same allowlist and Keychain path as `import-profile`. Cookies are decrypted on this Mac and shipped over the existing TLS-pinned Gateway connection; no cookie values are printed.
- Some Google sessions use device-bound session credentials (DBSC) that stay tied to this Mac and can still require re-authentication after sync. For those sites, prefer driving the browser on the Mac itself through the [browser node proxy](#remote-browser-control-node-host-proxy).

The macOS app exposes the same capability under **Settings → General → Cookie sync**: an off-by-default toggle, an editable domain allowlist, and a target-profile field. When enabled in remote mode it supervises `cookie-sync --watch` for you against the connected Gateway and shows a live status row.

## Chrome extension relay

```bash
afora browser extension path
afora browser extension install
afora browser extension install --json --wait-ms 60000
afora browser extension status
afora browser extension status --json
afora browser extension uninstall-host
afora browser extension pair
afora browser extension pair --gateway-url wss://gateway.example.com
afora browser extension cdp
afora browser extension cdp --json
```

- `extension install` pre-registers the origin-locked native bootstrap host in
  existing Chrome-family user-data roots. Run it first, then
  [add Afora from the Chrome Web Store](https://chromewebstore.google.com/detail/afora/kcdjddhmeafeomebliikmbpblkmkfoig).
  The stable **Load unpacked** path remains available as a development fallback.
- `extension status` reports Store discovery separately from approved unpacked
  IDs and paths, plus owned-registration health and whether manual setup is
  required. JSON output never includes a pairing string or relay key.
- `extension uninstall-host` removes only verified Afora-owned native-host
  manifests and launchers. It does not remove the extension from Chrome.
- `extension path` is read-only. It prints the stable installed copy when
  present and the bundled source directory otherwise.
- `extension pair` remains the advanced manual flow. `--gateway-url` creates a
  direct remote-Gateway pairing URL; non-loopback URLs must use `wss://`.
- `extension cdp` prints non-secret Browser Relay Authentication v2 metadata:
  the loopback browser/CDP endpoints, protocol version, key ID, and fixed
  challenge/complete binding. It never prints the relay key or an authorization
  header by default.

Automatic local bootstrap connects through the local Gateway's exact
`/browser/extension` route so the first authenticated extension connection
starts the lazy browser-control service. Keep `afora gateway run` or the
managed Gateway service running; no separate browser request or prewarm is
needed. Local Afora and mcporter calls still use the profile relay port
reported by `extension pair` or `extension cdp` after that wakeup. Browser-node
pairings continue to use the relay on the browser-node host, while explicit
`--gateway-url` pairings remain direct-remote and manual-only.

The advanced manual `extension pair` command without `--gateway-url` retains
the host-local `/extension` relay URL. It does not wake Browser control, so the
selected profile relay must already be running before the extension connects.

`extension cdp --legacy-bearer` is a temporary migration escape hatch. It
prints the old Bearer header with a warning only while
`browser.extensionRelay.allowLegacyAuth=true`; otherwise it exits with an error
without printing a credential. Use `--json` for machine output; warnings remain
on stderr so stdout stays valid JSON.

Setup, security model, and recovery steps: [Chrome extension](/tools/chrome-extension).

If the extension already attempted automatic setup before the native host
existed, Chromium retains that miss for the running browser process. Restart
Chrome once, run `extension install`, then reopen the Store extension; popup
retries alone cannot recover that existing process.

## Tabs

```bash
afora browser tabs
afora browser tab new --label docs
afora browser tab label t1 docs
afora browser tab select 2
afora browser tab close 2
afora browser open https://docs.afora.ai --label docs
afora browser focus docs
afora browser close t1
```

`tabs` returns `suggestedTargetId` first, then the stable `tabId` (such as `t1`), the optional label, and the raw `targetId`. Pass `suggestedTargetId` back into `focus`, `close`, snapshots, and actions. Assign a label with `open --label`, `tab new --label`, or `tab label`; labels, tab ids, raw target ids, and unique target-id prefixes are all accepted. The request field is still named `targetId` for compatibility, but it accepts any of these tab references.

Raw target ids are volatile diagnostic handles, not durable agent memory: when Chromium replaces the underlying raw target during a navigation or form submit, Afora keeps the stable `tabId`/label attached to the replacement tab when it can prove the match. Prefer `suggestedTargetId`.

## Snapshot / screenshot / actions

Snapshot:

```bash
afora browser snapshot
afora browser snapshot --urls
```

Screenshot:

```bash
afora browser screenshot
afora browser screenshot --full-page
afora browser screenshot --ref e12
afora browser screenshot --labels
```

- `--full-page` is for page captures only; it cannot be combined with `--ref` or `--element`.
- `existing-session` / `user` profiles support page screenshots and `--ref` screenshots from snapshot output, but not CSS `--element` screenshots.
- `--labels` overlays current snapshot refs on the screenshot. On Playwright-backed profiles it works with `--full-page` (full-page overlay), `--ref` (element-clip overlay by ARIA ref), and `--element` (element-clip overlay by CSS selector); in element-clip modes labels are projected relative to the element. The response also includes an `annotations` array (omitted when empty) with each ref's bounding box: `ref`, `number`, `role`, optional `name`, and `box: {x, y, width, height}` in the captured image's coordinate space (viewport / fullpage / element-relative).
  `existing-session` profiles render a chrome-mcp overlay on page screenshots but do not use the Playwright projection helper and do not include `annotations`; CSS `--element` screenshots are unsupported there. Without Playwright or chrome-mcp, labeled screenshots are not available.
- `snapshot --urls` appends discovered link destinations to AI snapshots so agents can choose direct navigation targets instead of guessing from link text alone.

Navigate/click/type (ref-based UI automation):

```bash
afora browser navigate https://example.com
afora browser click <ref>
afora browser click-coords 120 340
afora browser type <ref> "hello"
afora browser press Enter
afora browser hover <ref>
afora browser scrollintoview <ref>
afora browser drag <startRef> <endRef>
afora browser select <ref> OptionA OptionB
afora browser fill --fields '[{"ref":"1","value":"Ada"}]'
afora browser wait --text "Done"
afora browser evaluate --fn '(el) => el.textContent' --ref <ref>
afora browser evaluate --fn 'const title = document.title; return title;'
afora browser evaluate --timeout-ms 30000 --fn 'async () => { await window.ready; return true; }'
```

`evaluate --fn` accepts a function source, an expression, or a statement body. Statement bodies are wrapped as async functions, so use `return` for the value you want back. Use `--timeout-ms` when the page-side function may need longer than the default evaluate timeout. `browser.evaluateEnabled=false` (default: `true`) disables both `evaluate` and `wait --fn`.

Action responses return the current raw `targetId` after action-triggered page replacement when Afora can prove the replacement tab. Scripts should still store and pass `suggestedTargetId`/labels for long-lived workflows.

File + dialog helpers:

```bash
afora browser upload /tmp/afora/uploads/file.pdf --ref <ref>
afora browser upload media://inbound/file.pdf --ref <ref>
afora browser waitfordownload
afora browser download <ref> report.pdf
afora browser dialog --accept
afora browser dialog --dismiss --dialog-id d1
```

Managed Chrome profiles save ordinary click-triggered downloads into the Afora downloads directory (`/tmp/afora/downloads` by default, or the configured temp root). Use `waitfordownload` or `download` when the agent needs to wait for a specific file and return its path; those explicit waiters own the next download. Uploads accept files from the Afora temp uploads root and Afora-managed inbound media, including `media://inbound/<id>` and sandbox-relative `media/inbound/<id>` references. Nested media refs, traversal, and arbitrary local paths are rejected.

When an action opens a modal dialog, the action response returns `blockedByDialog` with `browserState.dialogs.pending`; pass `--dialog-id` to answer it directly. Dialogs handled outside Afora appear under `browserState.dialogs.recent`.

Batch actions:

```bash
afora browser batch --actions '[{"kind":"wait","timeMs":500},{"kind":"click","ref":"12"},{"kind":"type","ref":"23","text":"hello"}]'
afora browser batch --actions-file plan.json
afora browser batch --actions-file - --continue
```

`afora browser batch` sends a `kind="batch"` `/act` request with nested `BrowserActRequest` actions (`wait`, `click`, `type`, `evaluate`, ...) — not `open`/`navigate`/`snapshot`/`screenshot`, which are CLI subcommands, not `/act` kinds. `--continue` sets `stopOnError=false` (default stops on first error); `--target-id` scopes the whole batch to one tab. A failed nested action makes the command exit nonzero; use `--json` to retain the ordered `results` response. See [Browser batch CLI](/tools/browser-control#browser-batch-cli) for the full contract (ref lifecycle, target id conflicts, error summary). `batch` is not supported on `profile="user"` / existing-session profiles.

## State and storage

Viewport + emulation:

```bash
afora browser resize 1280 720
afora browser set viewport 1280 720
afora browser set offline on
afora browser set media dark
afora browser set timezone Europe/London
afora browser set locale en-GB
afora browser set geo 51.5074 -0.1278 --accuracy 25
afora browser set device "iPhone 14"
afora browser set headers '{"x-test":"1"}'
afora browser set credentials myuser mypass
```

Cookies + storage:

```bash
afora browser cookies
afora browser cookies set session abc123 --url https://example.com
afora browser cookies clear
afora browser storage local get
afora browser storage local set token abc123
afora browser storage session clear
```

## Debugging

```bash
afora browser console --level error
afora browser pdf
afora browser responsebody "**/api"
afora browser highlight <ref>
afora browser errors --clear
afora browser requests --filter api
afora browser trace start
afora browser trace stop --out trace.zip
```

## Existing Chrome via MCP

Use the built-in `user` profile, or create your own `existing-session` profile:

```bash
afora browser --browser-profile user tabs
afora browser create-profile --name chrome-live --driver existing-session
afora browser create-profile --name brave-live --driver existing-session --user-data-dir "~/Library/Application Support/BraveSoftware/Brave-Browser"
afora browser create-profile --name chrome-port --driver existing-session --cdp-url http://127.0.0.1:9222
afora browser --browser-profile chrome-live tabs
```

The default existing-session path is host-only Chrome MCP auto-connect. If the browser is already running with a DevTools endpoint, pass `--cdp-url` so Chrome MCP attaches to that endpoint instead. For Docker, Browserless, or other remote setups where Chrome MCP semantics are not needed, use a CDP profile instead.

Current existing-session limits:

- Snapshot-driven actions use refs, not CSS selectors.
- Supported `act` requests use a built-in 60000 ms default when callers omit `timeoutMs`; per-call `timeoutMs` still wins.
- `click` is left-click only.
- `type` does not support `slowly=true`.
- `press` does not support `delayMs`.
- `hover`, `scrollintoview`, `drag`, `select`, and `fill` reject per-call timeout overrides; `evaluate` accepts `--timeout-ms`.
- `select` supports one value only.
- `wait --load networkidle` is not supported (works on managed and raw/remote CDP profiles).
- File uploads require `--ref` / `--input-ref`, do not support CSS `--element`, and support one file at a time.
- Dialog hooks do not support `--timeout`.
- Screenshots support page captures and `--ref`, but not CSS `--element`.
- `responsebody`, download interception, PDF export, and batch actions still require a managed browser or raw CDP profile.

## Remote browser control (node host proxy)

If the Gateway runs on a different machine than the browser, run a **node host** on the machine that has Chrome/Brave/Edge/Chromium. The Gateway proxies browser actions to that node; no separate browser control server is required.

Use `gateway.nodes.browser.mode` to control auto-routing and `gateway.nodes.browser.node` to pin a specific node if multiple are connected.

Security + remote setup: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)

## Related

- [CLI reference](/cli)
- [Browser](/tools/browser)
