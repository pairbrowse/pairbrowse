# Development

```
npm test                  # unit tests; live ones need PAIRBROWSE_TEST_RUNTIME=~/.pairbrowse/runtime,
                          # the native launch ones PAIRBROWSE_TEST_ENGINE=~/.pairbrowse/engine
npm ci && npm run lint       # ESLint, no warnings allowed (CI runs it); .claude/ is skipped: its worktrees
                             # are copies of the repo and its workflow scripts are local, not shipped
npm run test:fuzz  # property-based fuzzing of the security checks (test/fuzz, fast-check)
claude plugin validate .  # the Claude Code manifests
```

### The design tokens

`ui/tokens.css` is the one sheet (colors, type, radii; `--edge-input` is a text field's border at 3:1 or more) for the right
dock (the side panel in plain Chromium), the session picker, the new tab page, a joiner's picture page and the live view (served
from the same file through the live view's fixed asset list). The live view alone opts into the
light scheme with `data-scheme="system"`; the extension pages stay dark. `scripts/hud.js` (closed
shadow roots), `ui/capture/record.js` (a canvas) and the "Opening tabs" page in `scripts/tabs.mjs` carry the same hex values inline, and
`test/tokens.test.mjs` keeps every literal color in those files and the page sheets equal to a
sheet value or a `SPARK_COLORS` entry and checks WCAG AA contrast in both schemes. Agent
colors are `SPARK_COLORS` in `scripts/daemon/hud.mjs`, by app (Claude Code orange, Codex purple,
Gemini blue; a second agent of one app, or an app without a color, takes the first free of
`AGENT_FALLBACKS`, cyan first). People's colors are `PEOPLE_COLORS` in `scripts/tabsync.mjs`,
never near an agent's (`test/colors.test.mjs` checks hue, distance and the tags' AA contrast). The window frame follows `THEME_COLOR` in
`scripts/browser.mjs` (the sheet's chrome navy) unless the user picked a theme.

### The pages' harness (ui/)

`test/ui.test.mjs` runs over every `ui/*/index.html`. On every machine it checks each page's
files: no inline script, handler or `style` attribute; `../tokens.css` linked before the page's
own sheet and no token redefined; the logo taken from `ui/` (hash pinned) and never inlined; css
colors that are sheet values; no markup sink (`innerHTML` and the like: Trusted Types); a
reduced-motion block, no transition over 200 ms, no blur, no endless animation but the Live dot.
With `PAIRBROWSE_TEST_RUNTIME` it renders each page and checks: no error, CSP or Trusted Types
entry; an accessible name on every visible control; Tab reaches each one with the 2 px `--accent`
ring; no timer, frame or observer while hidden; no running animation under reduced motion.

Three fakes in `test/helpers/` stand in for the browser build: `pairbrowse-shim.mjs` is
`window.pairbrowse` over the draft `native/mojom/pairbrowse.mojom` (its header is the page
contract), `fake-helper.mjs` answers the live view's owner routes and event stream with the real
key, Host and Origin checks, and `ui-server.mjs` serves `ui/` under the chrome pages' CSP
(`script-src 'self'`, Trusted Types enforced), inserting the harness scripts as same-origin
`<script src>` tags. Pages are served from another origin than the helper, as
`chrome://pairbrowse` will be. Patchright has no console API and its init scripts are inline
(refused by that CSP), so `ui-prelude.js` captures errors, timers and violations in the page.

A page subset copies `test/ui-right.test.mjs` as `test/ui-<page>.test.mjs`: `pageTest(name,
{ fixtures, shim, replies }, fn)` gives it the page, the helper (`push`, `set`, `posts`) and the
shim's controls; the common checks stay in `ui.test.mjs`.

The `DEBT` table at the top of `ui.test.mjs` lists today's known gaps by page and check. The suite
asserts each entry is still true, so the subset that fixes the page removes its entry in the
same change; new pages get none.

For reviews, `node scripts/dev/ui-look.mjs <page> [--width 360 --height 900] [--hash name] [--fixtures f.json]`
renders a page to a PNG and prints its harness log. Its fixtures (`{ helper, replies, shim, push }`)
are `scripts/dev/look/<page>.json` by default, and `--fixtures` replaces them. `--hash nav-left`
renders one of a page's hash modes (the strip's nav fragments and bubbles). `node scripts/dev/ui-look-all.mjs
[--out dir] [--only a,b] [--reduced-motion]` renders every visible page (and the strip's hash modes
and both docks' rails) at its Part B size into `<tmpdir>/pairbrowse-ui-look` by default, one line per
shot with its count of error and CSP entries; it exits 1 when a shot logged one. The harness
serves the picker frameable by same-origin pages only, as the native build will, so the strip's
switcher and the left dock's popover show the real framed picker; every other page refuses any frame.

`node scripts/dev/window-preview.mjs --out <dir> [--rail] [--reduced-motion] [--mockup <png>] [--one-host]`
renders the whole window before the native build exists. The real pages sit in iframes at the
hybrid 500-shell geometry (tab row 44, nav row 44 with the two nav fragments around a stand-in of
the native address bar, docks 200 and 330 or 44 as rails, the contents card inset 8 with radius
10, the timeline 130). The contents is the stand-in page in `scripts/dev/preview/` with
`scripts/hud.js` added the way the helper adds it, rendered as its own top-level page as the
build's contents is. The scene is `scripts/dev/preview/fixtures.json`. Outputs: `window.png` and
`window@2x.png`, `side-by-side.png` against the mockup's window area, and `regions/*.png` crop
pairs, plus `harness-log.json` and `frames.json`; it exits 1 on any error, CSP or page-error
entry. For the composition only, a loopback proxy lifts `frame-ancestors` to `'self'` and splits
the frames over `127.0.0.1` and `localhost`, because Chromium opens at most 6 connections per host
and the window's pages open 7 event streams. `--one-host` shows what the build will do. The
mockup is read in place and never committed.

### The live tests

Each live test file starts its own helper and browser (two or three for joining), and
`node --test` runs files in parallel, one short of the CPU count: a full live run is ten or
more browsers at once for about three minutes on a 12-core machine. Knobs:

- `node --test --test-reporter=spec test/*.test.mjs` prints each test's duration; the suite's
  length is set by its longest files (`form-patterns`, `join`, `shared-browser`,
  `shared-mode`), not by their number.
- `node --test --test-concurrency=4 test/*.test.mjs` runs fewer browsers at once. The option
  goes before the files (after them node takes it for a file pattern), and `NODE_OPTIONS`
  refuses it. On an idle 12-core machine this is slower (measured: 4 files at once 5 min 9 s, 8 files
  4 min 26 s, the default 11 files 3 min 10 s), since the long files then start late; on a machine busy with other work it keeps each test
  near its solo pace.
- `node --test test/scroll.integration.test.mjs` runs one file; the live ones skip without
  `PAIRBROWSE_TEST_RUNTIME`.
- Helper homes come from `testBase()` in `test/live.mjs`: the system's temporary folder (on the
  machine's own disk; an external disk a build saturates holds every helper's start up), or `/tmp`
  when a socket path there would pass the Unix limit. `attachDaemon()` waits for a helper to
  listen and fails at once, with the ends of its `daemon.stderr.log` and `daemon.log`, when it
  exits first. A helper listens before it loads the browser runtime (its log says
  `startup: socket after N ms, runtime after M ms`).
- `PAIRBROWSE_TEST_NO_CAPTURE=1` (tests only) makes the helper act as a PairBrowse build without a
  capture page: no direct connection is offered to joiners (pictures through the join channel)
  and recording is refused (`shared-mode.integration` sets it on the host only).
- `test/native-join.integration.test.mjs` joins with a PairBrowse build that has its own pages:
  set `PAIRBROWSE_TEST_RUNTIME`, `PAIRBROWSE_TEST_ENGINE` and `PAIRBROWSE_TEST_EXECUTABLE` (that
  build's `Contents/MacOS/pairbrowse`); it skips unless the build's manifest declares its own
  pages. It opens real windows. The macOS download-mark test in `tools.integration` opens one
  window too: headless Chromium writes no mark.

Speed checks (the smooth scroll in `scroll.integration`, the styled pick on a big page and the
fields whose names go away in `form-patterns.integration`) are relative: each test first times
a plain action of the same kind on the same page, allows the step under test a multiple of
that (with a floor at the quiet-machine limit and an absolute ceiling), and prints both as a
diagnostic (`ℹ` lines with the spec reporter). A regression that waits on a stale name or a
glide that stops being a glide still fails; a loaded machine doesn't. The long fixed waits in
the join tests are deliberate: they assert that something never happens (a local address
crossing, a watcher's change reaching the host), which takes a wait.

The plugin is small:

| Path | What it does |
|------|--------------|
| `.claude-plugin/`, `.codex-plugin/` | Plugin manifests for Claude Code and Codex (same skill, servers and hooks; `.codex-plugin/mcp.json` names Codex's servers) |
| `.mcp.json` (Claude Code), `.codex-plugin/mcp.json` (Codex), `scripts/launch.mjs` | Bridge both apps run: installs the pinned runtime, starts or reconnects to the helper |
| `scripts/daemon.mjs`, `scripts/daemon/` | The helper: owns Chrome over a pipe, serves shared clients over a private socket, enforces policy (tool calls, browser and sessions, people at the browser, the in-page badge and bar, screenshots, masking, side panel, sharing) |
| `scripts/policy.mjs`, `scripts/secrets.mjs` | Rules the helper enforces: blocked tools, navigation, secret domains |
| `scripts/browser/choice.mjs` | Which browser launches: the binary (Chromium, a path of your own, the native build) and the shell (the side panel extension, or the build's own pages), chosen in one pure function and never written into config |
| `scripts/tools/catalog.mjs` | Every tool's definition and rules, in one place (serve, guard, policy, launch, runs and the skill check read it) |
| `ui/vocab.js`, `ui/urls.js`, `ui/limits.js`, `ui/events.js` | What the helper and the pages share: words and colors, the browser's own addresses, limits both sides keep, the live view's events and who gets each |
| `runtime/` | Pinned Playwright MCP version and lockfile |
| `scripts/runs.mjs` | `runs` MCP server: saved runs (resume) and pre-submit reviews |
| `scripts/guard.mjs` | PreToolUse hook: auto-allows browser actions, enforces the review, asks before final ones (in Codex, which can't ask from a hook, it hands them to you; the helper applies the same rules for every app but Claude Code) |
| `scripts/session-start.mjs` | SessionStart hook: tells Claude about unfinished runs |
| `scripts/log.mjs` | PostToolUse hook: plain-English activity log per session in `~/.pairbrowse/log/` |
| `scripts/hud.js` | In-page status badge, driven only with a per-start random key |
| `scripts/liveview.mjs`, `scripts/liveview/` | Live view server for the Claude workspace (dock and Browser pane), the side panel's data: request checks and body reading (`http.mjs`), invites, input replay, shared tabs for joiners and their server |
| `scripts/liveview/routes/` | The live view's routes by audience: `viewer` (page, events, thumb, state, input, pause), `owner` (approvals, dev, join hosts, profile, invites, record), `sessions`, `pages` (the browser's own pages: activity, layout, config, report, outline, strip, tab order, capture), `timeline`, `tools` |
| `scripts/liveview.html`, `.css`, `.js`, `ui/common.js`, `ui/tokens.css` | The live view page, and the code and design tokens it shares with the side panel |
| `scripts/join.mjs`, `scripts/relay.mjs`, `scripts/tabsync.mjs`, `scripts/daemon/follow.mjs` (+ `scripts/daemon/join/`) | Join codes and host approvals; the joiner's connection to the host (one WebSocket both ways); which addresses, field values, pointers and tab orders cross and the loop-safe bookkeeping; the joiner's browser following the shared tabs |
| `scripts/liveview/push.mjs`, `scripts/liveview/joiner-server.mjs`, `scripts/ws.mjs` | The host's push channel (one WebSocket per approved joiner: tabs, form values, pointers, session, messages), the guest port with its limits, and the small standard-library WebSocket both sides use |
| `scripts/daemon/forms.mjs`, `scripts/daemon/cobrowse.mjs`, `scripts/daemon/taborder.mjs`, `scripts/daemon/board.mjs` | Reading and filling shared form fields; watching shared tabs for pointer moves and field changes; tab order through the side panel extension; who is doing what and messages between participants |
| `scripts/tunnel.mjs` | The pinned Cloudflare Quick Tunnel |
| `ui/` | The browser's own pages (side panel, new tab, session picker, picture page, capture, the approval card, the top strip, the left dock, settings), loaded as the side panel extension where the page has an extension host: manifest, worker, logo, icons, one directory per page; the browser build's own slots (`ui/strip`: the tab row and the nav fragments by hash; `ui/left`) are not loaded in the extension; `test/ui.test.mjs` checks every page |
| `scripts/browser.mjs`, `scripts/browser/`, `scripts/macos-app.mjs` | The PairBrowse browser: pinned ungoogled-chromium on macOS, Playwright Chromium elsewhere; icon files, color theme (the extension's pages are in ui/); the PairBrowse name and icon in macOS apps |
| `scripts/native-pack.mjs`, `scripts/native-install.mjs`, `scripts/native-check.mjs`, `scripts/native-engine.mjs`, `BINARY-LICENSE.md` | The native PairBrowse build: pinned downloads and the engine pack, install step with rollback, launch self-check, launch adapter, binary license (the build pipeline is in the private PairBrowse Pro repository) |
| `scripts/util.mjs` | Small shared helpers: JSON files, SHA-256, pinned downloads, timeouts |
| `skills/pairbrowse/SKILL.md` | How Claude runs a session: speed, accuracy, handoffs, updates |
