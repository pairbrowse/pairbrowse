# PairBrowse server mode: design and implementation plan

- Date: 2026-10-20
- Status: Approved 2026-10-20 (decisions in section 13); implementation in progress
- Repos: `pairbrowse` (public, "pb", at `06ba3c2`) and `pairbrowse-native` (private Pro repo, "pn", at
  `origin/main` `a7576ae`; the local `main` checkout at `e6b3640` does not yet carry patch 594).
  Paths are pb-relative unless prefixed `pn:`. Line numbers are from those commits.
- Words: "the engine" is the browser engine and the fingerprint patch series the native build takes;
  "the pack" is the engine pack the helper loads (`scripts/native-pack.mjs` `NATIVE.engine`); "the
  driver" is Patchright (default, `scripts/driver.mjs`) or Playwright.

## 1. Product goal

PairBrowse becomes a persistent, remotely operated agent browser: it runs headed on a server,
recovers from crashes, keeps isolated sessions with reusable, importable profiles, sends each
session through its own proxy, measures and reports its real graphics, and hands human-only steps
(CAPTCHA, bot check, sign-in, 2FA, payment) to the user through a link that works on a phone.

The principle that frames every phase: PairBrowse is a browser that does not get blocked
unnecessarily. Profile, proxy, graphics and input must be coherent (no GPU that does not match the
platform, no time zone that does not match the egress region, no software renderer claimed as
hardware), so sites see an ordinary, believable browser (wording: "stealth", "everyday browser",
never "undetectable"). When a site truly requires verification, PairBrowse never bypasses it: it
hands the step to the user, who completes it wherever they are, and the agent resumes.

Fixed constraints: the project stays MIT (bundle only MIT-compatible code and data; GPL or AGPL data
only when the user imports it); no TCP debugging port, no CAPTCHA solver, no run-code tool; the
sandbox is never weakened; hooks and the daemon stay stdlib-only; `docs/security.md` changes in the
same commit as the behavior it describes.

## 2. What exists today

**Phase A (server runtime).** Linux gets a private Xvfb when there is no screen:
`needsVirtualDisplay` (`scripts/display.mjs:14-18`), `startVirtualDisplay` (`:22-44`, fixed
`1366x900x24`, `-nolisten tcp`, cookie in `~/.pairbrowse/run`). The launch starts it once
(`scripts/daemon/browser/launch.mjs:179`) and never clears `st.screen`, so a dead Xvfb breaks every
later launch. Stale `/tmp/.X<n>-lock` files are skipped, never recovered (`display.mjs:29`); the
start can race (`:34-38`); `stop()` is a bare SIGTERM (`:37`); a grace-timeout exit
(`scripts/daemon.mjs:807`) or a helper SIGKILL orphans Xvfb. With no agent connected, a browser
close ends the helper (`daemon.mjs:313`). Tabs, cookies and the current session already come back
after a crash (`scripts/daemon/browser/tabs.mjs:118-145`, `scripts/sessions.mjs:31-38`, tests
`test/integration/interruption.test.mjs`, `test/integration/cookies-stop.test.mjs`). The sandbox
turns off on Linux as root, by config, or silently after a sandbox failure (`scripts/engine.mjs:37-43`,
`:84-94`). `where()` says "Server" only with `SSH_CONNECTION` (`scripts/daemon/where.mjs`).
Missing: geometry config, display supervision, orphan reaping, a crash-loop limit, a helper that
stays up on a server, a sandbox that cannot silently turn off, any headed-on-Xvfb test.

**Phase B (hand-off).** `pairbrowse_status` kind "you" (`scripts/tools/catalog.mjs:12-19`) sets a
badge, a local notification (`scripts/daemon/panel.mjs:126-137`, `scripts/notify.mjs`) and a Tools
tab entry (`scripts/daemon/toolstab.mjs:229-255`, kinds from `handoffKind`, `:218-226`). Detected
CAPTCHAs call `onYourTurn` (`scripts/popups.mjs:68-95`, wired at `daemon.mjs:264-268`). The live
view already replays a drive viewer's mouse, wheel, keys and text into the shown tab
(`scripts/liveview.js:581-668` to `scripts/liveview.mjs:496-514` to `scripts/liveview/input.mjs:38-68,111-170`),
with card fields covered for guests (`scripts/liveview/guest-frames.mjs`). Invite links are
multi-use, session-wide and hours long (`scripts/liveview/invites.mjs:57-148`, `RIGHTS` `:160-164`).
Missing: single-use, tab-scoped, short-lived grants; remote channels; a phone-usable viewer (no soft
keyboard on `<main tabindex=0>`, no composition, printable keys fire no key events, the cast follows
the agent's tab, `scripts/liveview/cast.mjs:122-137`); an early wake for a waiting agent
(`scripts/daemon/serve/tools/wait-for.mjs`); a timeout with one reminder; an enforced "agents keep
out" rule; an audit trail; payment isolation.

**Phase C (network).** No network configuration. `browserArgs` drops proxy switches
(`scripts/browser-args.mjs:48-93`); the `pairbrowse` config object is closed
(`scripts/config-schema.mjs:60-72`). The only proxy path is undocumented and unsafe: a saved engine
persona's `proxy` reaches `pack.resolveProxy` (`scripts/native-engine.mjs:339`), which puts SOCKS
credentials on argv; the driver answers every 401 (site or proxy) with proxy credentials and
disables the cache (driver bundle, Phase C trace). Geoip writes network results into the persona
(`native-engine.mjs:278-295`) and prints the egress IP to stderr, which reaches `daemon.log` raw
(`scripts/launcher/daemon-connect.mjs:70`). `secrets.env` checks mode only, follows symlinks and is
written non-atomically (`scripts/rules/secrets.mjs:27-38,100-106`). Missing: per-session proxies,
credential handling, egress checks, DNS and WebRTC leak protection on the open build, fail closed.

**Phase D (profiles).** No profile object. A session is a storage boundary (`scripts/sessions.mjs`,
`sessionProfile`/`sessionFile` at `scripts/paths.mjs:113-114`); the native build uses
`<session>/pairbrowse-native` (`scripts/engine.mjs:22-26`); the persona comes from three layers in
`readSettings` (`native-engine.mjs:217-239`) and is written back by `savePersona` (`:288-295`) under
the fixed name "pairbrowse". Gaps found: the saved and persisted persona layers reach the launch
unfiltered (F1); `profileSelect` is open and can name a program (`config-schema.mjs:63`, F2);
inherited `PAIRBROWSE_ENGINE_*` variables reach the pack (`daemon-connect.mjs:58-59`, F3); persona
`"auto"` asks a service whose address the build rewrites to `.invalid` (pn `engine/build.mjs:29-31`,
F5); device languages are replaced by the host's `Intl` (`native-engine.mjs:283`, F7). Missing:
records, ids, versions, import, export, validation, binding of storage to configuration.

**Phase E (graphics).** macOS captures this Mac's own graphics once per build and hardware
(`captureMacHost`, `native-engine.mjs:120-191`; software renderer refused at `:150`) and runs with
it. Linux runs seed-only: NVIDIA persona strings and a 1920x1080 screen over a software renderer in a
1366x900 display. Patch 065 (remote canvas renderer, needs an unsandboxed renderer) is unused but
reachable through the unfiltered persona layers. WebGPU: the collector's nested `webgpu.info` is
flattened only on the macOS capture path (`native-engine.mjs:155`); adapter limits stay the
persona's even with real GPU strings (pn `075-webgpu-coherence.patch:56-110`). Missing: any
measurement of the active backend, WebGL/WebGPU/canvas/font diagnostics, a backend setting, a
requested-vs-measured record, Linux and GPU-host tests.

## 3. Architecture

### 3.1 Component boundaries

| Module | Responsibility | Phase |
|---|---|---|
| `scripts/display.mjs` (changed) | Xvfb start, geometry, ownership record, reaping, `serverMode()` | A |
| `scripts/daemon/browser/supervise.mjs` (new) | `ensureScreen`, crash-loop guard, keep-alive relaunch, status parts | A |
| `scripts/daemon/where.mjs` (changed) | "Server" when supervised | A |
| `scripts/engine.mjs`, `scripts/browser-args.mjs` (changed) | sandbox rule: required in server mode | A |
| `scripts/daemon/audit.mjs` (new) | append-only `audit.jsonl` for grants, network, profiles | B (used by C, D) |
| `scripts/daemon/grants.mjs` (new) | grant table: mint, redeem, scope, end, hold | B |
| `scripts/liveview/grants.mjs`, `scripts/liveview/routes/turn.mjs` (new) | redeem page, view-key stream gate, turn routes | B |
| `scripts/liveview-turn.js` (new viewer asset) | phone-first turn viewer | B |
| `scripts/daemon/notify/` (new) | sender interface: webhook, ntfy, Telegram, Discord, Slack | B (used by C) |
| `scripts/daemon/yourturn.mjs` (new) | hand-off lifecycle, reminders, payment isolation, compatibility vs verification | B |
| `scripts/rules/coherence.mjs` (new, pure) | cross-phase consistency rules | B/C/D/E |
| `scripts/net/` (new: `config`, `credentials`, `probe`, `verdict`, `browsercheck`) | proxy config, credentials CLI, egress probes, verdicts | C |
| `scripts/daemon/network.mjs` (new) | `forLaunch`, `checkAtLaunch`, recheck, refusal | C |
| `scripts/daemon/logfile.mjs` (new) | masked `daemon.log` writer (moves lines out of `daemon.mjs`) | C |
| `scripts/profiles/` (new: `schema`, `device`, `import`, `export`, `store`, `upgrade`, `map`, `migrate`, `cli`) | profile records and their lifecycle | D |
| `scripts/daemon/sessions/profiles.mjs` (new) | `forLaunch`, binding check, identity lock | D |
| `scripts/native/` (new: `graphics`, `backend`, `probe`, `validate`, `properties`) | backend plan, `SystemInfo` read, probe launch, validation | E |
| pn patches `960-no-canvas-bridge`, `961-webgpu-real`, `962-proxy-auth-file` | engine work | C, E |

New helper-part import edges in `test/structure.test.mjs` `ALLOWED`: `context -> browser/supervise`,
`browser/supervise -> where`, `context -> sessions/profiles`. Everything else passes through deps.

### 3.2 One launch path

Every launch, recovery and relaunch goes through `launch()` in `scripts/daemon/browser/launch.mjs`,
in this fixed order:

1. `api.ensureScreen()` (A).
2. `deps.profiles.forLaunch(session)`: profile, binding check, identity lock, version check (D).
3. `deps.network.forLaunch(session, { profileNetwork })`: proxy, strict switches, auth file (C).
4. Graphics plan and static compatibility errors, with the stored measurement or a probe launch (E).
5. `launchEngine` with the server-mode sandbox rule (A).
6. `deps.network.checkAtLaunch(ctx, session)`; failure closes the browser (C).
7. `readBackend` and `backend.requested`/`backend.stable` (E); failure closes the browser.
8. `api.restore` (tabs, active tab, agents' successors) or the picker; then `yourturn.recover()` (B).

Steps 6 and 7 failing are not crashes for A's crash-loop guard.

### 3.3 Separation rules

- **Profile** = configuration a person chose (locale, time zone, languages, screen, window, DPR, color
  scheme, reduced motion, graphics backend request and requirements, persona seed, saved-card option,
  a network id). Versioned in `~/.pairbrowse/browser-profiles/`. Never holds a proxy server, a
  credential, a launch option, a path, or another device's hardware.
- **Session** = storage (the engine's user-data-dir: cookies, storage, logins, extensions, history,
  cache) and side files. Bound to exactly one profile.
- **Network** = operator config in `config.json` `network`, credentials only in `secrets.env`. A
  profile may reference a network id; changing a network never edits a profile.
- **Measured network** = observations in `sessionFile(name, "network.json")`. Never written into a
  profile or persona.
- **Runtime and graphics** = measured from the real host (backend, renderer, WebGL, WebGPU, fonts),
  stored as evidence in the profile's `validation[build]`, never as configuration, never imported from
  another device.
- **Audit** = `~/.pairbrowse/audit.jsonl`, append-only, no keys, links, secret values or page content.
- **Helper traffic** (notifications, tunnels, update checks, reports) never goes through a session's
  proxy.

## 4. Phase A: reliable server runtime

### Objective
Headed browser on a private Xvfb when needed, configurable geometry, supervision of display, browser
and helper, crash recovery and session restoration, sandbox always on.

### Decisions
- **A1. `virtualScreen: { width: 1366, height: 900, depth: 24 }`**, a helper-wide key beside the
  `display` enum (changing `display` to an object would break every config). Bounds: width 800 to 7680,
  height 600 to 4320, depth 16 or 24 (30 excluded until measured). Never a profile field.
- **A2. The window follows the screen only on the helper's own Xvfb**: `--window-size=<w>,<h>` and
  `--window-position=0,0` replace the fixed `--window-size=1366,900` (`scripts/browser.mjs:332`);
  otherwise launch args are unchanged. A user's `--window-size` in `browserArgs` still wins.
- **A3. `serverMode(config, env)`** = `needsVirtualDisplay(...)` or `server.keepAlive`. Supervision, the
  sandbox rule and `where()` read it. Desktop behavior unchanged.
- **A4. Event-driven supervision inside the helper.** Xvfb `exit` clears `st.screen`; a browser that
  loses its display closes and runs the existing crash path (`launch.mjs:221-233`); the next
  `getContext()` starts a new screen and restores tabs. No polling watchdog, no repo-owned supervisor
  process: the helper itself is supervised by the OS service manager (A9).
- **A5. Crash-loop limit**: 3 unexpected closes within 5 minutes, each within 60 s of its launch, make
  `getContext()` refuse ("the browser keeps crashing on this machine: see daemon.log") for 5 minutes or
  until restart; status names it; one `ended` message goes to Phase B channels. Counted only in server
  mode (on a desktop a person closing the window looks the same).
- **A6. Reaping by ownership record, never by guess.** `run/<cookie name>.json` (`{ display, pid, auth,
  geometry, startedAt }`, 0600, `writeJsonAtomic`). At start: our recorded pid alive with
  `/proc/<pid>/cmdline` = `Xvfb ... -auth <our cookie>` is ended (SIGTERM, 2 s, SIGKILL); a lock of the
  recorded display holding our dead pid and owned by our uid is removed with its socket. Anything else
  is skipped.
- **A7. Race-free start**: accept a display only if the child still runs and `/tmp/.X<n>-lock` holds the
  child's pid; else kill it and try the next number. `-displayfd` not adopted until measured in the
  container.
- **A8. Shutdown always ends the screen**: async `stop()` (SIGTERM, 1 s, SIGKILL, remove cookie and
  record); sync `stopNow()` from the existing `process.on("exit")` (`daemon.mjs:317`).
- **A9. `server: { keepAlive: false }`**: when true, a browser close with no agent does not end the
  helper (`daemon.mjs:313`), an unexpected close relaunches after 2, 10, 30 s (bounded by A5), the start
  launches and restores at once, and `readUse` (`scripts/handoff.mjs:103`) counts the helper as in use
  so a newer bridge never stops it. `docs/server.md` gives a systemd user unit (`ExecStart=<node>
  <plugin copy>/scripts/daemon.mjs`, `Restart=on-failure`, `RestartSec=5`); the single-helper lock
  (`daemon.mjs:123-139`) already prevents two helpers. Default false, so an SSH-started helper keeps
  today's lifetime.
- **A10. Sandbox always on in server mode.** `browserSandbox: false` or `--no-sandbox` refused (as on
  macOS); root refuses the launch ("the browser's sandbox can't run as root; run PairBrowse as a normal
  user"); `SANDBOX_FAILED` is an error, never a fallback. On a desktop, `browserSandbox: "required"`
  gives the same rule; `loadConfig` keeps `"required"` (`scripts/paths.mjs:219` changes).
- **A11. `where()` says "Server"** after `markServer()`, called by `supervise.mjs` in server mode, so
  Phase B links get the right reach hint.
- **A12. Session picker**: no code change; `docs/server.md` says `sessionPicker: false`.
- **A13. One container harness** `test/optin/server/container.mjs` (`node:22-bookworm`, xvfb, xauth,
  fonts, non-root user, the `two-machines.test.mjs` pattern) used by A, C and E opt-in tests.

### Design
- Config schema (`scripts/config-schema.mjs`), defaults (`scripts/paths.mjs` `DEFAULT_CONFIG`):
  `virtualScreen` object (`width`, `height` integers, `depth` values), `server: { keepAlive: boolean }`,
  `browserSandbox: { values: [true, false, "required"] }`. None is in Settings' `POST config` list.
- `scripts/display.mjs`: `screenGeometry(config)`, `serverMode(config, env)`,
  `startVirtualDisplay(log, { name, geometry, onExit })` returning `{ env, display, pid, geometry, stop,
  stopNow }`, `reapOwn(name, deps)` with injectable `/proc`, stat, kill.
- `scripts/daemon/browser/supervise.mjs` `createSupervisor(st, deps, api)`: `ensureScreen()`,
  `stopScreen()`, `stopScreenNow()`, `noteUnexpectedClose(launchedAt)`, `crashLoop()`,
  `relaunchSoon()`, `statusParts()`. Wiring: `launch.mjs:179` calls `api.ensureScreen()`, `:331` calls
  `api.stopScreen()`, the close handler calls `noteUnexpectedClose` and, with keep-alive,
  `relaunchSoon`. State fields `screenStopping`, `unexpectedCloses` in `browser/state.mjs`.
- `scripts/browser.mjs` `launchArgs(config, { screen })`: A2.
- `scripts/engine.mjs`: `sandboxDecision(config, { platform, uid, server })` returns `blocked` for root
  when required; `launchEngine(..., { server })` throws on `blocked` and in the fallback branch when
  required. `scripts/browser-args.mjs`: `sandboxRequired(config, { server })`.
- `scripts/daemon/serve/tools/status.mjs` `statusLine(selected, configWarnings, sandbox, update, more = [])`:
  one list of extra parts, filled by `[...context.statusParts(), ...network.statusParts(),
  ...profiles.statusParts(), ...graphicsParts()]` so later phases add no positional parameters.
- `scripts/daemon.mjs` stays within its 856-line budget (`test/structure.test.mjs:25`): A's three edits
  replace lines; Phase B and C move lambdas and the log writer out (`yourturn.mjs`, `logfile.mjs`).
- `scripts/native/check.mjs:107` passes `geometry` and awaits `stop()`.
- Test switches in `scripts/testenv.mjs` `SWITCHES` and `docs/development.md`: `CRASH_WINDOW_MS`,
  `RELAUNCH_MS`.
- Errors: no free display ("displays :99 to :139 are taken", with the count skipped as foreign); Xvfb
  dies (logged, in-flight calls get "browser closed", next action recovers); crash loop (refusal
  naming daemon.log); sandbox required and unavailable (launch throws with the reason and
  `docs/server.md`).
- Restoration brings back the session (never a temporary `clean-<n>`), its profile, network, tabs in
  order, the active tab, agents' tab successors, cookies and logins; not `sessionStorage`, unsent form
  text or in-page state. The host note says so.

### Migration
None for desktops; defaults equal today's constants. Behavior change for Linux machines without a
screen: running as root, or on a host whose sandbox cannot start, now refuses the launch with the
fix named (CHANGELOG, `docs/server.md`). An Xvfb orphaned by a pre-upgrade helper is skipped, not
reaped.

### Acceptance tests
Unit:
- `test/display.test.mjs` (new): "the virtual screen gets the configured geometry";
  "screenGeometry fills defaults"; "serverMode: own Xvfb or keepAlive, never with display none or a
  desktop DISPLAY"; "a stale lock of our own dead Xvfb is removed"; "foreign locks are never touched";
  "our orphaned Xvfb is ended, a pid with another cmdline is not"; "a display won by another server is
  not taken"; "stop waits, escalates and removes cookie and record; stopNow is synchronous".
- `test/supervise.test.mjs` (new): "an Xvfb exit clears the screen and the next ensure starts one";
  "three early unexpected closes stop relaunching; a switch, shutdown or network refusal does not
  count"; "keepAlive relaunches with backoff, never while shutting down, switching or in a crash
  loop"; "statusParts names screen, crash loop and keep-alive".
- `test/browser-args.test.mjs`: "the window follows the virtual screen only when one is in use".
- `test/config-schema.test.mjs`: "virtualScreen bounds, server.keepAlive, browserSandbox required kept
  by loadConfig".
- `test/engine.test.mjs`: "server mode refuses sandbox off, refuses root, never falls back; desktop
  Linux unchanged; required does the same on a desktop".
- `test/handoff.test.mjs`: "status adds extra parts in order; keepAlive counts as in use".
- `test/where.test.mjs` (new): "Server after markServer or with SSH_CONNECTION".
- Kept green: `test/security.test.mjs` display cases, `test/structure.test.mjs`.

Integration `test/integration/server-display.test.mjs` (Linux with Xvfb, xauth and
`PAIRBROWSE_TEST_RUNTIME`; `display: "xvfb"`, no `DISPLAY`, home under `os.tmpdir()`):
"starts headed on its own virtual screen; window matches virtualScreen 1280x800; no sandbox
warning"; "Xvfb killed: next action brings a new screen and the tabs back, active tab first";
"browser killed: an agent's tab comes back as its successor"; "SIGTERM leaves no Xvfb, lock, socket,
cookie, record, browser.sock or daemon.lock"; "helper SIGKILLed: the next helper reaps and reuses the
display"; "a login cookie survives a restart"; "keepAlive with no agent: the browser comes back by
itself; three crashes stop it".

Opt-in `test/optin/server/server-docker.test.mjs` (`PAIRBROWSE_TEST_DOCKER=1`): "non-root, sandbox on,
a page opens, a restart restores the session"; "default seccomp profile or root: launch refused,
never started without the sandbox"; "systemd-style restart after SIGKILL restores session and tabs
with keepAlive". `test/optin/server-native.test.mjs` (`PAIRBROWSE_TEST_EXECUTABLE`): "native build
headed on Xvfb with its sandbox on". CI: `xauth` named in the apt line of
`.github/workflows/tests.yml:59`.

### Security table changes
See section 12, rows A-1 and A-2.

## 5. Phase B: secure interactive human hand-off

### Objective
An agent sets `pairbrowse_status` kind "you" (or PairBrowse detects a challenge). The user gets a
message on a configured channel stating the action kind, opens a single-use, short-lived link on any
device (phone first), sees the live tab, completes the step with touch, on-screen keyboard or mouse,
and the agent resumes without needless navigation or a second sign-in. Payments are completed only
by the person. On no response: progress saved, exactly one reminder, safe stop.

### Approved decisions (from the user, 2026-10-20)
- **B-AP1. Link previews never consume a grant.** The link opens a landing page with a "Take over"
  button. A GET never consumes; only the tap (a POST from that page) does. A second tap is refused.
- **B-AP3. Payments on a server happen in the server's tab**, completed through the hand-off link. The
  phone's password manager, Apple Pay, Google Pay and passkeys cannot fill into a remote tab; the user
  types card details or codes by hand with the on-screen keyboard; the site's 3-D Secure step usually
  completes in the user's banking app. The agent never types payment credentials.
- **B-AP4. Saved card, per profile, off by default** (design in B12).

### Decisions
- **B1. Who authorizes.** The operator turns hand-off on in `config.json` (`handoff.enabled: true`) with
  at least one channel. Links go only to configured channels, never to the agent (a prompt-injected
  agent cannot leak or redirect them). Rejected: agent-supplied recipients; reusing
  `pairbrowse_invite` (hands the key to the agent).
- **B2. A grant is its own key table**, role `"turn"` with rights `page, events, thumb, state, input,
  turn`, and a pre-redeem role `"redeem"` with `page` only, added to `RIGHTS`
  (`scripts/liveview/invites.mjs:160`). Never `tab`, `profile`, `approve`, `invite`, `tools`,
  `session`, `config`. `POST pause` is refused to role turn.
- **B3. Two keys.** The delivered URL carries a 256-bit **redeem key**. `GET /<redeemKey>/` serves the
  landing page (action kind, site host, expiry, "Take over") and burns nothing. `POST
  /<redeemKey>/redeem` burns it and answers `{ view: "/<viewKey>/" }`; the page moves there with
  `location.replace`. The **view key** lives until the grant ends and holds **one event stream at a
  time** (a second concurrent stream: 409); after a drop the same device may reconnect at any time
  within the grant's life (mobile networks drop often; the key never left that device). Spent key
  hashes are kept until expiry to audit reuse.
- **B4. Scope.** A grant records `session`, `page` (challenge page, else the agent's spark tab, else
  its acting tab) and `scope` (`page` plus tabs it opened while the grant was live: OAuth, 3-D Secure
  pop-ups). Each request checks the session; a mismatch ends the grant. While a turn stream is open
  the cast is pinned to scope (`cast.mjs` `follow()` takes a `pinned()` callback). The viewer may switch
  only among scope tabs, never open, close or type an address (`nav go` refused; back, forward, reload
  allowed). Frames, `thumb.jpg`, `state.json` and `tabs` come only from scope. Input is replayed only
  while a scope tab is shown (else 409). The grant ends on Done, challenge cleared, the agent's next
  status, tab close, session switch, revoke, expiry or helper stop.
- **B5. Reachability.** Same as invite links: `inviteBaseUrl` on a `liveViewHosts` name (a tailnet works
  on phones with the tailnet app) or loopback with the `ssh -N -L` hint (`scripts/daemon/sharing.mjs:157`).
  Never the join-code port. A public tunnel route for phones is decision U2 (section 13).
- **B6. One sender interface** in `scripts/daemon/notify/`: `{ type, describe(), send(message) }`,
  built from `handoff.channels` through a table. Required channels: webhook, ntfy, Telegram, Discord,
  Slack. A new channel is one file plus one table entry. Credentials live in `secrets.env` under the
  reserved `PAIRBROWSE_` prefix (`reservedSecret(name)` in `scripts/rules/secrets.mjs`: never typed into
  a page even with a `_DOMAINS` line, hidden from `pairbrowse_facts get`, refused by `secretNamesIn`,
  still masked by `redact`, listed by name in the owner's Profile panel). Phase C reuses it.
- **B7. What a message carries, and nothing else.** A fixed sentence per action kind, the site's host,
  the expiry time and the link. Action kinds come from `handoffKind` (`scripts/daemon/toolstab.mjs:218`)
  or the new optional `step` argument of `pairbrowse_status` (`"captcha" | "2fa" | "payment" | "login" |
  "other"`): "Sign in on <host>", "Complete a verification on <host>", "Enter a 2FA code on <host>",
  "Approve a payment on <host>", "Take a step on <host>". The agent's free text is **not** sent to
  remote channels (it can carry page content); the person sees it only after taking over. Never
  passwords, codes, card data, page text or screenshots. On `https://ntfy.sh` without a token the link
  is omitted by default (`link: "auto"`; a public topic is readable by anyone who knows its name, and
  the first tap wins); the status result then tells the agent the person must open the live view
  another way.
- **B8. Phone-first turn viewer** (`scripts/liveview-turn.js`, loaded by `liveview.js` with a
  same-origin dynamic import only for roles turn and redeem, so `liveview.js` stays under 800 lines):
  - A visible "Type here" box (`<input autocomplete="off" autocapitalize="off" spellcheck="false"
    enterkeyhint="done">`) opens the on-screen keyboard. Its `beforeinput` maps `insertText` to one
    `char` event per character (a `text` event above 32 characters), `deleteContentBackward` to
    Backspace, `insertLineBreak` to Enter; composition is sent once at `compositionend`. The box is
    emptied after each event and never holds a value.
  - New input kind `{ type: "char", text, modifiers: 0 | 8 }` replayed as `Input.dispatchKeyEvent`
    keyDown with `text` plus keyUp, so one-time-code boxes that advance on `keydown` and Space on a
    focused checkbox work. Only Shift or no modifier, so no Ctrl or Meta letter is ever replayed.
  - A tap becomes `mouseMoved`, `mousePressed`, `mouseReleased` at the tap point; a one-finger drag
    after 8 px becomes `wheel`; a hold without travel stays pressed until release (press-and-hold
    checks). Two-finger pinch and "+"/"-" buttons zoom the picture locally (1x to 4x); clicks stay
    exact because `point()` maps through `getBoundingClientRect()`. No server-side resize (it would
    change what the site measures mid-challenge).
  - One input POST in flight at a time; hover moves and wheel deltas merge while it is out; presses,
    releases and keys are never dropped or reordered.
  - Header: action kind, host, countdown, Done, scope tab switcher, "That tab isn't on screen",
    connection state with automatic reconnect.
  - Card fields: a turn viewer sees its scope tabs **without** covers. The grant goes only to the
    owner's channels and the person must see the card field they type into. Other guests, recordings,
    timeline pictures and agents keep covers and masking.
- **B9. Agents keep out.** While a grant is open, and while its tab is held after a timeout (B11),
  every `HAND_TOOLS` tool (`scripts/rules/policy.mjs:96`), `pairbrowse_run`, `browser_navigate`,
  `browser_navigate_back` and closing a scope tab are refused through `tabRefusal`
  (`scripts/daemon/serve/refuse.mjs:36`) with a `handedOff(page)` option. Snapshots, screenshots,
  `browser_wait_for` and `browser_handle_dialog` still work.
- **B10. Sensitive input stays with the person.** While a grant is open on a tab, every agent's results
  from scope tabs are masked as a joiner's agent's are (`output.forJoiner` with
  `pageread.mjs` `sensitiveValues`, `scripts/rules/policy.mjs:207` `maskForAgent`), and every picture
  from scope tabs is covered (`scripts/daemon/covers.mjs`) or withheld. The person's typed text never
  enters host notes, the activity log, the journal, the audit or notifications: presence notes carry
  field names only (`scripts/daemon/presence.mjs:372-391`). The live view does not log input.
- **B11. Timeout.** `grantMinutes` default 15 (1 to 120); exactly one reminder at `remindMinutes`
  (default 10). The reminder carries the link only if the redeem key is unspent ("already opened"
  otherwise). At expiry, in order: `journal.flushNow()`, `context.saveTabs()`, `yourTurn` gets "Not
  done in time", keys stop, one `ended` message, badge and Tools entry "Timed out", one host note
  ("Nobody finished the step in time. Progress is saved. Stop here, tell the user where you are, and
  don't retry the step or work around it."). The tab stays **held** (B9 refusals) until a new "you"
  (new grant, new single reminder), the owner's own input in the tab, or the session ends.
- **B12. Saved card (B-AP4).** Profile field `payments.savedCard` (default false).
  - Profile prep today disables payment autofill on every launch: `profilePreferences` sets
    `autofill.credit_card_enabled: false` and `profile_enabled: false` (`scripts/browser.mjs:206`).
    With `savedCard` true, that launch writes `credit_card_enabled: true` and nothing else
    (`profile_enabled`, password saving stay off).
  - Key store requirement: the engine encrypts saved cards with the Safe Storage key. On Linux the
    driver passes `--password-store=basic`, whose fallback is the engine's fixed built-in key; on macOS
    the mock keychain uses a fixed test password (`scripts/browser/safe-storage.mjs:1-12`). The option is
    honored only when `safeStorageFor(...)` (`safe-storage.mjs:41`) returns a real key: the macOS
    Keychain (`safeStorage: "keychain"`) or the per-install key file of patch 594
    (`~/.pairbrowse/safe-storage-key`, checked by `ensureSafeStorageKey`), which today is the only key
    available on Linux. Whether the key file counts on Linux is decision U3. Otherwise the launch
    keeps payment autofill off and status says "saved card refused: this browser has no key store for
    it". The open build is always refused.
  - Saving the card: the person adds it once in the engine's own payment settings page, opened by an
    owner-only action ("Add a saved card") in the owner's live view; agents can never open the
    browser's own pages (existing rule). Grant viewers cannot reach it.
  - Filling: only the person, during a hand-off. The engine's autofill list is browser UI and may not
    appear in screencast frames (measured by T-B18); the turn viewer therefore offers "Fill saved card"
    when a card-number field is focused in a scope tab of a saved-card profile, which sends ArrowDown
    then Enter as the person's own input. CVC and 3-D Secure stay with the person.
  - Agents never trigger or read it: in a saved-card session, all agent results are masked as in B10
    for every tab (not only during a grant), pictures are covered, agent typing and key presses into a
    card field (cc-* autocomplete, a valid card number, any field in a payment frame) are refused, and
    `pairbrowse_run` never touches card fields (as today). Saved card data never appears in snapshots,
    logs, notifications, audit lines or agent summaries.
- **B13. Payment steps.** The existing guard (`scripts/rules/clicks.mjs` `paySignal`, the "Pay:" naming
  rule, `docs/security.md:54`) is unchanged for agents. A payment hand-off is kind `payment`; the
  person reviews and presses the site's Pay button themselves. The agent resumes only after the grant
  ends and verifies the outcome by snapshot (masked). The "Your turn" badge row
  (`docs/security.md:56`) changes: the person may now enter card details or codes, but only in the
  site's own fields of the handed-off tab, never in a PairBrowse badge.
  - **Agents never type payment credentials, in any session** (B-AP3; today no rule stops it, only
    masking and the Pay click rule exist). `browser_type`, `browser_fill_form`, `browser_press_key` with
    text, and fast-mode type and fill steps are refused through `tabRefusal` when the target is a card
    field (the signals `paySignal` and `scripts/daemon/page.mjs` already read: `cc-*` autocomplete except
    `cc-name`, any field inside a payment frame) or when the typed value holds a valid card number
    (the checksum `policy.mjs` masks by). A secret whose value is a card number is never typed. The
    refusal says "Card details are the person's to enter: hand this step over with pairbrowse_status
    kind you, step payment." Fast mode already never fills a payment provider's card frame
    (`docs/security.md:52`).
- **B14. Compatibility failures vs site verification.** When a hand-off starts, `yourturn.mjs` reads
  the open compatibility items (Phase C network verdict, `scripts/rules/coherence.mjs` items from D and
  E). The status result reports two lists: "Site verification (yours to do): CAPTCHA on <host>" and
  "PairBrowse setup problems (PairBrowse's to fix): time zone Europe/Berlin vs egress US". A
  compatibility problem never mints a grant by itself and never asks the person to work around it; a
  genuine verification is always handed over, never retried or bypassed.
- **B15. Resume.** Grant end reasons: `done`, `cleared`, `agent`, `tab-closed`, `session-switched`,
  `revoked`, `expired`, `browser-restarted`, `helper-stopped`. On every end but `expired`, one host note
  names the person's actions (field names only) and says to take a snapshot; `browser_wait_for` wakes
  early (its race in `wait-for.mjs` gains `turns.ended(page)`); the fast-mode `handoff` step
  (`scripts/runner/steps/handoff.mjs`) waits for the grant; refusals lift. Done is a hint; the agent
  verifies the page.
- **B16. Crash and restart fallback.** A pending hand-off (kind, tab address, deadline, reminded flag;
  no keys) is kept in `sessionFile(name, "turn.json")` (0600). After a browser crash with keep-alive,
  when the tab returns as a successor, `yourturn.recover()` mints one replacement grant with the same
  deadline and sends "The browser restarted; use this new link". After a helper restart the same file
  does this once if the deadline has not passed. Otherwise the `ended` message tells the person the
  step was stopped safely.
- **B17. Audit.** `scripts/daemon/audit.mjs` `createAudit({ file, now, log })` appends `{ t, kind,
  grant, session, tab, detail }` to `paths.audit` (`~/.pairbrowse/audit.jsonl`, 0600, rotated at 1 MB).
  Kinds: `minted, notified, notify-failed, reminded, redeemed, reuse, stream-refused, input-refused,
  ended`. `tab` is origin and path only; `detail` from a fixed vocabulary; unknown fields refused.
- **B18. Desktop unchanged** with `handoff.enabled` false, apart from the card-field rule of B13. The `char` key and one-in-flight posting stay
  turn-only in this phase.

### Design
Config (`scripts/config-schema.mjs`, `DEFAULT_CONFIG`, `docs/configuration.md`; not in Settings):

```json
"handoff": {
  "enabled": false,
  "grantMinutes": 15,
  "remindMinutes": 10,
  "channels": [
    { "type": "webhook", "urlSecret": "PAIRBROWSE_WEBHOOK_URL" },
    { "type": "ntfy", "server": "https://ntfy.sh", "topicSecret": "PAIRBROWSE_NTFY_TOPIC", "tokenSecret": "PAIRBROWSE_NTFY_TOKEN", "link": "auto" },
    { "type": "telegram", "tokenSecret": "PAIRBROWSE_TELEGRAM_TOKEN", "chatSecret": "PAIRBROWSE_TELEGRAM_CHAT" },
    { "type": "discord", "urlSecret": "PAIRBROWSE_DISCORD_WEBHOOK" },
    { "type": "slack", "urlSecret": "PAIRBROWSE_SLACK_WEBHOOK" }
  ]
}
```

`remindMinutes` at or above `grantMinutes` warns and falls back to `floor(grantMinutes * 2 / 3)`. A
channel with an unknown type, a missing secret, a secret without the `PAIRBROWSE_` prefix or a
non-loopback `http:` address is skipped with a warning naming it.

Senders (`scripts/daemon/notify/`), all through `post.mjs` `httpsPost(url, body, { headers, timeoutMs,
request })` (stdlib `node:https`, no redirects, capped answer, `https:` only except loopback, 10 s
bound, one retry after 5 s on 5xx or network error, none on 4xx):

| Sender | Request | Preview handling |
|---|---|---|
| `webhook.mjs` | POST JSON `{ event: "pairbrowse.turn" \| ".reminder" \| ".ended", id, kind, host, link, expiresAt, reason }` | n/a |
| `ntfy.mjs` | POST text to `<server>/<topic>`, `X-Title`, `X-Priority`, `X-Tags`, `X-Click: <link>` when included, bearer token when set | n/a |
| `telegram.mjs` | Bot API `sendMessage` to the configured chat, link previews disabled | previewer GET is harmless (B-AP1) |
| `discord.mjs` | channel webhook POST with embeds suppressed | same |
| `slack.mjs` | incoming webhook POST with unfurling off | same |

The exact request fields of Telegram, Discord and Slack are fixed against each provider's current
documentation in their commit and pinned by `test/notify-channels.test.mjs` fixtures; B-AP1 makes the
design safe whether or not a provider honors the preview setting.

Message: `{ kind: "turn" | "reminder" | "ended", id, action, host, link | null, expiresAt, reason? }`.

Modules:
- `scripts/daemon/grants.mjs` `createGrants({ now, mono, audit, log })`: `mint`, `redeem`, `matchView`,
  `matchRedeem`, `inScope`, `addToScope`, `end`, `endWhere`, `hold`, `held`, `release`, `open()`
  (no keys), `onEnd`, `ended(page)`, `sweep()`. Ids 8 hex, keys 64 hex, wall and monotonic expiry as
  `invites.mjs`. Memory only for keys.
- `scripts/liveview/grants.mjs`: redeem handler, stream gate, guest filters `forTurn(event, data,
  grant)`. Dispatcher (`scripts/liveview.mjs:567-599`) matches owner key, pages key, invites, then
  grants; grant keys never match on the join-code port; the Origin rule admits roles turn and redeem
  from `inviteOrigin`. A turn stream joins `linkGuests` with `{ role: "turn", grant }` (the approval
  card rule, `scripts/daemon/approvals.mjs:11-12`, applies) but skips covers for scope frames (B8).
- `scripts/liveview/routes/turn.mjs`: `POST redeem` (role redeem), `POST turn-done`, `POST turn { show }`,
  `POST turn-fill-card` (B12), `POST turn-revoke` (owner, from the Tools tab).
- `scripts/liveview/input.mjs`: `char` in `readViewerInput` and `replay`.
- `ui/events.js`: `turn` (`{ id, action, host, expiresAt, scope, state }`) and `turn-ended` (`{ reason }`),
  to the grant's stream only.
- `scripts/daemon/yourturn.mjs` `createYourTurn({ config, grants, notifier, notifyLocal, journal,
  saveTabs, hostNote, audit, hud, context, presence, coherence, linkFor, log, timers })`:
  `onStatus`, `onChallenge`, `onChallengeCleared`, `recover()`, `handedOff(page)`, `masked(page)`,
  `report()`. It takes over the `onStatus`, `onYourTurn` and `onCleared` lambdas now in
  `daemon.mjs:247-268`, so `daemon.mjs` stays within budget.
- `scripts/daemon/serve/tools/status.mjs`: result line "Your turn sent (telegram, ntfy): hand-off
  3fa1c2d9 for tab 2, until 14:35. Don't act in this tab; wait with browser_wait_for." Never the link.
- `scripts/tools/catalog.mjs`: `pairbrowse_status` gains optional `step`.
- `skills/pairbrowse/SKILL.md`: replace the 20-loop wait text (`:140-142`) with "wait with
  browser_wait_for; it returns when the person finishes; when PairBrowse says the hand-off timed out,
  stop and report". `scripts/core.md` (4,990 of 5,000 characters, `test/core.test.mjs:93`) changes only
  within budget.
- Test switch `TURN_MS` (grant life; reminder at two thirds).

Flow: status "you" or a detected challenge; mint; audit `minted`; send to channels; local notification
as today; person taps the link (landing page, no burn); taps "Take over" (burn, audit `redeemed`);
stream opens, cast pins, tab comes to front; person acts; Done, cleared or agent status ends the grant;
`browser_wait_for` wakes; agent snapshots and continues.

Errors: every channel fails (grant stays until expiry, status "Couldn't reach any hand-off channel
(<types>): tell the user directly", audit `notify-failed`); enabled with no usable channel (no grant,
status warning); spent, expired, ended or other-session key (404, indistinguishable; audit `reuse` by
spent hash); second stream (409 "This hand-off is open somewhere else."); out-of-scope input (409
"That tab isn't on screen.").

### Migration
None for state. `handoff` defaults keep today's behavior, except one rule that applies everywhere:
agents' typing into card fields, or of a card number, is now refused (B13; CHANGELOG). Reserved `PAIRBROWSE_` names already in
`secrets.env` become untypeable; `loadConfig` names them once. `audit.jsonl` appears on first use.

### Acceptance tests
| Area | Test (file: name) |
|---|---|
| Authorization | `test/grants.test.mjs`: "mint gives 8-hex id and 64-hex keys; keys never in open(), audit or log lines". `test/liveview-grants.test.mjs`: "role turn is refused tab, pause, profile, journal, invite, tools, config and nav go; role redeem may only GET the page and POST redeem"; "a turn POST from another Origin or Host is refused; a grant key on the join-code port is 404"; "owner revoke and invites revoke_all end the grant" |
| Expiry | `test/grants.test.mjs`: "expiry on wall and monotonic clocks; a clock set back never extends it". `test/liveview-grants.test.mjs`: "at expiry the stream gets turn-ended and later input is 404" |
| Replay prevention | `test/grants.test.mjs`: "a second redeem is null and audits reuse". `test/liveview-grants.test.mjs`: "a preview-bot GET leaves the grant valid; the tap consumes it; a second tap is refused" (approved decision 1); "a second concurrent stream is 409; a reconnect after a drop works within the grant's life" |
| Session and tab scope | `test/grants.test.mjs`: "another session's redeem is refused; a session switch or main tab close ends the grant". `test/liveview-grants.test.mjs`: "frames, thumb, state and tabs come only from scope"; "the cast stays pinned while the agent's URL changes elsewhere"; "a tab opened by the grant tab joins scope; another does not" |
| Interaction | `test/liveview.test.mjs` (fake CDP): "char replays keyDown with text and keyUp; Ctrl or Meta dropped". `test/fuzz/joiner-input.test.js`: "char never carries more than one character or a modifier other than Shift". `test/liveview.test.mjs` (viewer page): "tap posts mouse press and release; drag posts wheel; type box maps insertText, Backspace, Enter and compositionend and stays empty; zoom keeps a click on the same page point; one POST in flight with presses in order" |
| Mobile hand-off | `test/liveview-mobile.test.mjs` (new, viewer page in the runtime's browser with `isMobile`, `hasTouch`, 390x844): "landing page and Take over fit the screen with no horizontal scroll"; "the type box opens the keyboard path and a six-digit code reaches the page"; "setOffline for 20 s then back: the stream reconnects with the same view key and input resumes, nothing typed is lost or repeated" |
| Real-page interaction | `test/integration/your-turn.test.mjs`: "through a real view key: a cross-origin iframe checkbox gets click; a six-box one-time-code widget fills on keydown; Space ticks; Tab moves focus; a 2 s hold is seen as 2 s; a touch tap clicks". Measurement (reports, does not fail): "an open select list and the autofill list in screencast frames; dispatchTouchEvent alone yields click" (T-B18) |
| Notification delivery | `test/notify-channels.test.mjs`: "each of webhook, ntfy, telegram, discord, slack sends its request shape to a loopback stub, https only, no redirect, bounded, one retry on 5xx, none on 4xx"; "a third-party sender added to the table is called through the same interface"; "no message holds the agent's text, a password, a code, a card number or page text; the action kind sentence matches the step". `test/optin/ntfy.test.mjs` (`PAIRBROWSE_TEST_NTFY=1`): real publish and read back |
| Session continuity | `test/yourturn.test.mjs`: "a browser restart with keepAlive mints one replacement grant with the same deadline"; "a helper restart reissues once from turn.json before the deadline, never after". `test/integration/your-turn.test.mjs`: "after the hand-off the session's cookies and tab are those the person left; the agent continues without a new sign-in" |
| Safe payment confirmation | `test/yourturn.test.mjs`: "a payment hand-off masks every agent result from scope tabs and covers pictures; the person's typed card number is in no host note, activity line, journal, audit line or message". `test/refusals.test.mjs`: "agents' hands, run, navigate and close are refused in a handed-off or held tab; snapshots and dialogs are not"; "in any session, an agent's type, fill, key text or fast-mode step into a cc-* field, a payment-frame field, or with a valid card number as the value is refused with the hand-over sentence; a secret holding a card number is never typed". `test/shared-rules.test.mjs`: "after a payment hand-off ends, an agent's click on the site's Pay button still needs the Pay: name and asks". `test/liveview-grants.test.mjs`: "while a grant is open, another joiner's frames of a scope tab keep card covers and its agent's results stay masked" |
| Saved card | `test/browser.test.mjs` (profile prep): "payment autofill stays off by default and turns on only for a savedCard profile with a real key store; the open build and a fixed key refuse it with a status line". `test/refusals.test.mjs`: "in a saved-card session agents cannot type or press keys in a card field, and results are masked in every tab". `test/yourturn.test.mjs`: "Fill saved card is sent only from a turn viewer's tap; no agent tool reaches it; saved card data stays out of logs and notifications" |
| Agent resumption | `test/yourturn.test.mjs`: "Done ends with done, one host note, refusals lift"; "a detected challenge ends with cleared; an agent status ends with agent". `test/wait-for.test.mjs` (new): "browser_wait_for time 120 returns within 300 ms of the grant ending". `test/integration/your-turn.test.mjs`: "full path with a loopback webhook: status, link, GET, Take over, click and typed code land, agent click refused, Done, waiting agent returns, next click works; fast-mode handoff step finishes on Done" |
| Timeout recovery | `test/yourturn.test.mjs`: "exactly one reminder; at expiry flush, save tabs, yourTurn line, keys stop, one ended message, one host note, tab held"; "a held tab is released by a new you, the owner's input or a session end". `test/integration/your-turn.test.mjs`: "user offline past expiry: the held tab keeps its address and typed form values, no agent action reaches it, and a new you mints a grant to that same tab". `test/integration/your-turn.test.mjs` (`TURN_MS`): "one reminder, then the stop; a restarted helper reopens the same tabs" |
| Compatibility vs verification | `test/compat-vs-verification.test.mjs` (new): "a CAPTCHA with a time zone vs egress mismatch reports the mismatch under PairBrowse setup problems and the CAPTCHA under site verification, mints one grant for the CAPTCHA and never retries"; "a compatibility problem alone mints no grant and sends no your-turn message" |
| Audit, secrets, config | `test/audit.test.mjs`: "append-only, 0600, rotation at 1 MB, unknown fields refused". `test/redaction.test.mjs`: "reserved secrets hidden from pairbrowse_facts, never typed, still masked". `test/config-schema.test.mjs`: "handoff types, defaults and remindMinutes fallback". `test/liveview.test.mjs`: "liveview-turn.js is in ASSETS" |

### Security table changes
Section 12, rows B-1 to B-8.

## 6. Phase C: proxy and session networking

### Objective
Per-session HTTP, HTTPS and SOCKS5 proxies where the runtime allows, independent of profiles;
credentials stored securely and never logged; observed egress verified; DNS and WebRTC leak tests;
fail closed, also after recovery.

### Decisions
- **C1. Credentials never reach argv or the driver.** A Pro-repo patch `962-proxy-auth-file.patch` adds
  `--pairbrowse-proxy-auth-file=<path>`, following patches 510 and 594: the engine reads the file once,
  answers only auth challenges that come from the proxy whose host and port match `--proxy-server`,
  never a site's. Manifest field `proxyAuthFile` gates it (like `safeStorageKeyFile`,
  `native-engine.mjs:68`). The helper writes the file like `writeHelperKeyFile`
  (`scripts/browser.mjs:304-318`: 0600, fresh name under `run/`) and deletes it once the browser is up
  and on close. Until a build declares it, and always on the open build, a proxy with credentials is
  refused at launch. Rejected: argv (`ps`, crash dumps), the driver's `proxy.username` (sent to any site
  that answers 401, cache disabled), a loopback relay (any local user could use it).
- **C2. Schemes.** `http:` and `https:` (TLS to the proxy, system trust store, no "insecure" option)
  on both builds without credentials, on native builds with `proxyAuthFile` with credentials.
  `socks5:` without credentials on both builds (names sent to the proxy); with credentials refused
  (decision U4). `socks4:`, PAC and `direct:` refused.
- **C3. Credential storage** in `secrets.env` as `PAIRBROWSE_PROXY_<ID>_USERNAME` and `_PASSWORD`
  (reserved, B6). Values shorter than 4 characters are refused (`redact` masks 4 and more,
  `secrets.mjs:73`); ids at most 34 characters (`validSecretName`, 60). Set through
  `node scripts/net/credentials.mjs set <ID>` (stdin, echo off, never argv). For every secret:
  `loadSecrets` uses `lstatSync`, refuses a symlink, another owner or a non-regular file (the check
  `ensureSafeStorageKey` already applies); `writeSecrets` writes a 0600 temp file and renames.
  `daemon.log` lines are masked through `scripts/daemon/logfile.mjs` (also frees `daemon.mjs` lines).
  No encryption at rest: the key would sit beside the file under the same user.
- **C4. Network config is operator config** in `config.json` `network`, read from the file at each
  launch (the helper never re-reads `config.json` otherwise, `daemon.mjs:101`). Choice order:
  `network.sessions[<session>]` (id or `null` for direct), else the session's profile `network` id,
  else `network.default`, else direct. A profile naming an undefined id refuses the launch. No agent
  tool sets a proxy or credential. Session rename and delete update the map.
- **C5. Strict mode by default** for proxied sessions: `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE
  <proxy host>, EXCLUDE localhost` and `--webrtc-ip-handling-policy=disable_non_proxied_udp` on both
  builds; a user's `--host-resolver-rules` is dropped and logged. Loopback always passed as
  `proxy.bypass` (`localhost,127.0.0.1,[::1]`) so the driver does not route the helper's own
  `127.0.0.1` traffic to the proxy. A non-loopback bypass is refused in strict mode. No profile
  preference is written for networking.
- **C6. Checks before any saved tab loads.** (1) A helper-side probe through the proxy (stdlib `net`,
  `tls`; CONNECT or SOCKS5 with the name as a domain) to `network.checkUrl` before `launchEngine`; (2) a
  browser-side probe of the same URL with CDP `Network.loadNetworkResource` in an internal
  `about:blank` tab; (3) a WebRTC gather in that tab against `stun:stun.cloudflare.com:3478`. Default
  `checkUrl` `https://cloudflare.com/cdn-cgi/trace` (answers `ip=` and `loc=`). Direct sessions run no
  check.
- **C7. Fail closed** on: proxy unreachable; browser egress differing from the helper-through-proxy
  egress or outside `expectEgress`; egress equal to the direct one when `expectEgress` is unset; a WebRTC
  candidate other than mDNS or the proxy egress; strict switches not applicable; a check that times
  out. The browser closes, tools are refused with the reason, the person is notified (Phase B channels
  when configured). The same check runs after every recovery (section 3.2). The proxy list has no
  `DIRECT` fallback.
- **C8. Egress change**: recheck every `recheckMinutes` (10); a change or a failed recheck does
  `onEgressChange`: `"pause"` (default, pauses agents through `scripts/daemon/pause.mjs`, a person
  resumes), `"notify"`, or `"ignore"` (rotating proxies with a country expectation). Once per change.
- **C9. Observations apart.** Each check appends to `sessionFile(name, "network.json")` (0600, last 50;
  memory only for clean sessions). The direct IP is never stored (only `sameAsDirect`). With geoip,
  `savePersona` strips `GEOIP_FIELDS` (`native-engine.mjs:22`), so derived values are recomputed each
  launch; the pack is called with `quiet` true and the proxy, so its lookups never go direct. Pro-repo
  item: `applyGeoip` takes the IP C6 measured and reads only the pinned database (Phase E E11).
- **C10. A saved engine persona with `proxy` refuses the launch** with a sentence pointing to
  `network.proxies` (dropping it would turn a proxied session into a direct one).
- **C11. Strict sessions share by pictures only**: `screens.available()` (`scripts/liveview.mjs:399`)
  returns false so joiners get frames, and a strict session asks for frames when it joins.
- **C12. Leak tests read what the engine did.** Test switch `NETLOG` adds `--log-net-log=<test home>/netlog.json`
  in a harness-started helper only; the test fails on any host resolution other than the proxy host
  and loopback. Docker opt-in adds a stub DNS server and a STUN responder on the direct network.
- **C13. Coherence input.** Each check's `loc` (country) feeds `scripts/rules/coherence.mjs`
  (`locale.timezone-vs-egress`, `locale.language-vs-egress`) so time zone and languages are checked
  against the egress region.

### Design
```json
"network": {
  "proxies": {
    "us-east": { "server": "http://203.0.113.10:3128", "auth": true, "bypass": [],
                 "expectEgress": ["203.0.113.0/24", "country:US"], "onEgressChange": "pause" }
  },
  "default": null,
  "sessions": { "shop-a": "us-east", "shop-b": null },
  "strict": true,
  "checkUrl": "https://cloudflare.com/cdn-cgi/trace",
  "recheckMinutes": 10
}
```
Absent `network` means every session is direct. Proxy entry defaults: `auth: false`, `bypass: []`,
`expectEgress: null`, `onEgressChange: "pause"`. Ids `^[a-z0-9][a-z0-9-]{0,33}$`; secret names use the
id upper-cased with `-` as `_`. A `server` with user info is refused. Not in Settings.

Modules: `scripts/net/config.mjs` (`checkNetwork`, `networkFor(config, session, { profileNetwork })`,
`launchPart(net, { shell, secrets })` returning `{ proxy: { server, bypass }, args, authFile }`);
`scripts/net/credentials.mjs` (`proxySecretNames`, `credentialsFor`, CLI `set`, `remove`, `list`);
`scripts/net/probe.mjs` (`probeEgress`, bounded steps, errors name host:port and step, never the
credential); `scripts/net/verdict.mjs` (`inExpected`, `egressVerdict`, `webrtcVerdict`, reusing
`parseV4`/`parseV6` from `scripts/rules/network.mjs`); `scripts/net/browsercheck.mjs`
(`checkInBrowser`, every await bounded with `within`). Helper part `scripts/daemon/network.mjs`
`createNetwork(deps)`: `forLaunch`, `checkAtLaunch`, `start`, `stop`, `refusal()`, `statusParts()`,
`strict()`, `observations()`. Changes: `scripts/native-engine.mjs` (`proxyAuthFile(manifest)`, refuse
`proxy` in saved and persisted layers, no credentials in `merged.proxy`, geoip quiet, `savePersona`
strips geoip fields); `scripts/browser/choice.mjs` (`proxyAuthFile` in `shellFrom` and
`EXTENSION_SHELL`); `scripts/sessions.mjs` (`networkFile` in the rename and delete lists). Test
switches `NET_CHECK`, `NETLOG`, `RECHECK_MS`.

Auth file (engine contract, one line, 0600): `{"server":"http://203.0.113.10:3128","username":"...","password":"..."}`.

Observation file: `{ "version": 1, "checks": [ { "at", "kind": "launch|recheck", "proxy", "server",
"browser": { "ip", "loc" }, "helper": { "ip", "loc" }, "sameAsDirect", "webrtc": { "candidates",
"verdict" }, "dns": "strict", "verdict": "ok|failed|changed", "reason" } ] }`.

Errors (one sentence each, masked, in status and the launch error): unknown id or bad `server`
(config warning; sessions using it refuse); `auth` without secrets ("network us-east needs
PAIRBROWSE_PROXY_US_EAST_USERNAME and _PASSWORD in secrets.env"); `auth` on a build without
`proxyAuthFile` or the open build; SOCKS5 with `auth`; strict with a non-loopback bypass; unreachable,
timeout, leak or mismatch (browser closed before restore, tools refused, notified once); untrusted
`https:` proxy certificate (names host and "certificate"); `secrets.env` a symlink, another user's or
readable by others (all secrets disabled, said once).

### Migration
`config.json` unchanged. A `secrets.env` that is a symlink or another user's stops being read (rare;
CHANGELOG). A saved persona with `proxy` now refuses the launch with the move-it sentence. The persona
file stops holding geoip fields at the next geoip launch; `test/native-engine.test.mjs:548` changes
its expectation.

### Acceptance tests
Shared stubs `test/helpers/proxies.mjs` (stdlib: HTTP CONNECT with optional Basic auth, the same over
TLS with a test CA, SOCKS5 with and without RFC 1929 logging address types, a trace echo, pages with
prefetch, preconnect, WebSocket and images on unique names, a STUN responder).

Unit: `test/net-config.test.mjs` ("network block read; wrong values refused with the key"; "session
map, then profile id, then default, then direct; unknown id refuses"; "user info, socks4, PAC refused");
`test/net-credentials.test.mjs` ("proxy secrets reserved"; "set reads stdin, keeps other secrets and
0600"; "passwords masked in tool output, hook log, daemon.log and its stderr, diagnostics"; "a
credential appears in no launch error, observation file, profile export or config.json");
`test/native-engine.test.mjs` ("credentials reach the browser only through the auth file"; "refused
without proxyAuthFile and on the open build"; "SOCKS5 with credentials refused; without passes";
"saved persona proxy refuses"; "geoip with a proxy never writes its fields into the persona");
`test/net-launch.test.mjs` ("strict switches on both builds; a user's host-resolver-rules dropped;
non-loopback bypass refused"; "switching a proxy leaves PairBrowse-written profile files byte for
byte the same"; "loopback bypass always passed; for SOCKS5 the helper's resolver rule is last");
`test/net-probe.test.mjs` ("CONNECT with Basic and SOCKS5 with RFC 1929 read ip and loc"; "https:
proxy works and an untrusted certificate is refused"; "SOCKS5 sends address type 3"; "hung or
malformed proxies end within bound without the credential"); `test/net-verdict.test.mjs` ("CIDR and
country expectations, same as direct, browser vs helper, change from baseline"; "WebRTC host or srflx
with a real address is a leak"; "a timeout is a failure, never a pass"); `test/net-refuse.test.mjs`
("a failed check refuses tools; status names network state without secrets"); `test/profile.test.mjs`
("secrets.env symlink, other owner or non-file refused; writeSecrets atomic"); `test/sessions.test.mjs`
("rename and delete move network.json and the map entry"); `test/screenshare.test.mjs` ("strict session
offers and asks for frames"); `test/doc-truth.test.mjs` and `test/security.test.mjs` ("NETLOG, NET_CHECK,
RECHECK_MS documented and stripped outside the harness").

Integration `test/integration/proxy.test.mjs`: pages load only through the assigned proxy (http:,
socks5:); helper and browser egress agree and are recorded in `network.json`, not the profile; names
load through proxies with local resolution closed; WebRTC gathers no local address; an unreachable
proxy closes the browser before any saved tab loads; an egress change pauses agents and notifies once;
two sessions on different proxies; changing the proxy leaves profile files unchanged; DNS leak test
with NetLog (and the same pages with strict removed show local resolutions, proving the test); proxy
killed mid-session: no direct connection, agents paused; browser killed in a proxied session: the
check runs before restore and a down proxy keeps tabs closed; the browser's own pages still reach
`127.0.0.1` and the proxy log has no loopback request; WebRTC leak test proves itself with the policy
removed.

Opt-in: `test/optin/proxy-native.test.mjs` (a build with `proxyAuthFile`: authenticated proxy via the
file; no credential in argv, daemon.log or diagnostics; a site's 401 never receives it; the file is gone
once up); `test/optin/proxy-docker.test.mjs` (A13 container whose only route out is the proxy; stub DNS
logs no page names; STUN on the direct network sees nothing; a planted direct route fails the check);
`test/optin/proxy-real.test.mjs` (`PAIRBROWSE_TEST_REAL_PROXY`, the default check URL reports the
proxy's egress).

### Security table changes
Section 12, rows C-1 to C-6.

## 7. Phase D: profiles with import

### Objective
First-class, versioned profiles: import, validate, store, select, export, migrate, retire; each
session's state isolated through the engine's own user-data-dir; unsupported fields reported
explicitly; settings applied where the engine supports them, the rest measured or reported.

### Approved decision (from the user, 2026-10-20)
**D-AP2. Profiles carry settings, not other devices.** Locale, time zone, languages, viewport and
screen, device-pixel ratio, color scheme, proxy assignment and saved state. Graphics (GPU, renderer,
WebGL, WebGPU, fonts) are measured from the real runtime and reported as themselves, never imported.
Imported fields that describe another device's hardware are reported `unsupported` and not applied.
No GPL datasets bundled. Consistency checks (locale, time zone and languages vs egress region; a
believable screen) are what reduce needless blocks; a believable GPU means running on a host that has
one.

### Decisions
- **D1. Profile is configuration; session is storage.** A session is assigned exactly one profile;
  several sessions may share a profile.
- **D2. Isolation is the engine's own**: one user-data-dir per session per browser kind
  (`paths.mjs:113`, `engine.mjs:22-26`), one live browser per helper (`scripts/daemon/browser/state.mjs`);
  concurrent sessions run as named instances (`PAIRBROWSE_INSTANCE`). The persona is process-wide (the
  engine reads its switches per process), so two personas never share a process.
- **D3. Identity lock**: a profile that pins a seed (`persona.seed`) runs in one browser at a time across
  instances of one shared home: an owner-only lock in `paths.shared/identity-locks/` keyed by the seed's
  SHA-256, takeover rule as `scripts/install-lock.mjs`. Profiles without a pinned seed get a
  per-session seed (today's `sha256(directory)`).
- **D4. Storage per home, owner-only**: `~/.pairbrowse/browser-profiles/<id>.json` (0600, dir 0700),
  revisions in `<id>.history/<revision>.json`; `~/.pairbrowse/engine-profiles/` (0700) as the pack's
  persona and cache dir. The helper sets `PAIRBROWSE_ENGINE_PROFILE_DIR`, `PAIRBROWSE_ENGINE_PROFILE_SOURCE`
  (an empty owned dir) and `PAIRBROWSE_ENGINE_CACHE` in its own process before `loadEngine`
  (`scripts/engine.mjs:70`).
- **D5. The `default` profile is config-backed**: computed from `config.json` each launch (kind
  `config`), its id, history and validation stored, its fields not; a changed `configHash` bumps the
  revision. Store profiles (kind `store`) are edited only through the store.
- **D6. Typed fields only.** The mapper turns fields into switches that pass `screenBrowserArgs`
  (`scripts/browser-args.mjs:124`), engine keys from `PAIRBROWSE_ENGINE_KEYS`
  (`config-schema.mjs:16-19`), or preferences (`savedCard`). A profile cannot name an executable,
  extension, proxy server, launch option, agent option, `canvasBridge` or a hardware value.
- **D7. Close F1**: saved and persisted persona layers pass only `PAIRBROWSE_ENGINE_KEYS`; others named
  and dropped (`UNSUPPORTED` still refused; `proxy` refuses per C10; `canvasBridge` refuses per E1).
  `test/native-engine.test.mjs:511` changes to "launch controls are named and dropped".
- **D8. Close F2 and F3**: `profileSelect` becomes closed (`os`, `mode`, `topN`, `key`, `preferLocal`,
  `offline`, `maxEncodedSize`, `quiet`); `python`, `converter`, `apiBase`, `licenseKey`, `localDir`,
  `autoDownload`, `autoDownloadCount` refused. `helperEnv` (`daemon-connect.mjs:58`) drops inherited
  `PAIRBROWSE_ENGINE_*`.
- **D9. Persona `"auto"` and `"local"` (F5, D-AP2).** PairBrowse never calls `pack.resolveAuto` or picks
  another device's profile from a library. In `config.json` both are read as "this computer": the macOS
  host capture, else the seed persona with real graphics (E2), with one status note ("PairBrowse no
  longer picks another device's profile; graphics come from this computer"). Store profiles cannot
  choose them. `persona.source` is `"seed"` or `"host"`.
- **D10. Engine pin and validation status**: each profile records `engine: { major, build }`. Another
  major refuses ("re-validate or migrate"); another build of the same major launches `unverified`.
  `validation[build] = { status: "validated" | "unverified" | "failed", at, pack, runtimeKey?, graphics?,
  items: [...] }` with one item shape shared with Phase E: `{ field, rule, class, status, requested,
  measured, severity, reason }`, `class` from the property matrix (section 9), `status` one of
  `applied, not-applied, derived, unsupported, matched, mismatch, unverified`. `requireValidatedProfiles`
  (default false) refuses `unverified` and error-severity coherence items.
- **D11. Explicit fields fail closed; imported data is reported.** A set field the chosen browser cannot
  apply refuses the launch (for example `locale.timezone` on the open build). Data inside an imported
  file that is not applied is listed per field as `unsupported` or `not-applied` and never refuses.
  The open build applies switch-based fields only (`--lang`, `--window-size`,
  `--force-device-scale-factor`, `--force-dark-mode`, `--force-prefers-reduced-motion`).
- **D12. Derived values are recorded, never stored as configuration**: geoip, host `Intl`, build
  `platform` and `brandVersion` (`native-engine.mjs:247-248`, fixes F4 if the pinning test confirms it).
  Languages: profile `locale.languages` reach `--accept-lang`; `Intl` only when unset (F7).
- **D13. Binding on every launch**: `pairbrowse-binding.json` `{ profileId, created }` in
  `profileDir(name)`, `sessionFile(name, "assignment.json")` `{ profileId }`, and the persona saved
  under the profile id (`new pack.Profile(<id>, ...)`). A disagreement refuses the launch, never
  re-stamps. Reassignment is person-only and rewrites assignment and binding together.
- **D14. Who manages profiles**: the person, by CLI and owner-only live view routes. Agents may list
  profiles and pick one in `pairbrowse_session new` (`profile`), nothing else.
- **D15. Import formats v1**, detected by content:

| Id | Detected by | Imported | Reported unsupported |
|---|---|---|---|
| `pairbrowse-profile/1` | `"format": "pairbrowse-profile"`, `"formatVersion": 1` | all typed fields, provenance, license; older versions through the upgrader | none (a newer version refused) |
| `engine-device/1` (the collector's output) | object with a `navigator` section, `meta.schema_version` 1 or absent | `screen` width, height, avail, color depth, DPR; `navigator.languages` into `locale.languages`; the `intl` time zone when present | every hardware section: `webgl`, `webgpu`, `fonts`, `audio`, `speech`, `codecs`, `perf_memory`, `media_devices`, hardware concurrency, device memory, touch points, `canvas`; version identity (`navigator`, client hints) as `derived (engine)` |
| `engine-persona` (`{ name, options }`) | `options` object | `timezone`, `acceptLanguage`, screen keys, `devicePixelRatio`, `colorDepth`, `fingerprint` (seed) | `gpuVendor`, `gpuRenderer`, `hardwareConcurrency`, `deviceMemory`, `maxTouchPoints`, `platform`, `fingerprintProfile`, `webrtcIp`, `location`, `proxy`, `canvasBridge`, launch and agent options (credentials never stored or logged) |

  Not supported: other browsers' profile folders (storage, not configuration), the engine's upstream
  profile manager's export (format not read, no license file detected), generator output.
  The original file is never kept; its SHA-256 is.
- **D16. Import checks**, each a pure function of the file and a `host` object, written as items: size
  (file at most 1 MiB, refused before parsing); strict JSON and shape with sane ranges (screen 320 to
  16384, DPR 0.5 to 5); format version known; field report (every top-level section classed); coherence
  (`scripts/rules/coherence.mjs` `screen.believable`); provenance and license present.
- **D17. Provenance**: `{ format, file (base name), sha256, importedAt, by: "person", source, license,
  terms, collectedAt, tool }`. `source` and `license` required (from the file or `--source`,
  `--license`: an SPDX id, `own-capture`, or `unknown`, which imports as `unverified` with a warning on
  every launch). Nothing is bundled.
- **D18. Export** `pairbrowse-profile/1`: `{ format, formatVersion: 1, exported: { at, pairbrowseVersion,
  engineBuild }, profile, provenance, license, sha256 }` over canonical JSON. Left out: id, validation,
  history (unless `--with-history`), a pinned seed (unless `--include-identity`, which warns that two
  browsers with it look like one device), network references and credentials, saved-card data (it lives
  encrypted in the session's storage, never in a profile). Storage export (cookies, logins) is not
  offered.
- **D19. Versioning**: `SCHEMA_VERSION = 1` records, `formatVersion = 1` exports; pure upgrader chain in
  `scripts/profiles/upgrade.mjs`; a newer version refused, never rewritten.

### Design
Profile record (schema 1):

```json
{
  "schema": 1, "id": "p-3f9c0a1e7b2d4c58", "name": "berlin-desktop", "kind": "store",
  "revision": 4, "status": "active", "created": "2026-10-20T10:00:00Z",
  "engine": { "major": "150", "build": "150.0.7871.114" },
  "browser": { "kind": "pairbrowse" },
  "locale": { "languages": ["de-DE", "de", "en"], "timezone": "Europe/Berlin", "source": "set" },
  "screen": { "width": 1920, "height": 1080, "availWidth": 1920, "availHeight": 1050, "colorDepth": 24, "devicePixelRatio": 1 },
  "window": { "width": 1440, "height": 900 },
  "display": { "colorScheme": "light", "reducedMotion": false },
  "graphics": { "backend": "auto", "require": null },
  "persona": { "source": "seed", "seed": null },
  "payments": { "savedCard": false },
  "network": null,
  "adBlocker": null,
  "license": "own-capture",
  "provenance": [],
  "validation": {},
  "history": [{ "revision": 4, "at": "...", "change": ["locale.timezone"], "by": "person" }]
}
```

Field rules: `name` per `validName` (`sessions.mjs:16`), unique case-insensitively; `id` `p-` plus 16
hex; `browser.kind` `"pairbrowse"` or `"pairbrowse-open"`; `locale.source` `"set" | "system" | "geoip"`;
`graphics` per Phase E; `network` a Phase C id or null; `license` the most restrictive in `provenance`.

Modules (stdlib only, under 800 lines each): `scripts/profiles/schema.mjs` (`PROFILE_SCHEMA`,
`checkProfile`, reusing `config-schema.mjs`'s spec format); `device.mjs` (collector section table with
patch references, `classifySection`, `fieldReport`); `import.mjs` (`detectFormat`, `checkImport`,
`importInto`); `export.mjs`; `store.mjs` (`createProfileStore({ dir, now, randomId })` with `list`, `get`,
`create`, `update(id, fields, { expectRevision })`, `retire`, `restore`, `remove` refused while
assigned; `writeJsonAtomic` 0600; one write lock); `upgrade.mjs`; `map.mjs` (`fromConfig(config)`,
`toLaunch(profile, { browserKind, build, platform })` returning `{ switches, engineKeys, prefs,
results }`); `migrate.mjs`; `cli.mjs` (`list`, `show`, `create`, `edit`, `retire`, `restore`, `assign`,
`import [--dry-run] [--source] [--license]`, `export [--with-history] [--include-identity]`, `validate`,
`migrate [--undo]`). Helper part `scripts/daemon/sessions/profiles.mjs` `createProfiles(st, deps)`:
`forLaunch(session)`, `release()`, `statusParts()`, `list()`.

Changes: `scripts/paths.mjs` (`browserProfiles`, `engineProfiles`, `identityLocks`,
`requireValidatedProfiles: false`); `scripts/config-schema.mjs` (`requireValidatedProfiles`, closed
`profileSelect`); `scripts/sessions.mjs` (`assignmentFile`, `readAssignment`, `assignProfile`, rename and
delete lists, `createSession(name, profileId = "default")`); `scripts/native-engine.mjs` (mapped profile
layer as `overrides`, filtered layers, D9, D12, persona under the profile id);
`scripts/daemon/browser/launch.mjs` (D step of section 3.2; profile switches appended to `browserArgs`
before `launchOptions`; a profile `window` replaces the fixed `--window-size`);
`scripts/daemon/sessions/switch.mjs` and `scripts/tools/catalog.mjs` (`pairbrowse_session` `profile`
and action `profiles`); `scripts/launcher/daemon-connect.mjs` (D8); status line `Profile: <name> (rev
<n>, <status> on <build>)`; owner-only routes in `scripts/liveview/routes/sessions.mjs` and `ui/sessions/`
(list, assign, import upload through `liveview/http.mjs` capped at 1 MiB, export download).

Errors: unknown, deleted or retired profile (refused, names session and profile, never falls back to
`default`); other engine major; unsupported set field; binding mismatch (names both ids); identity lock
held (names the holder); import refused (names file, check and value); newer schema; corrupt file
(copied aside by `readJson`, history offered); `unverified` with `requireValidatedProfiles`.

### Migration
First start of the new version, under the helper's lock, before the first launch:
1. Build a report: the `default` profile from `config.json` (inventory below), every session, every
   persona file, every saved persona or `fingerprintProfile` the config names (dry-run import reports).
2. Create `browser-profiles/`, `engine-profiles/` (0700); copy `~/.pairbrowse-engine` into
   `engine-profiles/` (never moved; a note file left); store the `default` record.
3. Each session: `assignment.json` to `default`, persona renamed from "pairbrowse" to the default id,
   binding written.
4. Write `browser-profiles/migration.json`; status names unsupported and not-imported items until
   dismissed. A failing step stops migration; the launch runs on the legacy path with a warning.

Inventory: `browser` and older names to `browser.kind` (a custom path stays config-only); `browserArgs`
`--lang`, `--window-size`, `--force-device-scale-factor`, `--force-dark-mode`,
`--force-prefers-reduced-motion`, `--use-gl`/`--use-angle`/`--disable-gpu` read into fields (never
removed); `pairbrowse.timezone`, `acceptLanguage`, screen keys, `devicePixelRatio`, `fingerprint`,
`geoip` into fields; `pairbrowse.profile` `"auto"`/`"local"` to `persona.source` per D9; a named saved
persona or `fingerprintProfile` offered for import (originals untouched, read in place filtered until
imported); hardware keys (`gpuVendor`, `gpuRenderer`, `gpuStringSpoof`, `disableGpuFingerprint`,
`hardwareConcurrency`, `deviceMemory`, `maxTouchPoints`, `platform`, `platformVersion`, `brand`,
`brandVersion`) stay `config.json`-only legacy (decision U6), never profile fields; input keys
(`humanize`, `typingPace`, ...), `display`, `virtualScreen`, `server`, `browserSandbox`, `safeStorage`
stay global. `config.json` is never rewritten. `cli.mjs migrate --undo` exports store profiles to
`~/.pairbrowse/profile-exports/` first, then removes the new folders and files and renames personas back.

### Acceptance tests
Fixtures: small hand-written JSON under `test/fixtures/profiles/` (no third-party data).

| Area | Test (file: name) |
|---|---|
| Schema | `test/profile-schema.test.mjs`: "wrong values refused with the key, unknown keys named"; "a profile can't name a path, extension, proxy server, launch option, canvasBridge or hardware value"; "profileSelect is closed". `test/fuzz/profile-schema.test.js`: "no checked profile yields a switch outside the mapper's list, an engine key outside PAIRBROWSE_ENGINE_KEYS or a launch option" |
| Persistence | `test/profile-store.test.mjs`: "stable id survives rename"; "0600 files in 0700 folder"; "a new store instance reads the same record"; "stale revision refused, history appended"; "two writers: one wins, never half written"; "retire blocks assignment and launch"; "remove refused while assigned"; "corrupt file copied aside". `test/integration/profiles-persistence.test.mjs`: "after a helper restart the session reopens on its profile and revision with its cookie and storage" |
| Import | `test/profile-import.test.mjs`: "formats detected by content"; "over 1 MiB refused before parsing"; "unknown or newer versions refused naming both"; "an engine-device file applies screen, languages and time zone and reports every hardware section unsupported"; "an engine-persona's GPU, cores, memory, proxy, canvasBridge and launch options are unsupported and dropped, credentials in no file or log"; "provenance records SHA-256, source, license; missing ones refused; --license unknown imports unverified"; "--dry-run writes nothing". `test/fuzz/profile-import.test.js`: "any JSON is refused with a named check or yields a valid profile; never reads a second file" |
| Export | `test/profile-export.test.mjs`: "round trip keeps typed fields with a new id and empty validation"; "seed, history, network and saved-card data left out unless asked"; "license is the most restrictive"; "an edited export fails its SHA-256" |
| Mapping | `test/profile-map.test.mjs`: "fromConfig maps the inventory"; "toLaunch passes screenBrowserArgs unchanged"; "an explicit field the open build can't apply refuses"; "derived values never written into the profile"; "a network change leaves the revision unchanged" |
| Migration | `test/profile-migrate.test.mjs`: "a home with config.pairbrowse, browserArgs and three sessions migrates; each assigned default"; "unsupported keys listed, none silently dropped"; "idempotent"; "auto is recorded as this computer with no request made"; "~/.pairbrowse-engine copied, never moved"; "a failure leaves the legacy path working"; "undo exports first and restores byte for byte". `test/profile-upgrade.test.mjs`: "older schema upgraded with history kept; newer refused; the chain has no gap". `test/integration/profiles-migration.test.mjs`: "today's layout migrates with cookies kept; undo then the previous layout launches with the same cookies" |
| Isolation | `test/integration/profiles-isolation.test.mjs`: "cookie, localStorage, IndexedDB and history in one session are absent in the other"; "a cached resource is fetched again in the other session; cache files under each session's folder"; "Login Data and Extensions under each session's own folder" |
| Concurrent use | `test/profile-lock.test.mjs`: "a pinned seed is exclusive across instances; a dead holder is taken over"; "an unpinned profile runs in two sessions with different seeds". `test/integration/profiles-instances.test.mjs`: "two instances on separate profiles share nothing; the same pinned seed is refused in the second; one session can't open in two browsers" |
| Binding and versions | `test/session-profiles.test.mjs`: "binding mismatch refuses, never re-stamps"; "other major refuses, other build unverified, requireValidatedProfiles refuses"; "unknown or retired profile refused by name". `test/native-engine.test.mjs`: "saved and persisted layers pass only engine keys"; "persona saved under the profile id"; "in-major update keeps no old brandVersion"; "auto never calls resolveAuto"; "profile languages reach --accept-lang". `test/daemon-connect.test.mjs`: "helperEnv drops inherited PAIRBROWSE_ENGINE_*" |
| Agents and routes | `test/context-switch.test.mjs`: "session new with profile assigns it; action profiles only lists". `test/session-route.test.mjs`: "profile routes owner-only; invite keys and join-code port 403; upload over 1 MiB refused" |
| Applied values | `test/optin/profiles-native.test.mjs` (`PAIRBROWSE_TEST_EXECUTABLE`): "a profile's time zone, languages, screen and DPR are what pages read"; "a pinned seed reproduces the same values in two fresh sessions" |

### Security table changes
Section 12, rows D-1 to D-6.

## 8. Phase E: native graphics, diagnostics and validation

### Objective
Measure and report the real graphics of each runtime (backend, WebGL and WebGL2, WebGPU, canvas,
fonts, media); select software or GPU backends and confirm the selection after launch; keep requested
and measured apart; refuse unsupported requests instead of partial apply; fix the WebGPU
inconsistency; remove the canvas bridge; keep the sandbox on.

### Decisions
- **E1. Canvas bridge (pn patch 065) removed from every launch path and from the build's behavior.** pb
  now: `canvasBridge` refused in a saved persona, `config.json` and profiles; dropped from the persisted
  persona with one log line; `savePersona` never writes it; any `--canvas-bridge-*` stripped from the
  final switch list. pn: tail patch `960-no-canvas-bridge.patch` stubs `canvas_bridge_client.cc`
  (`Get()` returns null, no socket, no thread), drops the codec from its `BUILD.gn`, removes the
  initializer call and the six switches from the renderer forward list. The header stays so patches
  060 and 070 compile (every call site null-checks). Rejected: dropping 065 from `series` (forks 060,
  070, 998).
- **E2. Backend is the profile's `graphics.backend`** (`"auto"` default, `"software"`, `"gpu"`); the
  `default` profile reads `pairbrowse.graphics` (new key). Under D-AP2 graphics are always the
  runtime's own:
  - macOS native: the host capture (equal to this Mac's GPU), as today.
  - Linux native, any backend: `disableGpuFingerprint` (real WebGL strings, limits, extensions and
    WebGPU vendor and architecture, pn `002:740-741`, `955:155-163`) and `fingerprintNoise: false` (the
    pack's own warning: noise on real pixels).
  - `software` forces a software renderer on Linux: the engine's own software GL path, or Mesa's
    llvmpipe under Xvfb where the host has it; which one runs is measured and named, never assumed
    (exact switches fixed by spike E-S1; the
    candidate `--enable-unsafe-swiftshader` is stripped by the pack's `DEFAULT_IGNORED_ARGS` today, so
    the helper would stop ignoring it rather than allow it in `browserArgs`); refused on macOS unless
    E-S1 shows a working software path.
  - `gpu` requires a hardware backend; measured software refuses the launch and closes the window.
  - `gpu` with `--disable-gpu` or `--use-angle=swiftshader` in `browserArgs` is a config refusal.
- **E3. Backend read from the browser process**: `SystemInfo.getInfo` on a browser-level CDP session over
  the driver's pipe (no TCP port; `scripts/native/check.mjs:113` already reaches `ctx.browser()`).
  Unanswered within its bound: `unverified`, never assumed.
- **E4. Page probes never open a tab in the person's browser**: a throwaway launch with the profile's
  resolved options and a temporary user-data folder (as `captureMacHost` does): headless on macOS (the
  capture's Metal path), headed on the same private Xvfb on Linux. Triggers: the install self-check,
  `cli.mjs validate`, and the first launch per runtime key (logged "measuring graphics once for this
  browser version"). The live browser gets only the E3 read and a comparison with the stored
  measurement.
- **E5. Value classes**: requested (profile or config), measured (E3 and probes), derived (build or
  seed: UA major, cores, memory, heap limit, media capabilities), unverified (no measurement).
- **E6. `validated` only with measured evidence** for the build, pack SHA-256 and runtime key; a
  missing measurement is `unverified`; a switch without a matching page result counts as failed.
- **E7. Linux screen follows the display**: on Xvfb the helper passes `virtualScreen` as `screenWidth`,
  `screenHeight`, `availWidth`, `availHeight`, `colorDepth` when the profile's `screen` is unset; a
  differing profile `screen` is a compatibility error naming both.
- **E8. Requested and measured stored apart** in the Phase D record: `graphics` holds only requests
  (`backend`, `require: { webgl: null | 1 | 2, webgpu: boolean, platforms: ["linux", "macos"] }`);
  measurements go to `validation[build].graphics` and do not bump `revision`. Runtime key = SHA-256 of
  { engine build, pack SHA-256, platform, arch, display kind (`native`/`xvfb`), GPU vendor and device
  IDs and driver version from `SystemInfo`, backend switches }.
- **E9. Explicit compatibility errors, never partial apply** (static before launch, measured after):
  backend not available; `require` not met; a legacy `config.json` GPU identity
  (`gpuVendor`/`gpuRenderer`) the measured backend cannot back; `canvasBridge`; `screen` vs
  `virtualScreen`; any graphics field on the open build.
- **E10. WebGPU fix.** W1: one pure `normalizeWebgpu(profile)` (moved from `captureMacHost`) runs on
  every fingerprint layer, so a nested `webgpu.info` never reaches the engine unflattened. F4: pn tail
  patch `961-webgpu-real.patch` (same file as 075) skips the persona limits override under
  `webgl_real`, so real GPU strings come with real WebGPU limits. Until 961 ships, WebGPU limits are a
  "needs engine work" row and the validator reports a `webgpu.device` mismatch where `requestDevice`
  with the reported limits fails. Features and `isFallbackAdapter` are already real.
- **E11. Pack paths and data pins** (pn `engine/build.mjs` edits, new pack pin in `native-pack.mjs`):
  the font cache moves from the shared `cc-fc-cache` temp folder to `paths.fontCache` (owner-only); the
  geoip database download is pinned to a fixed release asset with SHA-256 (no `latest`); it stays
  user-fetched GPL-3.0 data, never bundled.
- **E12. `--headless` in `browserArgs` becomes harness-only** (`scripts/browser-args.mjs:81`, the
  `use-mock-keychain` pattern), so no validation comes from a user's headless run.
- **E13. Coherence rules** (shared module, `scripts/rules/coherence.mjs`, used by B14, C13, D16):
  `gpu.vs-platform` (renderer family vs platform), `gpu.software-as-hardware` (page claims hardware
  on a software backend), `screen.display`, `screen.believable` (window within screen, avail within
  screen, DPR in a common set), `locale.timezone-vs-egress` (error), `locale.language-vs-egress`
  (warning). The time-zone-to-country table is generated from the IANA tz database's `zone1970.tab`
  (public domain) into `scripts/rules/tzcountry.mjs` by a `scripts/dev/` script.
- **E14. Engine audit** (pn `native/ENGINE-AUDIT.md`, private): every switch in `000`, every data table,
  its page surface, property class and recorded provenance.

### Design
| Path | Content |
|---|---|
| `scripts/native/graphics.mjs` (new, pure) | `GRAPHICS_BACKENDS`, `normalizeWebgpu`, `graphicsPlan({ requested, platform, browserKind, measured, userArgs })` returning `{ switches, engineKeys, refusals }`, `compatErrors(...)`, `runtimeKey(info)`, `GRAPHICS` state (like `SANDBOX`) |
| `scripts/native/backend.mjs` (new) | `readBackend(ctx, { ms })` returning `{ kind: "hardware" \| "software" \| "unverified", vendor, device, renderer, driver, source: "systeminfo" }`; pure `parseSystemInfo` |
| `scripts/native/probe.mjs` (new) | probe page and `runProbe(page)`; `probeLaunch(...)` sharing bounded steps with `captureMacHost` |
| `scripts/native/validate.mjs` (new, pure) | `validate({ requested, derived, measured })` returning Phase D's `validation[build]` with items; `RULES` |
| `scripts/native/properties.mjs` (new, pure) | the section 9 matrix as data: field, class per runtime, switch or key, rule |
| `scripts/native-engine.mjs` | E1 guard, `normalizeWebgpu` on every layer, `graphicsPlan` merged, E7 screen, `graphics` read so it is not logged unknown |
| `scripts/config-schema.mjs` | `pairbrowse.graphics: { values: GRAPHICS_BACKENDS }` |
| `scripts/daemon/browser/launch.mjs` | steps 4 and 7 of section 3.2 |
| `scripts/daemon/serve/tools/status.mjs` | part `Graphics: <kind> (<renderer>), requested <backend>, <status> on <build>` |
| `scripts/daemon/diagnostics.mjs` | reports carry backend kind and status only, never GPU model or IDs |
| `scripts/native/check.mjs` | step "graphics: <kind>, WebGL <1/2>, WebGPU <adapter or unavailable>" |
| `scripts/paths.mjs` | `fontCache` |

Probe measures: browser process (GPU devices, vendor and device IDs, driver, GL/ANGLE renderer, feature
status for rasterization, WebGL, WebGL2, WebGPU, Vulkan, decode and encode profiles; field set fixed
by E-S1 fixtures); page (on `127.0.0.1` and `localhost`): WebGL and WebGL2 availability, vendor,
renderer, unmasked strings, extensions, limits, precision, a fixed scene's `readPixels` hash; WebGPU
`navigator.gpu`, adapter info, features, limits, `requestDevice` with the reported limits, one compute
round trip; canvas 2D and text scenes hashed twice in one page, on two origins and across two launches;
`document.fonts.check` over the persona list and a control list; `screen`, DPR, window sizes; codec and
`mediaCapabilities` answers; time zone and languages.

Measured record in `validation[build].graphics`: `{ at, runtimeKey, pack, runtime: { platform, arch,
display, sandbox }, backend, webgl, webgl2, webgpu, canvas: { stable, repeat, noise }, fonts, media }`.
Host GPU strings stay in the 0600 profile file and never leave the home.

Rules (severity): `backend.requested`, `backend.stable`, `require.*`, `webgl.strings-vs-backend`,
`webgl.limits-vs-backend`, `webgl.context`, `webgpu.vendor`, `webgpu.device`, `canvas.stable`,
`canvas.repeat`, `screen.display`, `locale`, `ua.build`, `sandbox.on`, `bridge.absent` (error);
`webgl.same-origins`, `webgpu.features-vs-limits`, `fonts.available` (warning); `media.capabilities`,
`memory` (info); plus the E13 coherence rules.

Errors (one sentence each): "Profile <name> asks for a GPU (graphics.backend: gpu) but this computer
renders in software (<renderer>)."; "graphics.backend: software is not available on macOS with this
build."; "Profile <name> requires WebGPU but no adapter is available here (<reason>)."; "config.json
sets a GPU identity (<fields>) that this computer's <kind> renderer cannot back."; "Profile <name> sets
a <w>x<h> screen but the virtual screen is <w>x<h> (virtualScreen)."; `SystemInfo` unanswered:
backend `unverified`; with `gpu` or `require` set the launch fails ("could not confirm").

Spike E-S1 (first, before E8 to E10): `SystemInfo.getInfo` through the driver on macOS native and in
the A13 container; software switch candidates (the engine's software GL and Mesa llvmpipe with the
container's Mesa packages); WebGPU on the Linux software path; fixtures
`test/fixtures/systeminfo-*.json`, `probe-*.json`.

### Migration
Persisted persona with `canvasBridge`: dropped at next launch with a log line. Saved persona with it:
launch refused naming the key. Nested `webgpu.info`: flattened at load, never written back to the
user's file. Existing profiles: `unverified` until the first launch measures once per runtime key.
Linux on any backend: real GPU strings and noise off (a visible fingerprint change on Linux; CHANGELOG).
`browserArgs --headless` outside the harness: dropped and named. The engine pack folders move into the
home under D4 (Phase D migration step 2).

### Acceptance tests
| Area | Test (file: name) |
|---|---|
| Canvas bridge | `test/native-engine.test.mjs`: "saved persona canvasBridge refused"; "persisted canvasBridge dropped"; "no --canvas-bridge-* reaches the launch, sandbox still on". `test/browser-args.test.mjs`: "canvas-bridge switches dropped"; "headless only in the harness". pn `test/native_tail_patch_test.py` (new): "960 after 065; stub Get returns null; no socket code; six switches not forwarded". Opt-in `test/optin/canvas-bridge-dead.test.mjs` (Docker, as root with the sandbox off, a local listener): "no connection arrives" |
| Backend selection | `test/native-graphics.test.mjs`: "auto, software, gpu accepted, others refused"; "gpu with --disable-gpu refused"; "Linux plan sets disableGpuFingerprint and noise off"; "gpu requested, software measured: error, context closed"; "software on macOS refused unless allowed"; "require unmet errors"; "screen vs virtualScreen"; "runtimeKey changes with driver, display kind, pack"; "parseSystemInfo: Metal hardware, Xvfb software, garbage unverified" |
| WebGL and WebGPU | `test/native-probe.test.mjs`: "probe results parsed: WebGL vendor, extensions, limits; WebGPU unavailable, fallback, full; canvas verdicts; fonts; media". `test/native-engine.test.mjs`: "nested WebGPU info flattened on every layer". pn `test/native_tail_patch_test.py`: "961 guards the limits loop with webgl_real" |
| Requested vs measured | `test/native-validate.test.mjs`: "mismatch item carries field, rule, requested, measured, severity; status failed"; "missing measurement is unverified, never validated"; "switch without page result counts failed"; "requestDevice failing with reported limits is a webgpu.device error"; "measurement stored in validation[build].graphics, revision unchanged" |
| Persistence and recovery | `test/native-validate.test.mjs`: "a store reload and a second forLaunch see the same request and measurement; a changed runtime key gives unverified". Opt-in `test/optin/graphics-recovery.test.mjs` (Docker): "a killed browser relaunches with the same graphics request and measurement" |
| Coherence | `test/coherence.test.mjs` (new): "Apple renderer on Linux is gpu.vs-platform"; "hardware renderer on a software backend is gpu.software-as-hardware"; "Europe/Berlin with egress US is an error; language mismatch a warning"; "a window larger than the screen is not believable" |
| Diagnostics privacy | `test/diagnostics.test.mjs`: "reports carry backend kind and status only". `test/native-check.test.mjs`: "self-check graphics step names a software backend as such" |
| Runtimes | Integration `test/integration/graphics-diagnostics.test.mjs`: "open build under CI's xvfb-run: probe runs, backend measured, WebGL strings agree with SystemInfo, sandbox on". Opt-in `test/optin/native-graphics.test.mjs` (macOS native): "backend hardware; probe agrees with host capture; WebGL and WebGPU vendors agree; validated". `test/optin/linux-graphics.test.mjs` (Docker): "backend software, the renderer named (engine software GL or llvmpipe); real WebGL strings and limits; WebGPU defined result; canvas stable and repeatable; fonts resolve; gpu refused; sandbox on". `test/optin/gpu-host.test.mjs` (`PAIRBROWSE_TEST_GPU_HOST=1`, new): "backend hardware; renderer equals the SystemInfo device; WebGPU adapter or a defined reason; validated; sandbox on"; "a killed browser relaunches with the same request and measurement" |
| Fuzz | `test/fuzz/graphics-compat.test.js`: "for any profile, every set graphics field is applied or named in an error" |

### Security table changes
Section 12, rows E-1 to E-5.

## 9. Profile property matrix

Classes: **C** configurable (a profile setting the engine applies), **M** measured (the runtime's real
value, reported), **D** derived (from the build or seed, constant), **U** unavailable or refused. Runtimes:
macOS native (host capture), Linux native on Xvfb without a GPU (software), Linux native on a GPU host
(real GPU, Xvfb or a real display). "Patch" names engine work still needed.

| Property | Source | Mechanism | macOS native | Linux software | Linux GPU host | Verified by | Patch |
|---|---|---|---|---|---|---|---|
| Time zone | profile `locale.timezone`, else geoip or host | `timezone` engine key | C | C | C | `profiles-native` "time zone, languages, screen and DPR are what pages read"; coherence test | none |
| Languages, Accept-Language | profile `locale.languages` | `acceptLanguage`, `--lang` | C | C | C | same; `native-engine` "profile languages reach --accept-lang" | none |
| Screen size, avail, color depth | profile `screen`; on Xvfb `virtualScreen` | screen engine keys | C | C (must equal `virtualScreen`) | C (on Xvfb must equal it) | `native-graphics` "screen vs virtualScreen"; probe `screen` | none |
| Window size | profile `window`; on Xvfb the screen | `--window-size` | C | C | C | `server-display` "window matches virtualScreen" | none |
| Device pixel ratio | profile `screen.devicePixelRatio` | `devicePixelRatio` key | C | C | C | `profiles-native` | none |
| Color scheme, reduced motion | profile `display` | `--force-dark-mode`, `--force-prefers-reduced-motion` | C | C | C | `profile-map` "toLaunch passes screenBrowserArgs" | none |
| Persona seed | profile `persona.seed` or per session | `fingerprint` key | C | C | C | `profiles-native` "pinned seed reproduces" | none |
| Proxy and egress | Phase C network | `--proxy-server`, auth file | C (proxy), M (egress) | C, M | C, M | `integration/proxy`, `net-verdict` | 962 for credentials |
| WebRTC addresses | Phase C strict mode | WebRTC policy switch | C (policy), M (candidates) | C, M | C, M | `proxy` I4, I13 | none |
| Rendering backend | host | `SystemInfo` read | M (Metal) | M (software); `software` forces it | M (hardware); `gpu` requires it | `native-graphics`, opt-in `linux-graphics`, `gpu-host` | none |
| WebGL/WebGL2 vendor, renderer | host | capture (macOS), `disableGpuFingerprint` (Linux) | M | M | M | probe rule `webgl.strings-vs-backend` | none |
| WebGL limits, extensions, precision | host | same | M | M | M | `webgl.limits-vs-backend` | none |
| WebGL and canvas pixels | host GPU or software raster | none | M | M | M | `canvas.stable`, `canvas.repeat` | none |
| Canvas noise | build default | `fingerprintNoise` | C (on) | U (off on real pixels) | U (off on real pixels) | `native-graphics` "Linux plan sets noise off" | none |
| WebGPU available, features, `isFallbackAdapter` | host | engine passes real | M | M (adapter or defined reason) | M | probe `webgpu.*` | none |
| WebGPU vendor, architecture | host | capture or `webgl_real` | M | M | M | `webgpu.vendor` | none |
| WebGPU limits | persona table today | engine override | M (captured) | D until 961, then M | D until 961, then M | `webgpu.device` | 961 |
| Fonts exposed and resolved | engine per-platform list; host fonts or bundled clones | `040-fonts`, `fontLaunchEnv` | M | M | M | `fonts.available` | none (cache path: pack edit E11) |
| Codec support | build | none | M | M | M | probe media | none |
| Media capabilities, `performance.memory` | persona | `147`, `146` patches | D | D | D | rule `media.capabilities`, `memory` (info) | none |
| Cores, device memory, touch points | seed persona | persona | D | D | D | probe values recorded | none |
| User agent and version | build | engine | D | D | D | `ua.build` | none |
| Platform | build | engine | D | D | D | `gpu.vs-platform` | none |
| Imported hardware (GPU, fonts list, audio, voices, codecs) | another device | none | U | U | U | `profile-import` "reports every hardware section unsupported" | none (by decision) |
| Saved card | session storage | autofill pref | C (with a key store) | C if U3 accepts the key file | same | `browser.test.mjs` saved-card case | none |
| Sandbox | helper | `sandboxDecision` | always on | always on (server mode) | always on | `engine.test.mjs`, rule `sandbox.on` | none |

Reproducibility per runtime: macOS reproduces only this Mac's graphics; Linux reproduces the host's
own software or GPU graphics; a profile moved between hosts carries settings, and its graphics are
re-measured on the new host (new runtime key, status `unverified` until measured). A believable GPU on
Linux means a host that has one.

## 10. External sources and dependencies

Bundling rule: only MIT-compatible code or data ships. GPL or AGPL data only when a user imports it,
with its license recorded. Read 2026-10-20 (licenses and versions from the GitHub API and npm).

| Source | License | Provenance | Verdict |
|---|---|---|---|
| Engine patch series, pack SDK, collector | BSD-3-Clause | pn `native/UPSTREAM.md`, pinned commit, collector SHA-256 in `NATIVE.engine.files` | already bundled (Pro builds); keep; collector is the probe oracle |
| Playwright / Patchright driver | Apache-2.0 | pinned in `runtime/` lockfile | keep as carrier |
| IANA tz database `zone1970.tab` | public domain | iana.org tzdata release, version recorded in the generated file | bundle the derived table (E13) |
| Engine's GeoIP database | GPL-3.0 (stated by the pack) | third-party release asset | user-fetched only, pinned by SHA-256 (E11); never bundled |
| GPL-3.0 dataset of about 10,000 Windows desktop fingerprints and the upstream's curated library of it | GPL-3.0 | public repos | not bundled; hardware sections would be unsupported on import anyway (D-AP2) |
| Apify fingerprint-suite generator | Apache-2.0 (v2.1.89) | training-data provenance undocumented | not adopted (D-AP2 excludes generated devices) |
| FingerprintJS (v5.3.0), BotD (v2.0.0) | MIT | GitHub | optional test oracles, vendored pinned build in fixtures only |
| CreepJS | MIT code, trademark policy on the name | GitHub, no tests | optional self-hosted test oracle at a pinned commit; name never in UI |
| rebrowser-bot-detector | `package.json` MIT, no LICENSE file | GitHub | not vendored until a license file exists |
| MyIP, webrtc-ips | MIT | GitHub | reference only; own probes instead (C6, C12) |
| Donut Browser, Cover Your Tracks, ua-parser-js | AGPL-3.0 | GitHub | rejected |
| Encrypted subscription profile vendors | closed | n/a | rejected (no verifiable provenance) |
| Telegram Bot API, Discord and Slack webhooks, ntfy | service terms | provider docs | network services the user configures; no code dependency (stdlib `https`) |

No new runtime dependency is added by any phase. Every new module is stdlib-only.

## 11. Implementation order

One commit each; each with its tests, docs and `docs/security.md` rows. Steps are numbered on their
own; the decisions each step lands are named in parentheses (A1 to E14 above). `->` names the steps
it depends on.

1. `display.mjs` geometry, `screenGeometry`, `serverMode`; `virtualScreen` and `server` schema (A1, A3).
2. Race-free Xvfb readiness (A7).
3. Ownership record, `reapOwn`, async `stop`, `stopNow` (A6, A8). -> 2
4. `daemon/browser/supervise.mjs`, launch and exit wiring, `ALLOWED` edges (A4). -> 3
5. Window follows the screen (A2). -> 1
6. Crash-loop guard, `statusLine` `more` list, `statusParts` (A5). -> 4
7. Sandbox in server mode and `"required"`; row A-2 (A10). -> 1
8. `server.keepAlive`, `readUse`, relaunch backoff, `markServer` (A9, A11). -> 6
9. Canvas bridge launch guard (pb) and `--headless` harness-only; rows E-1, E-5 (E1 pb part, E12).
   (independent)
10. `normalizeWebgpu` on every layer (E10 W1). (independent)
11. Tests pinning today's F1, F3, F4, F7 behavior (before D7, D8, D12).
12. Close F2, F3, F5: closed `profileSelect`, `helperEnv`, auto/local as this computer (D8, D9). -> 11
13. Close F1: filtered layers; `proxy` refusal shared with C10 (D7). -> 11
14. `daemon/audit.mjs`, `paths.audit` (B17).
15. Reserved secrets, `loadSecrets` owner and symlink checks, atomic `writeSecrets`, masked
    `daemon/logfile.mjs` (B6, C3). -> 14
16. `handoff` schema; senders (webhook, ntfy, Telegram, Discord, Slack) and the interface (B6, B7). -> 15
17. `daemon/grants.mjs` (B2, B3, B4). -> 14
18. `char` input and fuzz (B8).
19. Live view grant server: redeem page, stream gate, `routes/turn.mjs`, pinning, filters, events
    (B-AP1, B3, B4, B5). -> 17, 18
20. Turn viewer `liveview-turn.js` (phone-first) and mobile viewer tests (B8). -> 19
21. `daemon/yourturn.mjs`, lambdas out of `daemon.mjs`, status result, `TURN_MS`, masking (B7, B10,
    B11). -> 16, 19
22. `browser_wait_for` early wake, `handedOff` refusals, card-field refusals in every session,
    fast-mode step, `turn.json` recovery (B9, B13, B15, B16). -> 21, 8
23. `skills/pairbrowse/SKILL.md` and `core.md` text (B15). -> 22
24. `net/config.mjs` and `network` schema (C4). -> 15
25. Native-engine proxy rules: saved persona refusal, `proxyAuthFile` in `shellFrom` and
    `EXTENSION_SHELL` (C1, C10). -> 13, 24
26. Geoip fields out of the persona, quiet geoip (C9).
27. `daemon/network.mjs` `forLaunch`, launch wiring in section 3.2 order (C5). -> 4, 24
28. Probe, verdict, browser check, `NET_CHECK` (C2, C6).
29. `checkAtLaunch`, fail closed, refusal, status; row C-1 (C7). -> 27, 28
30. NetLog leak tests (C12). -> 29
31. Recheck, egress change, pause and notify through the B notifier (C8). -> 29, 16
32. Session rename and delete with network; strict sessions share frames (C4, C11).
33. `profiles/schema.mjs`, `upgrade.mjs` (D19). -> 12
34. `profiles/store.mjs`, paths and config keys (D4, D5). -> 33
35. `profiles/device.mjs`, `import.mjs` (settings only, hardware unsupported), `export.mjs` (D-AP2,
    D15 to D18). -> 34
36. `profiles/map.mjs`; session assignment in `sessions.mjs` (D1, D6, D11, D12). -> 34, 24
37. `daemon/sessions/profiles.mjs`, binding, persona under the profile id, launch wiring (D2, D10,
    D13). -> 36, 27
38. Identity lock, migration and undo, `pairbrowse_session` `profile`, CLI, owner routes and UI (D3,
    D14, Phase D migration). -> 37
39. Spike E-S1: `SystemInfo`, software switches, Linux WebGPU, fixtures; lands the A13 container
    harness `test/optin/server/container.mjs`, its first user. -> 8
40. `native/properties.mjs`, `validate.mjs`, validation shape in the store (E5, E6, E8). -> 34
41. `native/graphics.mjs`, `backend.mjs`, `pairbrowse.graphics` (E2, E3, E9). -> 39
42. `native/probe.mjs`, `probeLaunch`, self-check step (E4). -> 39, 40
43. `rules/coherence.mjs` and `tzcountry.mjs`; wired into D validation, C verdicts and the B report;
    `test/compat-vs-verification.test.mjs` (E13, C13, D16, B14). -> 29, 37, 21
44. Launch steps 4 and 7, status part, diagnostics (E7, E9). -> 41, 42, 37
45. Saved card: profile field, key-store check, prefs, owner "Add a saved card", "Fill saved card",
    agent refusals and masking (B-AP4, B12). -> 37, 21
46. Phase A integration file, CI `xauth`, Phase A opt-in tests on the harness (A13). -> 8, 39
47. pn: 960, 961, 962 patches, locks, tail-patch tests, `ENGINE-AUDIT.md`; next engine build (E1 pn
    part, E10 F4, C1, E14). -> 9, 10
48. pn then pb: pack edits (font cache, geoip pin, `applyGeoip` with the measured IP), new pack pin,
    `paths` (E11, C9). -> 26
49. Opt-in tests: proxy native and Docker, graphics (macOS, Linux, GPU host, recovery), canvas bridge
    dead, profiles native, ntfy. -> 47, 46
50. Docs: `docs/server.md` (new), `docs/profiles.md` (new), `docs/configuration.md`, `docs/browser.md` graphics
    section, `docs/sharing.md`, `docs/using.md`, ADR 0009 "In code", `.claude/CLAUDE.md` Layout,
    CHANGELOG, version bump in `package.json` and both plugin manifests, annotated tag.

## 12. Security implications

All `docs/security.md` changes, each landing in the commit of its behavior. Every row ends with tests
that exist at that commit (`test/security-table.test.mjs`).

| Row | Change | Content | Tests |
|---|---|---|---|
| A-1 | Move the "Limits" Xvfb bullet into a row | "A server's virtual screen is watched or driven by another user": private Xvfb, `-nolisten tcp`, random cookie in `~/.pairbrowse/run`; only our own dead Xvfb's lock and socket (our uid) are removed; Xvfb ended and cookie deleted on every exit | `test/display.test.mjs`, `test/security.test.mjs`, `test/integration/server-display.test.mjs` |
| A-2 | Change the sandbox row and the Limits bullet | Server mode: sandbox always on, off requests refused, root refused, a failing sandbox stops the launch; `"required"` does the same on a Linux desktop | `test/engine.test.mjs`, `test/config-schema.test.mjs` |
| B-1 | New | "A hand-off link reaches the wrong person or does more than meant": off unless `handoff.enabled`; links only to configured channels; GET never consumes, the tap does, once; view key holds one stream; 15 min default, 120 max; one tab of one session plus its sign-in pop-ups; no typed addresses, profile, approvals, pause or settings; private routes only | `test/grants.test.mjs`, `test/liveview-grants.test.mjs` |
| B-2 | New | "A hand-off viewer's input does more than a person's hands": checked input set; `char` never carries Ctrl or Meta; type box keeps nothing | `test/liveview.test.mjs`, `test/fuzz/joiner-input.test.js` |
| B-3 | New | "Hand-off notifications send more than meant", with per-channel exposure: webhook (your endpoint gets kind, host, expiry, link); ntfy (the server and anyone subscribed to the topic; on public ntfy.sh without a token no link); Telegram (Telegram's servers and the chat's members; bot messages are not end-to-end encrypted); Discord (Discord and the channel's members); Slack (Slack, the workspace's retention and the channel's members). Never the agent's text, codes, passwords, card data or page content; credentials are reserved secrets | `test/notify-channels.test.mjs`, `test/redaction.test.mjs` |
| B-4 | New | "An agent finishes a step meant for a person": hands, run, navigation and closing refused in a handed-off or held tab; in every session agents never type into card fields or type a card number (B13); the Pay click rule unchanged | `test/refusals.test.mjs`, `test/shared-rules.test.mjs` |
| B-5 | New | "What the person types during a hand-off reaches agents, joiners or logs": agent results from scope tabs masked as a joiner's, pictures covered; field names only in notes; nothing typed in the activity log, journal, audit or messages; the turn viewer itself sees card fields uncovered | `test/yourturn.test.mjs` |
| B-6 | New | "Saved payment cards": off by default, per profile; only with a real key store (U3), else refused; only the person fills, during a hand-off; agents masked in every tab of that session and refused in card fields; never in snapshots, logs, notifications or summaries | `test/browser.test.mjs`, `test/refusals.test.mjs`, `test/yourturn.test.mjs` |
| B-7 | New | "The audit trail leaks or is lost": 0600, no keys, links, secret values or page content, rotates at 1 MB | `test/audit.test.mjs` |
| B-8 | Change three rows | "Diagnostics leave the computer": adds hand-off messages to configured channels. "A page fakes the Your turn badge": the person enters codes or card details only in the site's own fields of the handed-off tab, never in a badge. Limits, invite links: a grant is a short-lived drive link for one tab | `test/hud.test.mjs`, `test/yourturn.test.mjs` |
| C-1 | New | "A session's proxy leaks its credentials, or traffic goes around it": `secrets.env` only, reserved, masked; to the browser only through an owner-only file read once and answered only to that proxy; never argv or the driver; strict mode closes local resolution and non-proxied UDP; loopback never proxied; checks before any saved tab, also after recovery; no direct fallback; egress change pauses agents | `test/net-credentials.test.mjs`, `test/net-launch.test.mjs`, `test/net-verdict.test.mjs`, `test/net-probe.test.mjs`, `test/integration/proxy.test.mjs` |
| C-2 | Change `browserArgs` row | Proxies only through `network`; the helper adds `--proxy-server` and `--host-resolver-rules` itself and drops a user's resolver rule in strict mode | `test/net-launch.test.mjs`, `test/browser-args.test.mjs` |
| C-3 | Change shared-browser row | Strict sessions share pictures through the join channel only | `test/screenshare.test.mjs` |
| C-4 | Change diagnostics row | Proxy credentials masked; egress IPs not included | `test/net-credentials.test.mjs` |
| C-5 | Change "Files at rest" | `network.json` per session; `secrets.env` must be your user's regular 0600 file, written atomically | `test/profile.test.mjs` |
| C-6 | Change test-switch row | `NETLOG`, `NET_CHECK`, `RECHECK_MS` reach only a harness-started helper | `test/security.test.mjs` |
| D-1 | Change `browserArgs` row | Saved and persisted personas pass only engine fingerprint keys; others named and dropped | `test/native-engine.test.mjs` |
| D-2 | New | "A browser profile reaches another session's data, or names something to run": typed fields only; binding checked every launch; pinned identity in one browser at a time; owner-only store | `test/profile-schema.test.mjs`, `test/session-profiles.test.mjs`, `test/profile-lock.test.mjs` |
| D-3 | New | "An imported profile file runs code, reads other files, leaks credentials or claims another device": one file, size-capped before parsing, no paths followed; hardware of another device never applied; person-only import | `test/profile-import.test.mjs`, `test/session-route.test.mjs` |
| D-4 | New | "Persona selection runs a program or contacts a service": no service resolver, closed `profileSelect`, no bootstrap, inherited engine variables dropped | `test/native-engine.test.mjs`, `test/daemon-connect.test.mjs` |
| D-5 | New | "PairBrowse ships data under a license you didn't accept": nothing bundled; imports record source, license, SHA-256; exports carry it | `test/profile-import.test.mjs`, `test/profile-export.test.mjs` |
| D-6 | Change "Files at rest" and the project-profile row | `browser-profiles/`, `engine-profiles/` owner-only; profiles chosen by the person, agents only pick among existing ones | `test/profile-store.test.mjs` |
| E-1 | New, and change the sandbox row | "A persona sends what pages draw to another computer": canvas bridge refused, dropped, stripped; build 960 has no bridge network code; no persona option can turn the sandbox off | `test/native-engine.test.mjs`, `test/browser-args.test.mjs` |
| E-2 | New | "The browser reports a graphics backend or GPU it isn't using": backend read from the browser process; validated only with evidence; real strings on Linux; unmet requests stop the launch | `test/native-graphics.test.mjs`, `test/native-validate.test.mjs` |
| E-3 | New | "Graphics diagnostics reveal this computer's GPU": measurements stay in the 0600 profile; joiners and reports get kind and status only | `test/diagnostics.test.mjs` |
| E-4 | Change "Supply chain" and "Files at rest" | GeoIP database pinned by SHA-256, user-fetched; pack folders and font cache inside the home | `test/native-check.test.mjs` |
| E-5 | Change `browserArgs` row | `--headless` only in test runs | `test/browser-args.test.mjs` |

## 13. Decisions (recorded 2026-10-20)

The user approved the recommended option for every decision, with these clarifications. They are
binding for implementation; where a phase section above says otherwise, this section wins.

1. **U1. Sandbox.** Always on in server mode. No opt-out is added. Sandboxing stays on throughout
   development and testing too; containers get a seccomp profile or host setting that allows user
   namespaces (`docs/server.md`).
2. **U2. Hand-off links from a phone.** Private routes (tailnet via `liveViewHosts`, or SSH) and an
   opt-in public link through the existing sharing tunnel (`handoff.publicLink`, default off). Grants
   are protected against preview requests (a GET never redeems), replay (single-use redeem key),
   expiry and cross-session or cross-tab use, on both routes. Public sharing is explicitly opt-in and
   its exposure is documented in `docs/security.md` and `docs/server.md`.
3. **U3. Saved-card encryption.** The initial implementation uses PairBrowse's per-install key file
   (`~/.pairbrowse/safe-storage-key`): mode 0600, owner, symlink and type checks on every read, atomic
   writes. Its threat model is documented: it protects a copied profile folder, not against programs
   running as the same user or root. No system key store is required.
4. **U4. SOCKS5.** Unauthenticated SOCKS5 first. Password authentication is a separately scoped
   follow-up (it needs an engine patch); until then a SOCKS5 proxy with credentials is refused with a
   named error.
5. **U5. Native-engine patches.** 960, 961 and 962 are implemented through the normal native build and
   review process and tested against every supported build. 960 removes the unused canvas bridge
   without weakening the sandbox; 961 corrects WebGPU reporting; 962 keeps proxy credentials out of
   command-line arguments and logs. Broad native-engine changes start only after the first milestone
   is reported.
6. **U6. Legacy hardware keys.** `gpuVendor`, `gpuRenderer` and the related `config.json` keys keep
   working for one release with a clear deprecation warning and migration guidance. They are never
   silently applied where unsupported, and never reported as measured hardware.
7. **U7. Card entry.** Payment credentials stay under direct human control; no agent credential-entry
   path is introduced. Before the desktop-wide card-field refusal (step 22, B13) lands, the existing
   confirmation and payment-field protections are traced and the compatibility impact is documented
   in this spec.

Implementation conditions (from the user):
- Keep the five phases and every agreed requirement: profile import and export, per-profile isolation,
  proxy separation, graphics validation, mobile interactive hand-off.
- Fix PairBrowse's own avoidable compatibility problems and report them apart from website-required
  verification. Never bypass CAPTCHA, bot checks, authentication or payment authorization.
- Verify that Linux today reports an NVIDIA-like persona over software rendering, and correct it so
  measured diagnostics are accurate.
- Start with dependency-ready work; never skip prerequisite investigations or security tests to reach
  Phase B sooner.
- Small, reviewable commits; run the relevant tests after each; a phase is complete only when its
  acceptance criteria pass.
- Update this spec and `docs/security.md` whenever implementation findings differ from the plan.

## 14. Definition of done

The work is done when every item below holds, each shown by the named tests passing in CI or, for
opt-in tests, in a recorded run on the named host. Nothing ships that weakens a rule in section 1.

Cross-cutting:
- Every `docs/security.md` row of section 12 is in the file, true, and names tests that exist
  (`test/security-table.test.mjs`); B-3 states each channel's data exposure.
- No new runtime dependency; every new module stdlib-only; nothing GPL or AGPL bundled (section 10).
- Wording in docs, UI and changelog: "stealth" or "everyday browser", never "undetectable"; the
  engine's upstream project is never named.
- `npm test`, `npm run lint`, `npm run test:fuzz` and `claude plugin validate .` pass; the version bump,
  CHANGELOG entry and annotated tag land together.

Phase A: the browser runs headed on its own Xvfb with the configured geometry, survives an Xvfb kill,
a browser kill and a helper SIGKILL with its session and tabs restored, stops after a crash loop, and
never runs without its sandbox in server mode (`test/integration/server-display.test.mjs`,
`test/optin/server/server-docker.test.mjs`).

Phase B, mobile first:
- A person on a phone receives a Telegram, Discord, Slack, webhook or ntfy message that names the
  action kind (sign in, verification, 2FA code, payment, other), the host and the expiry, and nothing
  else; a preview fetch leaves the link valid; one tap takes over the right tab
  (`test/notify-channels.test.mjs`, `test/liveview-grants.test.mjs`).
- On a 390x844 touch screen the person taps, scrolls, holds, zooms and types with the on-screen
  keyboard into the live tab, survives a dropped connection without losing or repeating input, and
  finishes the step (`test/liveview-mobile.test.mjs`, `test/integration/your-turn.test.mjs`).
- The agent resumes on Done or a cleared challenge without navigating away or signing in again; on no
  response it gets exactly one reminder, saves progress, holds the tab and stops safely; a browser
  crash or helper restart reissues one link with the same deadline or ends safely
  (`test/yourturn.test.mjs`, `test/wait-for.test.mjs`).
- Payments: the person reviews and authorizes; agents never type card details anywhere and are
  refused in a handed-off tab; what the person types reaches no agent, joiner, log, audit line or
  message; the saved card is off by default and refused without a real key store
  (`test/refusals.test.mjs`, `test/yourturn.test.mjs`, `test/browser.test.mjs`).
- PairBrowse's own avoidable signals (profile, graphics, proxy inconsistencies) are reported apart
  from genuine site verification; only the latter is handed to the person, and nothing is ever
  bypassed or retried around (`test/compat-vs-verification.test.mjs`).

Phase C: each session uses its own HTTP, HTTPS or SOCKS5 proxy, independent of its profile;
credentials appear in no argv, log, file or result; egress is measured and matches; DNS and WebRTC
leak tests pass and prove themselves; every failure closes the browser before any tab loads
(`test/integration/proxy.test.mjs`, `test/optin/proxy-docker.test.mjs`).

Phase D: profiles import, validate, store, select, export, version, migrate (with undo) and retire;
every unsupported or another device's field is listed, never silently applied; sessions keep separate
cookies, storage, logins, extensions, history and cache; a profile persists across restarts and
concurrent instances (`test/profile-*.test.mjs`, `test/integration/profiles-isolation.test.mjs`,
`test/integration/profiles-instances.test.mjs`).

Phase E: the active backend is read after every launch and reported as measured; WebGL, WebGL2,
WebGPU, canvas and fonts are probed and compared with the request; a GPU-less Linux host reports
software, a GPU host reports its own hardware, macOS its own GPU; unsupported requests stop the launch
with a named error; the canvas bridge is gone and WebGPU limits are real under real GPU strings (or
reported as a mismatch until patch 961 ships); the graphics request and measurement survive persistence
and recovery; the sandbox stays on (`test/native-graphics.test.mjs`, `test/native-validate.test.mjs`,
`test/optin/linux-graphics.test.mjs`, `test/optin/gpu-host.test.mjs`,
`test/optin/graphics-recovery.test.mjs`).
