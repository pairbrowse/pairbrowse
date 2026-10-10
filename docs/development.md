# Development

```
npm test                  # unit tests; live ones need PAIRBROWSE_TEST_RUNTIME=~/.pairbrowse/runtime,
                          # the native launch ones PAIRBROWSE_TEST_ENGINE=~/.pairbrowse/engine
npm ci && npm run lint       # ESLint, no warnings allowed (CI runs it)
npm run test:fuzz  # property-based fuzzing of the security checks (test/fuzz, fast-check)
claude plugin validate .  # the Claude Code manifests
```

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
| `runtime/` | Pinned Playwright MCP version and lockfile |
| `scripts/runs.mjs` | `runs` MCP server: saved runs (resume) and pre-submit reviews |
| `scripts/guard.mjs` | PreToolUse hook: auto-allows browser actions, enforces the review, asks before final ones (in Codex, which can't ask from a hook, it hands them to you; the helper applies the same rules for every app but Claude Code) |
| `scripts/session-start.mjs` | SessionStart hook: tells Claude about unfinished runs |
| `scripts/log.mjs` | PostToolUse hook: plain-English activity log per session in `~/.pairbrowse/log/` |
| `scripts/hud.js` | In-page status badge, driven only with a per-start random key |
| `scripts/liveview.mjs`, `scripts/liveview/` | Live view server for the Claude workspace (dock and Browser pane), the side panel's data: request checks, invites, input replay, shared tabs for joiners and their server |
| `scripts/liveview.html`, `.css`, `.js`, `scripts/browser/panel/common.js` | The live view page, and the code it shares with the side panel |
| `scripts/join.mjs`, `scripts/relay.mjs`, `scripts/tabsync.mjs`, `scripts/daemon/follow.mjs` | Join codes and host approvals; the joiner's connection to the host (one WebSocket both ways); which addresses, field values, pointers and tab orders cross and the loop-safe bookkeeping; the joiner's browser following the shared tabs |
| `scripts/liveview/push.mjs`, `scripts/liveview/joiner-server.mjs`, `scripts/ws.mjs` | The host's push channel (one WebSocket per approved joiner: tabs, form values, pointers, session, messages), the guest port with its limits, and the small standard-library WebSocket both sides use |
| `scripts/daemon/forms.mjs`, `scripts/daemon/cobrowse.mjs`, `scripts/daemon/taborder.mjs`, `scripts/daemon/session.mjs` | Reading and filling shared form fields; watching shared tabs for pointer moves and field changes; tab order through the side panel extension; who is doing what and messages between participants |
| `scripts/tunnel.mjs` | The pinned Cloudflare Quick Tunnel |
| `scripts/browser.mjs`, `scripts/browser/`, `scripts/macos-app.mjs` | The PairBrowse browser: pinned ungoogled-chromium on macOS, Playwright Chromium elsewhere; icon, color theme, side panel and new tab page; the PairBrowse name and icon in macOS apps |
| `scripts/native-pack.mjs`, `scripts/native-install.mjs`, `scripts/native-check.mjs`, `scripts/native-engine.mjs`, `BINARY-LICENSE.md` | The native PairBrowse build: pinned downloads and the engine pack, install step with rollback, launch self-check, launch adapter, binary license (the build pipeline is in the private PairBrowse Pro repository) |
| `scripts/util.mjs` | Small shared helpers: JSON files, SHA-256, pinned downloads, timeouts |
| `skills/pairbrowse/SKILL.md` | How Claude runs a session: speed, accuracy, handoffs, updates |
