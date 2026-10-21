# Development

```
npm test                  # unit and integration tests; integration ones need PAIRBROWSE_TEST_RUNTIME=~/.pairbrowse/runtime,
                          # the native launch ones PAIRBROWSE_TEST_ENGINE=~/.pairbrowse/engine
npm run test:unit         # unit tests only (test/*.test.mjs)
npm run test:live         # integration tests only (test/integration/)
npm run test:optin        # opt-in tests (test/optin/), each behind a switch of its own
npm ci && npm run lint       # ESLint, no warnings allowed (CI runs it); .claude/ is skipped: its worktrees
                             # are copies of the repo and its workflow scripts are local, not shipped
npm run test:fuzz  # property-based fuzzing of the security checks (test/fuzz, fast-check)
npm run coverage          # unit and integration tests under c8, failing below .c8rc.json's floor
claude plugin validate .  # the Claude Code manifests
```

### The design tokens

`ui/tokens.css` is the one sheet (colors, type, radii; `--edge-input` is a text field's border at 3:1 or more) for the right
dock (the side panel in the open build), the session picker, the new tab page, a joiner's picture page and the live view (served
from the same file through the live view's fixed asset list). The live view alone opts into the
light scheme with `data-scheme="system"`; the extension pages stay dark. the page script in `scripts/hud/` (closed
shadow roots), `ui/capture/record.js` (a canvas) and the "Opening tabs" page in `scripts/tabs.mjs` carry the same hex values inline, and
`test/tokens.test.mjs` keeps every literal color in those files and the page sheets equal to a
sheet value or a `SPARK_COLORS` entry and checks WCAG AA contrast in both schemes. Agent
colors are `SPARK_COLORS` in `scripts/daemon/hud.mjs`, by app (Claude Code orange, Codex purple,
Gemini blue, Grok silver; a second agent of one app, or an app without a color, takes the first free of
`AGENT_FALLBACKS`, cyan first). Each agent's tab icon is its app's own mark in that color (`AGENT_MARKS` in
`ui/vocab.js`, the same in `scripts/hud/spark.js`): Claude's spark, Codex's brackets, Grok's slash, Gemini's
four-point star, a rounded square for any other app. People's colors are `PEOPLE_COLORS` in `scripts/sharing/tabsync.mjs`,
never near an agent's (`test/colors.test.mjs` checks hue, distance and the tags' AA contrast). The window frame follows `THEME_COLOR` in
`scripts/browser.mjs` (the sheet's frame navy) unless the user picked a theme.

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
key, Host and Origin checks, and `ui-server.mjs` serves `ui/` under the browser pages' CSP
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
hybrid 500-shell geometry (tab row 44, nav row 44 with the nav fragments around a stand-in of
the native address bar, docks 200 and 330 or 44 as rails, the contents card inset 8 with radius
10, the timeline 130). The contents is the stand-in page in `scripts/dev/preview/` with
the page script (`scripts/hud/`, joined by `scripts/hud/assemble.mjs`) added the way the helper adds it, rendered as its own top-level page as the
build's contents is. The scene is `scripts/dev/preview/fixtures.json`. Outputs: `window.png` and
`window@2x.png`, `side-by-side.png` against the mockup's window area, and `regions/*.png` crop
pairs, plus `harness-log.json` and `frames.json`; it exits 1 on any error, CSP or page-error
entry. For the composition only, a loopback proxy lifts `frame-ancestors` to `'self'` and splits
the frames over `127.0.0.1` and `localhost`, because the browser opens at most 6 connections per host
and the window's pages open 7 event streams. `--one-host` shows what the build will do. The
mockup is read in place and never committed.

### The test groups

| Folder | What runs | Script |
|--------|-----------|--------|
| `test/*.test.mjs` | Unit tests. Some still start a browser for a few cases, gated by `PAIRBROWSE_TEST_RUNTIME` (`hud`, `enter`, `ui-*` and others) | `npm run test:unit` |
| `test/integration/` | A real helper (`scripts/daemon.mjs`) and browser per file, two or three for joining; every test skips without `PAIRBROWSE_TEST_RUNTIME`. `server-display` (server mode on the helper's own virtual screen) also needs Linux with Xvfb and xauth, and user namespaces for the browser's sandbox (CI lifts Ubuntu's AppArmor rule against them) | `npm run test:live` |
| `test/optin/` | Tests behind a switch of their own, never run by `npm test`: `failover` (`PAIRBROWSE_TEST_REAL_TUNNEL=1`), `ntfy` (`PAIRBROWSE_TEST_NTFY=1`: hand-off messages published to a random ntfy.sh topic and read back), `native-join` (a native build), `profiles-native` (a native build: a browser profile's time zone, languages, screen and pixel ratio as pages read them, a pinned seed's values in two fresh sessions and its refusal in a second instance), `two-machines` (`PAIRBROWSE_TEST_DOCKER=1`; its two sides in `test/optin/two-machines/`), `public-handoff` (`PAIRBROWSE_TEST_REAL_TUNNEL=1` and `PAIRBROWSE_TEST_DOCKER=1`: a hand-off link through a real Quick Tunnel, taken over from a Linux container with `tc netem` 300 ms delay and 2% loss; its person's side in `test/optin/public-handoff/`), `graphics-spike` (spike E-S1: SystemInfo and a page probe for each graphics switch candidate, in the Linux container with `PAIRBROWSE_TEST_DOCKER=1`, and on the native build here with `PAIRBROWSE_TEST_EXECUTABLE` and `PAIRBROWSE_TEST_ENGINE`), `server-native` (the native build for Linux headed on the helper's own virtual screen with its sandbox on: Linux with Xvfb, `PAIRBROWSE_TEST_EXECUTABLE` and `PAIRBROWSE_TEST_ENGINE`), `native-graphics` (macOS, a native build: the probe reads this Mac's GPU, agrees with the host capture, WebGL and WebGPU of one family, validated), `gpu-host` (`PAIRBROWSE_TEST_GPU_HOST=1` with a native build on a computer with a GPU: hardware measured and validated, a killed browser back on the same measurement), and the five on the native Linux build in the container (`PAIRBROWSE_TEST_DOCKER=1`; the pinned archives from `PAIRBROWSE_TEST_LINUX_ARCHIVE` and `PAIRBROWSE_TEST_ENGINE_ARCHIVE`, else the release): `linux-graphics` (a host without a GPU: software rendering, the engine's one identity shown and consistent, canvas stable, fonts, a GPU request refused, sandbox on), `graphics-recovery` (a killed browser relaunches on the same request and measurement), `proxy-docker` (http and socks5 proxies with a username and password: the page loads, the proxy saw them, nothing else did, strict DNS) `canvas-bridge-dead` (the build started with the bridge's switches at a local listener: nothing connects) and `server-fonts` (also `PAIRBROWSE_TEST_COREFONTS_EULA=accept`: the server setup's font set in a container built on the server image, the setup command run as the normal user, then a page reads fonts by width: colour emoji, CJK and the core fonts found, Segoe UI, Calibri and Cambria found only with `pairbrowse.fontStandIns` on). `test/optin/server/` holds what the server-mode opt-in tests share: `container.mjs`, the one Linux container (`node:22-bookworm`, Xvfb, xauth, fonts, Mesa, a normal user, its own seccomp profile so the browser's sandbox runs, every capability dropped; Docker's default profile or root for the refusal cases), `native-cache.mjs` and `native-linux.mjs` (the pinned Linux build and engine pack, cached outside and installed inside as the helper installs them), `graphics-page.mjs` (the page that reads what pages read), the spike's measuring side, the inside runs (`graphics-run.mjs`, `proxy-run.mjs`, `canvas-bridge-run.mjs`, `end-to-end-run.mjs`, `fonts-run.mjs`), and `server-docker` (`PAIRBROWSE_TEST_DOCKER=1`: in the container, a restart restores the session with the sandbox on, Docker's default seccomp profile or root refuses the launch, a SIGKILLed keep-alive helper started again brings the browser back; its inside in `server-run.mjs`) | `npm run test:optin` |
| `test/fuzz/*.test.js` | Property-based fuzzing of the security checks | `npm run test:fuzz` |
| `test/helpers/` | Not tests: `home.mjs` (every test file imports it first: a home of its own under the temp folder), `util.mjs` (`sleep`, `until`, `text`, `rpc`), `daemon.mjs` (`helperHome`, `spawnDaemon`, `startHelper`, `stopDaemon`), `live.mjs` (`testBase`, `attachDaemon`, `session`, `patchright`), `live-helper.mjs`, `server.mjs` (a helper on its own virtual screen, its screen record, the browser's processes and sandbox from `/proc`), and the pages' harness | |

Coverage (`npm run coverage`, c8 over `scripts/`, the helper's child processes included) fails
below the floor in `.c8rc.json`: lines and statements 71%, functions 77%, branches 83%. That is
about a point under the unit tests alone (`npx c8 node --test --test-concurrency=2 test/*.test.mjs`
on macOS, measured: lines and statements 71.93%, functions 77.88%, branches 84.3%), so the floor
holds without a browser too; CI's live job, unit and integration tests on Linux, measured lines and
statements 84.82%, functions 86.65%, branches 84.36%. Raise the floor as coverage grows.

`test/bench.mjs` is not a test: it times the helper's tool calls on a real browser
(`node test/bench.mjs`, `PAIRBROWSE_TEST_RUNTIME` set) and prints the numbers.

`npm run bench:check` runs it with `--check test/bench-budgets.json`: the screenshots-on run is
compared to the budgets in that file (click p50, cold start to the first tool answer, the helper's
RSS at the end, the helper's idle CPU after work), each printed with its budget and pass or fail,
and the command exits 1 on any miss. Each budget is keyed by its path in the bench's own JSON
(`click.p50`, `startup.totalMs`, `helperMemEnd.rss`, `idleAfterWork.perKind.helper`). It is a local
gate on this Mac, not CI: the numbers are wall clock on one machine, so run it on the machine the
budgets were set on, with no other test browser running, before a change that could slow the
helper lands. `test/bench-check.test.mjs` covers the comparison without a browser.

### The test switches

Every `PAIRBROWSE_TEST_*` variable. A gate is read by the test files only: you set it when you run
the tests, and it decides whether a test runs or which browser it uses. A knob is read by the
helper (listed in `SWITCHES` in `scripts/testenv.mjs`, read through `testOn`/`testMs`/`testValue`):
a test sets it in the environment of the helper it starts, or in its own process for a module it
loads. The helper drops every knob unless the test harness started it (`applyTestGate`: its home
is under the temp folder with a linked runtime), so none reaches an installed helper.

| Switch | Kind | Who sets it | What it does |
|--------|------|-------------|--------------|
| `RUNTIME` | gate | you: `~/.pairbrowse/runtime` | The pinned runtime; every live test (integration, the live cases in unit files, the pages' harness) skips without it |
| `ENGINE` | gate | you: `~/.pairbrowse/engine` | The engine pack, for the native launch tests in `native-engine` and for `optin/native-join`, `optin/profiles-native`, `optin/graphics-spike` and `optin/server-native`; with `EXECUTABLE` a native build, the integration tests' helpers run that build (`EXECUTABLE`) |
| `EXECUTABLE` | gate | you: a browser binary | Runs the browsers of `connections`, `shared-mode`, `shared-restart`, `record` and `optin/failover` on another build (the PairBrowse browser); `optin/native-join`, `optin/profiles-native` and the macOS half of `optin/graphics-spike` need a native build here, `optin/server-native` a native build for Linux. A native build (its `Contents/MacOS/pairbrowse`) with `ENGINE` set also runs every helper the integration tests start through `test/helpers/daemon.mjs` (`helperHome`, `testBrowser`, `linkInstalls`: the build as it is installed, the engine pack copied into each test home) and the direct launches of `net-browsercheck` and `graphics-probe` on it, plus `graphics-diagnostics`' native case; their first call in each home waits through the one graphics measurement (`throughMeasuring` in `test/helpers/util.mjs`) |
| `JOINER_EXECUTABLE` | gate | you: a browser binary | The joiner's browser in `shared-mode` and `record` |
| `NATIVE` | gate | you: the PairBrowse browser | Also runs `draw` and a `picker` case on the native build |
| `REAL_TUNNEL` | gate | you: `1` | Real Cloudflare Quick Tunnels: `optin/failover`, `optin/public-handoff` and one `shared-mode` case |
| `NTFY` | gate | you: `1` | Real hand-off messages to a random topic on ntfy.sh, read back: `optin/ntfy` |
| `YOUTUBE` | gate | you: `1` | The `shared-mode` case on youtube.com |
| `EXCALIDRAW` | gate | you: `1` | The `shared-mode` case on excalidraw.com |
| `DOCKER` | gate | you: `1` | `optin/two-machines`: this machine and a Linux container; `optin/public-handoff`'s person on another network (with `REAL_TUNNEL`); `optin/graphics-spike`'s Linux half and `optin/server/server-docker` in the server container (`test/optin/server/container.mjs`; needs Docker and the network; on Apple Silicon the x64 container runs emulated) |
| `FIXTURES` | gate | you: a folder (`test/fixtures`) | `optin/graphics-spike` writes the graphics fixtures there (`systeminfo-*.json`, `probe-*.json`, scrubbed) |
| `GPU_HOST` | gate | you: `1` on a computer with a GPU | `optin/gpu-host`: the native build (`EXECUTABLE`, `ENGINE`) on this computer's own GPU: a hardware backend, validated, a killed browser back on the same measurement; skipped cleanly anywhere else |
| `LINUX_ARCHIVE` | gate | you: the pinned Linux build's archive | The container tests on the native Linux build (`optin/linux-graphics`, `optin/graphics-recovery`, `optin/proxy-docker`, `optin/canvas-bridge-dead`, with `DOCKER`) take the pinned archive from this local file (a build made here before it is published; it must match the pin in `scripts/native-pack.mjs`) instead of downloading it from the release |
| `ENGINE_ARCHIVE` | gate | you: the pinned engine pack's archive | The same for the engine pack (`test/optin/server/native-cache.mjs`) |
| `COREFONTS_EULA` | gate | you: `accept` | `optin/server-fonts` (with `DOCKER`): setting it is your own acceptance of Microsoft's EULA for the core fonts (`scripts/native/corefonts-eula.txt`), which the fonts container's Debian package then installs; the test skips without it |
| `SHOTS` | gate | you: a folder | `ui-screen` and `ui-right` save screenshots there |
| `ACTIVE_MS` | knob | `integration/tour-fixes` | How long an agent's connection counts as active |
| `APPROVAL` | knob | `integration/approval`, `integration/test-gate` | Adds `pairbrowse_test_approval`: the approval card, clicked as a person would |
| `CRASH_WINDOW_MS` | knob | `integration/server-display` | The crash-loop guard's window and hold (5 minutes otherwise): three closes within it stop starts for that long |
| `FILL` | knob | `integration/join`, `integration/shared-rules` | Adds `pairbrowse_test_fill`: a field in a tab set as a person would (`page.fill`), for card numbers no agent may type |
| `FAILOVER_MS` | knob | `failover`, `integration/connections` | How long a joiner waits on a silent tunnel before the standby |
| `GONE_MS` | knob | `join` | When a silent joiner counts as gone |
| `JOIN_LOCAL` | knob | the join tests, `picker`, `taborder`, `bench` | Join codes may point at `http://127.0.0.1` (no tunnel) |
| `JOIN_PROMPT` | knob | `integration/join-prompt` | Adds `pairbrowse_test_join_prompt`: the join request in the bottom bar |
| `KEEP_GRACE_MS` | knob | `tunnel` | How long a tunnel keeper outlives a quiet helper |
| `MEMORY` | knob | `integration/memory`, `integration/interruption`, `bench` | Adds `pairbrowse_test_memory`: listener counts |
| `NETLOG` | knob | `integration/proxy` | The browser writes its NetLog (`--log-net-log`) to `<home>/netlog.json`, anew each launch; the DNS leak test reads which names it looked up itself (`test/helpers/netlog.mjs`) |
| `NET_CHECK` | knob | `net-probe` | The proxy exit checks' local stand-ins, JSON `{ "checkUrl", "directUrl", "stun", "ms" }`: the check address (`http:` allowed), the one read without the proxy, the STUN server and the bound (`network.checkUrl`, `stun:stun.cloudflare.com:3478` and 10 seconds otherwise) |
| `NO_CAPTURE` | knob | `capture`, `integration/shared-mode` (host only) | Acts as a build without a capture page: no direct connection, no recording |
| `NO_DIRECT` | knob | `integration/shared-mode` | A network where no direct screen connection can be made |
| `PANEL` | knob | `integration/panel-reload` | Adds `pairbrowse_test_panel`: the side panel's worker |
| `PICK_WAIT_MS` | knob | `integration/picker` | How long the session picker waits |
| `RECHECK_MS` | knob | `net-recheck` | How often a running proxied session's exit is checked again (in place of `network.recheckMinutes`) |
| `RELAUNCH_MS` | knob | `integration/server-display` | Keep-alive's pause before each start after the browser closed by itself, one value for all (2, 10 and 30 seconds otherwise) |
| `RESTART_MS` | knob | `tunnels` | The tunnel pool's restart pause |
| `RESUME_GRACE_MS` | knob | `integration/departures` | How long a closed agent connection's label, color and tab wait for the same app session (10 seconds otherwise) |
| `SCREEN` | knob | the sharing tests, `bench` | Adds `pairbrowse_test_screen`: the shared browser picture page |
| `SERVER_OPEN` | knob | `integration/server-display`, `optin/server/server-run` (`test/helpers/server.mjs`, unless the home's config names the native build) | Server mode may launch Playwright's build in place of the native one (refused otherwise: `browser/choice.mjs` `serverRefusal`) |
| `SILENT_MS` | knob | `failover`, `join` | When a joiner's stream counts as silent |
| `TAB_ORDER` | knob | `integration/taborder` | Adds `pairbrowse_test_tab_order`: read and move tabs in the strip |
| `TUNNEL` | knob | the sharing tests, `bench` | `direct`: the guest port stands in for a tunnel |
| `TURN_MAX_MS` | knob | `integration/turn-cap` | The most one call may hold the shared queue (10 minutes otherwise) |
| `TURN_MS` | knob | `yourturn`, `integration/your-turn` | A hand-off's life in ms, its one reminder at two thirds of it (`handoff.grantMinutes` and `remindMinutes` otherwise) |
| `UNSEEN_MS` | knob | `integration/departures` | How long after its last call an agent stops showing (30 minutes otherwise) |

Not switches: `PAIRBROWSE_FUZZ_RUNS` sets the runs per fuzz property (CI uses 20000), `PB_DEBUG`
prints a helper's log in a few live tests, and `PB_MAIL`/`PB_RUNTIME` are how
`optin/two-machines` hands its two sides their shared folder and runtime.

### Every other variable

The `PAIRBROWSE_*` variables the bridge, the hooks and the helper read besides the test switches,
and whether a project may set them. Claude Code hands a project's `.claude/settings.json` and
`.claude/settings.local.json` `env` to the plugin (Codex: `.codex/config.toml`); a variable that
picks who the helper is or relaxes a check is removed when one of those files names it
(`gateProjectEnv` in `scripts/home.mjs`, applied as `scripts/paths.mjs` loads) or is a test switch.

| Variable | Read by | A project may set it | What it does |
|----------|---------|----------------------|--------------|
| `PAIRBROWSE_HOME` | every process (`home.mjs`) | no: removed | The home folder: profile, config, secrets, the installs the helper runs |
| `PAIRBROWSE_PARTICIPANT` | bridge, helper | no: removed | The name joiners and other agents see for this connection or host |
| `PAIRBROWSE_INSTANCE` | every process (`home.mjs`) | yes | One of your own instances, `~/.pairbrowse/instances/<name>`, as a project's `.pairbrowse.json` may choose; a malformed name stops every hook and the bridge with one line and exit code 2 (`scripts/paths.mjs`) |
| `PAIRBROWSE_APPROVAL_WAIT_MS` | `guard.mjs` (hook), helper | no: removed | How long an ask waits in the browser (100 ms to 10 min) before the terminal's prompt is the only one; it never allows anything |
| `PAIRBROWSE_TRACE` | helper | yes | `1`: each result's phases and their time in the helper's log (no page content) |
| `PAIRBROWSE_LATENCY_LOG` | helper | yes | `1`: joiner stream timings in the log |
| `PAIRBROWSE_TEST_*` | helper | no: removed | The test switches above; only a helper the test harness started keeps them |
| `PAIRBROWSE_ENGINE_PROFILE_DIR` | the engine pack, set by the helper (`profiles/migrate.mjs`) | no: the helper sets its own | Where the engine pack keeps its personas: `engine-profiles/profiles` in the home, once the home is moved to browser profiles (spec server-mode D4); an inherited value is replaced |
| `PAIRBROWSE_ENGINE_PROFILE_SOURCE` | the engine pack, set by the helper | no: the helper sets its own | The folder the pack imports personas from: `engine-profiles/source`, empty and owner-only, so nothing from elsewhere is read |
| `PAIRBROWSE_ENGINE_CACHE` | the engine pack, set by the helper | no: the helper sets its own | The pack's cache (its GeoIP database): `engine-profiles/cache` in the home |
| `PAIRBROWSE_ENGINE_*` | the engine pack (any other than the three above) | no: removed | The pack's persona library, converter, license and service settings: never read, since PairBrowse picks no other device's persona (spec server-mode D8, D9; `scripts/launcher/daemon-connect.mjs` `helperEnv` drops every inherited `PAIRBROWSE_ENGINE_*`) |

Not ours but read: `CLAUDE_PROJECT_DIR` (the project folder, for the hooks and the bridge alike: `projectDir` in `scripts/home.mjs`; `.mcp.json` passes it to the MCP servers), `CLAUDE_CODE_REMOTE` and
`CLAUDE_CODE_ENTRYPOINT` (which surface, for wording and the session picker), `SSH_CONNECTION`
(the "Server" label). Playwright MCP's `PLAYWRIGHT_MCP_*` variables are not read: the helper builds
its browser server with `createConnection`, which takes only the helper's own settings.

### The live tests

Each integration file starts its own helper and browser (two or three for joining), and
`node --test` runs files in parallel, one short of the CPU count: a full live run is ten or
more browsers at once for about three minutes on a 12-core machine. Knobs:

- `node --test --test-reporter=spec test/integration/*.test.mjs` prints each test's duration; the suite's
  length is set by its longest files (`form-patterns`, `join`, `shared-browser`,
  `shared-mode`), not by their number.
- `node --test --test-concurrency=4 test/integration/*.test.mjs` runs fewer browsers at once. The option
  goes before the files (after them node takes it for a file pattern), and `NODE_OPTIONS`
  refuses it. On an idle 12-core machine this is slower (measured: 4 files at once 5 min 9 s, 8 files
  4 min 26 s, the default 11 files 3 min 10 s), since the long files then start late; on a machine busy with other work it keeps each test
  near its solo pace.
- `node --test test/integration/scroll.test.mjs` runs one file; it skips without
  `PAIRBROWSE_TEST_RUNTIME`.
- Helper homes come from `testBase()` in `test/helpers/live.mjs`: the system's temporary folder (on the
  machine's own disk; an external disk a build saturates holds every helper's start up), or `/tmp`
  when a socket path there would pass the Unix limit. `attachDaemon()` waits for a helper to
  listen and fails at once, with the ends of its `daemon.stderr.log` and `daemon.log`, when it
  exits first. A helper listens before it loads the browser runtime (its log says
  `startup: socket after N ms, runtime after M ms`).
- `PAIRBROWSE_TEST_NO_CAPTURE=1` (tests only) makes the helper act as a PairBrowse build without a
  capture page: no direct connection is offered to joiners (pictures through the join channel)
  and recording is refused (`integration/shared-mode` sets it on the host only).
- `test/optin/native-join.test.mjs` joins with a PairBrowse build that has its own pages:
  set `PAIRBROWSE_TEST_RUNTIME`, `PAIRBROWSE_TEST_ENGINE` and `PAIRBROWSE_TEST_EXECUTABLE` (that
  build's `Contents/MacOS/pairbrowse`); it skips unless the build's manifest declares its own
  pages. It opens real windows. The macOS download-mark test in `integration/tools` opens one
  window too: a headless browser writes no mark.

Speed checks (the smooth scroll in `integration/scroll`, the styled pick on a big page and the
fields whose names go away in `integration/form-patterns`) are relative: each test first times
a plain action of the same kind on the same page (`integration/form-patterns` takes the median of three
samples, so one slow sample moves nothing), allows the step under test a multiple of
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
| `scripts/daemon.mjs`, `scripts/daemon/` | The helper: owns the browser over a pipe, serves shared clients over a private socket, enforces policy (tool calls, browser and sessions, people at the browser, the in-page badge and bar, screenshots, masking, side panel, sharing) |
| `scripts/rules/policy.mjs`, `scripts/rules/secrets.mjs` | Rules the helper enforces: blocked tools, navigation, secret domains |
| `scripts/browser/choice.mjs` | Which browser launches: the binary (the open build, a path of your own, the native build) and the shell (the side panel extension, or the build's own pages), chosen in one pure function and never written into config |
| `scripts/tools/catalog.mjs` | Every tool's definition and rules, in one place (serve, guard, policy, launch, runs and the skill check read it) |
| `ui/vocab.js`, `ui/urls.js`, `ui/limits.js`, `ui/events.js` | What the helper and the pages share: words and colors, the browser's own addresses, limits both sides keep, the live view's events and who gets each |
| `runtime/` | Pinned Playwright MCP version and lockfile |
| `scripts/runs.mjs` | `runs` MCP server: saved runs (resume) and pre-submit reviews |
| `scripts/guard.mjs` | PreToolUse hook: auto-allows browser actions, enforces the review, asks before final ones (in Codex, which can't ask from a hook, it hands them to you; the helper applies the same rules for every app but Claude Code) |
| `scripts/session-start.mjs` | SessionStart hook: tells Claude about unfinished runs |
| `scripts/log.mjs` | PostToolUse hook: plain-English activity log per session in `~/.pairbrowse/log/` |
| `scripts/hud/` | In-page status badge, driven only with a per-start random key |
| `scripts/liveview.mjs`, `scripts/liveview/` | Live view server for the Claude workspace (dock and Browser pane), the side panel's data: request checks and body reading (`http.mjs`), invites, input replay, shared tabs for joiners and their server |
| `scripts/liveview/routes/` | The live view's routes by audience: `viewer` (page, events, thumb, state, input, pause), `owner` (approvals, dev, join hosts, profile, invites, record), `sessions`, `pages` (the browser's own pages: activity, layout, config, report, outline, strip, tab order, capture), `timeline`, `tools` |
| `scripts/liveview.html`, `.css`, `.js`, `ui/common.js`, `ui/tokens.css` | The live view page, and the code and design tokens it shares with the side panel |
| `scripts/sharing/join.mjs`, `scripts/sharing/join-client.mjs`, `scripts/sharing/tabsync.mjs`, `scripts/daemon/follow.mjs` (+ `scripts/daemon/join/`) | Join codes and host approvals; the joiner's connection to the host (one WebSocket both ways); which addresses, field values, pointers and tab orders cross and the loop-safe bookkeeping; the joiner's browser following the shared tabs |
| `scripts/liveview/push.mjs`, `scripts/liveview/joiner-server.mjs`, `scripts/ws.mjs` | The host's push channel (one WebSocket per approved joiner: tabs, form values, pointers, session, messages), the guest port with its limits, and the small standard-library WebSocket both sides use |
| `scripts/daemon/forms.mjs`, `scripts/daemon/cobrowse.mjs`, `scripts/daemon/taborder.mjs`, `scripts/daemon/board.mjs` | Reading and filling shared form fields; watching shared tabs for pointer moves and field changes; tab order through the side panel extension; who is doing what and messages between participants |
| `scripts/tunnels/quick.mjs` | The pinned Cloudflare Quick Tunnel |
| `ui/` | The browser's own pages (side panel, new tab, session picker, picture page, capture, the approval card, the top strip, the left dock, settings), loaded as the side panel extension where the page has an extension host: manifest, worker, logo, icons, one directory per page; the browser build's own slots (`ui/strip`: the tab row and the nav fragments by hash; `ui/left`) are not loaded in the extension; `test/ui.test.mjs` checks every page |
| `scripts/browser.mjs`, `scripts/browser/`, `scripts/native/macos-app.mjs` | The PairBrowse browser: the open build (a pinned open-source build on macOS, Playwright's browser elsewhere); icon files, color theme (the extension's pages are in ui/); the PairBrowse name and icon in macOS apps |
| `scripts/native-pack.mjs`, `scripts/native-install.mjs`, `scripts/native/check.mjs`, `scripts/native-engine.mjs`, `BINARY-LICENSE.md` | The native PairBrowse build: pinned downloads and the engine pack, install step with rollback, launch self-check, launch adapter, binary license (the build pipeline is in the private PairBrowse Pro repository) |
| `scripts/util.mjs` | Small shared helpers: JSON files, SHA-256, pinned downloads, timeouts |
| `skills/pairbrowse/SKILL.md` | How Claude runs a session: speed, accuracy, handoffs, updates |
