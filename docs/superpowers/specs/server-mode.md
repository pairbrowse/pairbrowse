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
it. Linux runs seed-only: an Intel UHD 770 seed persona (WebGL strings, a desktop WebGPU limits table,
hardware video decode) and a screen picked from a seed pool, over unmeasured software rendering in a
1366x900 display (verified in milestone 1, section 13.1). Patch 065 (remote canvas renderer, needs an unsandboxed renderer) is unused but
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
| `scripts/liveview-redeem.html`, `.js`, `.css` (new) | a hand-off link's landing page | B |
| `scripts/liveview-turn.js` (new viewer asset) | phone-first turn viewer | B |
| `scripts/daemon/notify/` (new) | sender interface: webhook, ntfy, Telegram, Discord, Slack | B (used by C) |
| `scripts/daemon/yourturn.mjs` (new) | hand-off lifecycle, reminders, payment isolation, compatibility vs verification | B |
| `scripts/rules/coherence.mjs` (new, pure) | cross-phase consistency rules | B/C/D/E |
| `scripts/net/` (new: `config`, `credentials`, `probe`, `verdict`, `browsercheck`) | proxy config, credentials CLI, egress probes, verdicts | C |
| `scripts/daemon/network.mjs` (new) | `forLaunch`, `checkAtLaunch`, recheck, refusal | C |
| `scripts/daemon/logfile.mjs` (new) | masked `daemon.log` writer (moves lines out of `daemon.mjs`) | C |
| `scripts/profiles/` (new: `schema`, `device`, `import`, `export`, `store`, `upgrade`, `map`, `migrate`, `lock`, `validate`, `cli`) | profile records and their lifecycle | D |
| `scripts/daemon/sessions/profiles.mjs`, `profile-owner.mjs` (new) | `forLaunch`, binding check, identity lock; the person's operations for the owner routes | D |
| `scripts/native/` (new: `graphics`, `backend`, `probe`, `validate`, `properties`) | backend plan, `SystemInfo` read, probe launch, validation | E |
| pn patches `960-no-canvas-bridge`, `961-webgpu-real`, `962-proxy-auth-file` | engine work | C, E |

New helper-part import edges in `test/structure.test.mjs` `ALLOWED`: `context -> browser/supervise`
(step 4), `browser/supervise -> where` (step 8, with `markServer`; the structure test refuses an
allowed edge no import uses), `context -> sessions/profiles`. Everything else passes through deps.

### 3.2 One launch path

Every launch, recovery and relaunch goes through `launch()` in `scripts/daemon/browser/launch.mjs`,
in this fixed order:

1. `api.ensureScreen()` (A).
2. `deps.profiles.forLaunch(session)`: profile, binding check, identity lock, version check (D).
3. `deps.network.forLaunch(session, { profileNetwork })`: proxy, strict switches, auth file (C).
4. Graphics plan and static compatibility errors, with the stored measurement or a probe launch (E).
5. `launchEngine` with the server-mode sandbox rule (A).
6. `deps.network.checkAtLaunch(ctx, session, launch)` (`launch`: step 3's result); failure closes the browser (C).
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
  is skipped. A recorded Xvfb still alive 1 s after SIGKILL is not counted as ended and its record is
  kept, so a later start tries again.
- **A7. Race-free start**: accept a display only if the child still runs and `/tmp/.X<n>-lock` holds the
  child's pid; else kill it and try the next number. `-displayfd` not adopted until measured in the
  container.
- **A8. Shutdown always ends the screen**: async `stop()` (SIGTERM, 1 s, SIGKILL, up to 1 s more,
  remove cookie; remove the record only once Xvfb has exited, since a SIGKILLed Xvfb leaves its lock
  and socket and the record is what lets the next start's `reapOwn` clear them); sync `stopNow()` from the existing `process.on("exit")` (`daemon.mjs:317`, through
  `context.stopScreenNow()`). `stopNow()` sends SIGTERM and removes the cookie; it removes the record
  only when Xvfb has already exited, since it can't wait, so an Xvfb that outlives the helper is still
  ended by the next start's `reapOwn` (step 3).
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
  stopNow }`, `reapOwn(name, deps)` with injectable `/proc`, stat, kill, called by `startVirtualDisplay` itself
  before it tries a display (also checks `/proc/<pid>` is owned by our uid), `recordPath(name)`, `isOwnXvfb`.
- `scripts/daemon/browser/supervise.mjs` `createSupervisor(st, deps)` (step 4; `api` joins in step 8
  for `relaunchSoon`): `ensureScreen()`,
  `stopScreen()`, `stopScreenNow()`, `noteUnexpectedClose(launchedAt)`, `crashLoop()`,
  `relaunchSoon()`, `statusParts()`. Wiring: `launch.mjs:179` calls `api.ensureScreen()` and keeps its result for the launch's
  `DISPLAY` (a screen lost while the browser starts closes it and fails the launch), `:331` calls
  `api.stopScreen()`, the close handler calls `noteUnexpectedClose` and, with keep-alive,
  `relaunchSoon`. State fields `screenStopping`, `unexpectedCloses` in `browser/state.mjs`.
- `scripts/browser.mjs` `launchArgs(config, { screen })`: A2 (step 5). `launchOptions` passes `screen`
  on; the helper's launch and the install self-check (`native/check.mjs`) give the screen they started.
  A user's `--window-size` or `--window-position` follows ours and wins, since the engine takes a
  switch's last value.
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
  same-origin dynamic import only for role turn, so `liveview.js` stays under 800 lines; role redeem
  gets its own landing page, step 19):
  - A visible "Type here" box (`<input autocomplete="off" autocapitalize="off" spellcheck="false"
    enterkeyhint="done">`) opens the on-screen keyboard. Its `beforeinput` maps `insertText` to one
    `char` event per character (a `text` event above 32 characters), `deleteContentBackward` to
    Backspace, `insertLineBreak` to Enter; composition is sent once at `compositionend`. The box is
    emptied after each event and never holds a value.
  - New input kind `{ type: "char", text, modifiers: 0 | 8 }` replayed as `Input.dispatchKeyEvent`
    keyDown with `text` plus keyUp, so one-time-code boxes that advance on `keydown` and Space on a
    focused checkbox work. Only Shift or no modifier, so no Ctrl or Meta letter is ever replayed.
    As built (step 18): `charOf` in `scripts/liveview/input.mjs` takes exactly one printable code
    point (no C0 or C1 control character, no lone surrogate; Enter, Tab and Backspace stay named keys)
    with modifiers exactly 0 or 8, and drops the whole event otherwise (Alt too), in `readViewerInput`
    and again in `replay`. The key code is the letter's or digit's own, Space 32, punctuation's OEM
    code (`PUNCT_CODES`, now shared with `screenshare.mjs`), else 0, never Insert (45) or Delete (46).
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
    available on Linux. The key file counts on Linux (decision U3). Otherwise the launch
    keeps payment autofill off and status says "saved card refused: this browser has no key store for
    it". The open build is always refused.
  - Saving the card: the person adds it once in the engine's own payment settings page, opened by an
    owner-only action ("Add a saved card") in the owner's live view; agents can never open the
    browser's own pages (existing rule). Grant viewers cannot reach it.
  - Filling: only the person, during a hand-off. The engine's autofill list is browser UI and may not
    appear in screencast frames (measured by T-B18); the turn viewer therefore offers "Fill saved card"
    when a card-number field is focused in a scope tab of a saved-card profile, which sends ArrowDown
    then Enter as the person's own input. CVC and 3-D Secure stay with the person. (As built, step
    45: the button shows for the whole hand-off of a saved-card session and the helper checks the
    focused field at the tap; Enter is sent only from an empty card number field, autocomplete
    `cc-number` or a card or payment frame's first field when the frame has none, since the list
    doesn't open on a field holding text and the helper can't see it.)
  - Agents never trigger or read it: in a saved-card session, all agent results are masked as in B10
    for every tab (not only during a grant), pictures are covered, agent typing and key presses into a
    card field (cc-* autocomplete, a valid card number, any field in a payment frame) are refused (as
    built: key presses into any cc-* field, the name on the card too, and list keys (arrows, Page
    Up/Down, Enter) into any text field of a form whose fields name a card by name or label without
    a token; a card field named only by nearby text isn't detected; typing keeps B13's rule), and
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
  genuine verification is always handed over, never retried or bypassed. (Step 43: the lists go
  with hand-offs that go to the channels, in the status result for an agent's "you" and in a host
  note for PairBrowse's own check and a fast-mode run's hand-off step; a desktop without Away stays
  as today, decision 8.)
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
  request-refused, ended`. `tab` is origin and path only; `detail` from a fixed vocabulary; unknown fields refused.
- **B18. Desktop unchanged** with `handoff.enabled` false, apart from the card-field rule of B13. The `char` key and one-in-flight posting stay
  turn-only in this phase.

### Design
Config (`scripts/config-schema.mjs`, `DEFAULT_CONFIG`, `docs/configuration.md`; not in Settings):

```json
"handoff": {
  "enabled": false,
  "away": false,
  "publicLink": false,
  "grantMinutes": 15,
  "remindMinutes": 10,
  "channels": [
    { "type": "webhook", "urlSecret": "PAIRBROWSE_WEBHOOK_URL" },
    { "type": "ntfy", "server": "https://ntfy.sh", "topicSecret": "PAIRBROWSE_NTFY_TOPIC", "tokenSecret": "PAIRBROWSE_NTFY_TOKEN", "link": "auto" },
    { "type": "telegram", "tokenSecret": "PAIRBROWSE_TELEGRAM_TOKEN", "chatSecret": "PAIRBROWSE_TELEGRAM_CHAT", "server": "https://api.telegram.org" },
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
- `scripts/daemon/grants.mjs` `createGrants({ now, mono, audit, log, timers })`: `mint`, `redeem`, `matchView`,
  `matchRedeem`, `redeemKey`, `openStream`, `inScope`, `forPage`, `addToScope`, `closed`, `end`, `endWhere`,
  `hold`, `held`, `release`, `open()` (no keys), `onEnd`, `ended(page)`, `sweep()`. Ids 8 hex, keys 64 hex, wall and monotonic expiry as
  `invites.mjs`. Memory only for keys.
- `scripts/liveview/grants.mjs`: redeem handler, stream gate, guest filters `forTurn(event, data,
  grant)`. Dispatcher (`scripts/liveview.mjs:567-599`) matches owner key, pages key, invites, then
  grants; grant keys never match on the join-code port; the Origin rule admits roles turn and redeem
  from `inviteOrigin`. A turn stream joins `linkGuests` with `{ role: "turn", grant }` (the approval
  card rule, `scripts/daemon/approvals.mjs:11-12`, applies) but skips covers for scope frames (B8).
- `scripts/liveview/routes/turn.mjs`: `POST redeem` (role redeem), `POST turn-done`, `POST turn { show }`,
  `POST turn-revoke` (owner, from the Tools tab); `POST turn-fill-card` (B12) joins it in step 45.
- `scripts/liveview/input.mjs`: `char` in `readViewerInput` and `replay`.
- `ui/events.js`: `turn` (`{ id, action, host, expiresAt, scope, state }`) and `turn-ended` (`{ reason }`),
  to the grant's stream only.
- `scripts/daemon/yourturn.mjs` `createYourTurn({ config, grants, notifier, notifyLocal, journal,
  saveTabs, hostNote, audit, hud, context, presence, coherence, linkFor, log, timers })`:
  `onStatus`, `onChallenge`, `onChallengeCleared`, `recover()`, `handedOff(page)`, `masked(page)`,
  `report()`. (As built in step 21, with its deps named there: `onStatus` answers the result's
  line, so there is no `report()`; `recover()` comes with step 22.) It takes over the `onStatus`, `onYourTurn` and `onCleared` lambdas now in
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
spent hash); second stream (409 "This hand-off is open somewhere else.", plus its next step); out-of-scope input (409
"That tab isn't on screen.", plus its next step).

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
| Interaction | `test/input.test.mjs` (fake CDP, where the replayer's tests live): "char replays keyDown with text and keyUp; Ctrl or Meta dropped". `test/fuzz/joiner-input.test.js`: "char never carries more than one character or a modifier other than Shift". `test/liveview-mobile.test.mjs` (viewer page, as built in step 20): "tap posts mouse press and release; drag posts wheel; a hold stays pressed; zoom keeps a click on the same page point"; "the type box ... Backspace, Enter and a composition map, and the box stays empty"; "one POST in flight with presses in order"; "a batch sent again with the same run and number is answered and not replayed" |
| Mobile hand-off | `test/liveview-mobile.test.mjs` (new, viewer page in the runtime's browser with `isMobile`, `hasTouch`, 390x844): "landing page and Take over fit the screen with no horizontal scroll"; "the type box opens the keyboard path and a six-digit code reaches the page"; "setOffline for 20 s then back: the stream reconnects with the same view key and input resumes, nothing typed is lost or repeated" |
| Real-page interaction | `test/integration/your-turn.test.mjs`: "through a real view key: a cross-origin iframe checkbox gets click; a six-box one-time-code widget fills on keydown; Space ticks; Tab moves focus; a 2 s hold is seen as 2 s; a touch tap clicks". Measurement (reports, does not fail): "an open select list and the autofill list in screencast frames; dispatchTouchEvent alone yields click" (T-B18) |
| Notification delivery | `test/notify-channels.test.mjs`: "each of webhook, ntfy, telegram, discord, slack sends its request shape to a loopback stub, https only, no redirect, bounded, one retry on 5xx, none on 4xx"; "a third-party sender added to the table is called through the same interface"; "no message holds the agent's text, a password, a code, a card number or page text; the action kind sentence matches the step". `test/optin/ntfy.test.mjs` (`PAIRBROWSE_TEST_NTFY=1`): real publish and read back |
| Session continuity | `test/yourturn.test.mjs`: "a browser restart with keepAlive mints one replacement grant with the same deadline"; "a helper restart reissues once from turn.json before the deadline, never after". `test/integration/your-turn.test.mjs`: "after the hand-off the session's cookies and tab are those the person left; the agent continues without a new sign-in" |
| Safe payment confirmation | `test/yourturn.test.mjs`: "a payment hand-off masks every agent result from scope tabs and covers pictures; the person's typed card number is in no host note, activity line, journal, audit line or message". `test/refusals.test.mjs`: "agents' hands, run, navigate and close are refused in a handed-off or held tab; snapshots and dialogs are not"; "in any session, an agent's type, fill, key text or fast-mode step into a cc-* field, a payment-frame field, or with a valid card number as the value is refused with the hand-over sentence; a secret holding a card number is never typed". `test/shared-rules.test.mjs`: "after a payment hand-off ends, an agent's click on the site's Pay button still needs the Pay: name and asks". `test/liveview-grants.test.mjs`: "while a grant is open, another joiner's frames of a scope tab keep card covers and its agent's results stay masked" |
| Saved card | `test/browser.test.mjs` (profile prep): "payment autofill stays off by default and turns on only for a savedCard profile with a real key store; the open build and a fixed key refuse it with a status line". `test/refusals.test.mjs`: "in a saved-card session agents cannot type or press keys in a card field, and results are masked in every tab". `test/yourturn.test.mjs`: "Fill saved card is sent only from a turn viewer's tap; no agent tool reaches it; saved card data stays out of logs and notifications" |
| Agent resumption | `test/yourturn.test.mjs`: "Done ends with done, one host note, refusals lift"; "a detected challenge ends with cleared; an agent status ends with agent". `test/wait-for.test.mjs` (new): "browser_wait_for time 120 returns within 300 ms of the grant ending". `test/integration/your-turn.test.mjs`: "full path with a loopback webhook: status, link, GET, Take over, click and typed code land, agent click refused, Done, waiting agent returns, next click works; fast-mode handoff step finishes on Done" |
| Timeout recovery | `test/yourturn.test.mjs`: "exactly one reminder; at expiry flush, save tabs, yourTurn line, keys stop, one ended message, one host note, tab held"; "a held tab is released by a new you, the owner's input or a session end". `test/integration/your-turn.test.mjs`: "user offline past expiry: the held tab keeps its address and typed form values, no agent action reaches it, and a new you mints a grant to that same tab". `test/integration/your-turn.test.mjs` (`TURN_MS`): "one reminder, then the stop; a restarted helper reopens the same tabs" |
| Compatibility vs verification | `test/compat-vs-verification.test.mjs` (new): "a CAPTCHA with a time zone vs egress mismatch reports the mismatch under PairBrowse setup problems and the CAPTCHA under site verification, mints one grant for the CAPTCHA and never retries"; "a compatibility problem alone mints no grant and sends no your-turn message" |
| Audit, secrets, config | `test/audit.test.mjs`: "append-only, 0600: each event one line with exactly t, kind, grant, session, tab, detail"; "rotation at 1 MB: the full file moves to .1 (one older generation) and a new one starts"; "unknown fields refused, and every value outside its rule: no key, link, secret or page text gets in"; "a pipe at the file's name with no reader is refused at once, never waited on". `test/redaction.test.mjs`: "reserved secrets hidden from pairbrowse_facts, never typed, still masked". `test/config-schema.test.mjs`: "handoff types, defaults and remindMinutes fallback". `test/liveview-mobile.test.mjs`: "liveview-turn.js is in ASSETS and loaded by liveview.js for role turn alone" |

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
  tool sets a proxy or credential. Session rename and delete update the map (step 32: the entry
  follows a rename, an entry under the new name goes, a deletion removes it, and a `config.json`
  that can't be parsed stops both).
- **C14. People fill proxies in themselves (user, 2026-10-20).** Not only config and CLI: Settings
  (`ui/settings/`, the browser's own page, and the live view's owner page on a phone) gets a
  "Network" section. A person adds, edits, tests and removes a proxy (name, type HTTP / HTTPS /
  SOCKS5, host, port, optional username and password), picks the default, and picks one per session
  (or "direct"). Saving goes through an owner-only route (`scripts/liveview/routes/owner.mjs`, the
  owner key, same-origin and CSRF checks as the other owner writes) into `config.json` `network` and
  the credentials into `secrets.env` (C3). The password field is write-only: the page shows "saved"
  or "not set", never the value, and no event, log or result carries it. "Test" runs the C6 probe and
  shows the measured exit address, country and the leak verdict, and any coherence warning (C13)
  such as a time zone that doesn't match the exit country. A SOCKS5 entry with a username is refused
  with the U4 sentence. No agent tool and no joiner can open or write this section (owner only).
  As built (step 32b): the username is write-only too (both are "saved" or "not set"); Test runs the
  helper's probe only (through the proxy, and this computer's own exit without `expectEgress`), since
  the browser-side read, WebRTC and names need a browser on that proxy and run at a session's start;
  the live view's owner page has the section in its Profile drawer (the owner key works only under a
  loopback name, so a phone reaches it through an SSH tunnel); a proxy still named by `default` or a
  session can't be removed. `secrets.env` is read from disk for each summary, change and Test (an
  entry added by hand counts at once), and each credential change applies to the file as it is then,
  so nothing added by hand meanwhile is lost; when the file can't be used (a link, another user's,
  readable by others) the section says why, and a change that needs a username and password is
  refused with that reason.
- **C5. Strict mode by default** for proxied sessions: `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE
  <proxy host>, EXCLUDE localhost` and `--webrtc-ip-handling-policy=disable_non_proxied_udp` on both
  builds, and on the open build also `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` (its
  browser ignores the first spelling; the native engine reads only the first and drops the second);
  a user's `--host-resolver-rules` is dropped and logged. Loopback always passed as
  `proxy.bypass` (`localhost,127.0.0.1,[::1]`) so the driver does not route the helper's own
  `127.0.0.1` traffic to the proxy. A non-loopback bypass is refused in strict mode. No profile
  preference is written for networking.
- **C6. Checks before any saved tab loads.** (1) A helper-side probe through the proxy (stdlib `net`,
  `tls`; CONNECT or SOCKS5 with the name as a domain) to `network.checkUrl`, started with `forLaunch` and
  running while the browser starts (step 29); (2) a
  browser-side probe of the same URL with CDP `Network.loadNetworkResource` in an internal
  `about:blank` tab; (3) a WebRTC gather in that tab against `stun:stun.cloudflare.com:3478`. Default
  `checkUrl` `https://cloudflare.com/cdn-cgi/trace` (answers `ip=` and `loc=`). Direct sessions run no
  check.
- **C7. Fail closed** on: proxy unreachable; browser egress differing from the helper-through-proxy
  egress or outside `expectEgress`; egress equal to the direct one when `expectEgress` is unset; in strict mode, a WebRTC
  candidate other than mDNS or the proxy egress (step 29: recorded, not judged, without strict); strict switches not applicable; a check that times
  out. The browser closes, tools are refused with the reason, the person is notified (Phase B channels
  when configured). The same check runs after every recovery (section 3.2). The proxy list has no
  `DIRECT` fallback.
- **C8. Egress change**: recheck every `recheckMinutes` (10); a change or a failed recheck does
  `onEgressChange`: `"pause"` (default, pauses agents through `scripts/daemon/pause.mjs`, a person
  resumes; a host's pause state mirrored into a session joined from here never lifts it), `"notify"`, or `"ignore"` (rotating proxies with a country expectation: an address change
  passes, a failed recheck still pauses, step 31). Once per change.
- **C9. Observations apart.** Each check appends to `sessionFile(name, "network.json")` (0600, last 50;
  memory only for clean sessions). The direct IP is never stored (only `sameAsDirect`). With geoip,
  `savePersona` strips `GEOIP_FIELDS` (`native-engine.mjs:22`), so derived values are recomputed each
  launch; the pack is called with `quiet` true and the proxy, so its lookups never go direct. Pro-repo
  item: `applyGeoip` takes the IP C6 measured and reads only the pinned database (Phase E E11).
- **C10. A saved engine persona with `proxy` refuses the launch** with a sentence pointing to
  `network.proxies` (dropping it would turn a proxied session into a direct one).
- **C11. Strict sessions share by pictures only**: `screens.available()` (`scripts/daemon/screenshare.mjs`)
  returns false so joiners get frames, and a strict session asks for frames when it joins (step 32).
- **C12. Leak tests read what the engine did.** Test switch `NETLOG` adds `--log-net-log=<test home>/netlog.json`
  in a harness-started helper only; the test fails on any host resolution other than the proxy host
  and loopback (and strict mode's own `~notfound`, which the resolver is asked for in place of a
  mapped name: step 30). Docker opt-in adds a stub DNS server and a STUN responder on the direct network.
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
`launchPart(net, { shell, secrets })` returning `{ proxy: { server, bypass }, args, authFile, drop }` or `{ problem }`, and `applyLaunchPart`, with step 27; also `parseServer`, `readNetwork`);
`scripts/net/credentials.mjs` (`proxySecretNames`, `credentialsFor`, CLI `set`, `remove`, `list`);
`scripts/net/probe.mjs` (`probeEgress`, bounded steps, errors name host:port and step, never the
credential); `scripts/net/verdict.mjs` (`inExpected`, `egressVerdict`, `webrtcVerdict`, reusing
`parseV4`/`parseV6` from `scripts/rules/network.mjs`); `scripts/net/browsercheck.mjs`
(`checkInBrowser`, every await bounded with `within`). Helper part `scripts/daemon/network.mjs`
`createNetwork(deps)`: `forLaunch` (its result's `started()` records the network once the browser is up, so `strict()` never describes a refused or failed launch), `checkAtLaunch`, `start`, `stop`, `refusal()`, `statusParts()`,
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
file stops holding geoip fields at the next geoip launch (the existing GeoIP test in
`test/native-engine.test.mjs` keeps its expectation; new tests pin the persona file, step 26).

### Acceptance tests
- `test/liveview-network-routes.test.mjs` (C14): only the owner key writes; a joiner, an agent tool
  and a cross-origin request are refused; the password goes to `secrets.env` and never back out in a
  response, event or log; SOCKS5 with a username refused; per-session choice lands in `network.sessions`.
- `test/ui-settings.test.mjs` (C14): the Network section renders, the password field is write-only,
  "Test" shows exit address, country, leak verdict and a coherence warning.
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
`test/net-probe.test.mjs` ("CONNECT with Basic and SOCKS5 read ip and loc; SOCKS5 sends address type 3"
(no RFC 1929: U4); "https: proxy works and an untrusted certificate is refused"; "hung or
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
  major refuses a store profile ("re-validate or migrate"); the config-backed `default` is re-pinned
  by that launch (step 38); another build of the same major launches `unverified`.
  `validation[build] = { status: "validated" | "unverified" | "failed", at, pack, runtimeKey?, graphics?,
  items: [...] }` with one item shape shared with Phase E: `{ field, rule, class, status, requested,
  measured, severity, reason }`, `class` from the property matrix (section 9), `status` one of
  `applied, not-applied, derived, unsupported, matched, mismatch, unverified`. `requireValidatedProfiles`
  (default false) refuses `unverified` and error-severity coherence items (step 43: a profile's
  through its stored entry; `locale.timezone-vs-egress` through the network check at launch).
- **D11. Explicit fields fail closed; imported data is reported.** A set field the chosen browser cannot
  apply refuses the launch (for example `locale.timezone` on the open build). Data inside an imported
  file that is not applied is listed per field as `unsupported` or `not-applied` and never refuses.
  The open build applies switch-based fields only (`--lang`, `--window-size`, `--force-dark-mode`,
  `--force-prefers-reduced-motion`, `--disable-gpu`; step 36: a profile's `screen` is whole, so the
  open build refuses a set screen and `--force-device-scale-factor` stays a `browserArgs` switch).
- **D12. Derived values are recorded, never stored as configuration**: geoip, host `Intl`, build
  `platform` and `brandVersion` (`native-engine.mjs:247-248`, fixes F4: step 11's pinning test confirms a persisted
  `brandVersion` outlives a build update and a copied persona keeps its system's `platform`).
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
  (`scripts/rules/coherence.mjs` `screen.believable`, warnings only); provenance and license present.
  A PairBrowse export's SHA-256 is checked before its version (step 35).
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
`toLaunch(profile, { browserKind, platform })` returning `{ switches, engineKeys, prefs, geoip,
network, adBlocker, results, problem }`; the build is the caller's, which files the results under it); `migrate.mjs`; `cli.mjs` (`list`, `show`, `create`, `edit`, `retire`, `restore`, `assign`,
`import [--dry-run] [--source] [--license]`, `export [--with-history] [--include-identity]`, `validate`,
`migrate [--undo]`). Helper part `scripts/daemon/sessions/profiles.mjs` `createProfiles(st, deps)`:
`forLaunch(session)`, `release()`, `statusParts()`, `list()`.

Changes: `scripts/paths.mjs` (`browserProfiles`, `engineProfiles`, `identityLocks`,
`requireValidatedProfiles: false`); `scripts/config-schema.mjs` (`requireValidatedProfiles`, closed
`profileSelect`); `scripts/sessions.mjs` (`assignmentFile`, `readAssignment`, `assignProfile`, rename and
delete lists, `createSession(name, profileId)`, `profileId` left out for no choice); `scripts/native-engine.mjs` (mapped profile
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
| Concurrent use | `test/profile-lock.test.mjs`: "a pinned seed is exclusive across instances; a dead holder is taken over"; "an unpinned profile runs in two sessions with different seeds". `test/integration/profiles-instances.test.mjs`: "two instances on separate profiles share nothing; one session can't open in two browsers" (the same pinned seed refused in the second: `test/optin/profiles-native.test.mjs`, native only) |
| Binding and versions | `test/session-profiles.test.mjs`: "binding mismatch refuses, never re-stamps"; "other major refuses, other build unverified, requireValidatedProfiles refuses"; "unknown or retired profile refused by name". `test/native-engine.test.mjs`: "saved and persisted layers pass only engine keys"; "persona saved under the profile id"; "in-major update keeps no old brandVersion"; "auto never calls resolveAuto"; "profile languages reach --accept-lang". `test/daemon-connect.test.mjs`: "helperEnv drops inherited PAIRBROWSE_ENGINE_*" |
| Agents and routes | `test/context-switch.test.mjs`: "session new with profile assigns it; action profiles only lists". `test/session-route.test.mjs`: "profile routes owner-only; invite keys and join-code port 403; upload over 1 MiB refused" |
| Applied values | `test/optin/profiles-native.test.mjs` (`PAIRBROWSE_TEST_EXECUTABLE`): "a profile's time zone, languages, screen and DPR are what pages read; a pinned seed reproduces the same values in two fresh sessions and is refused in a second instance" |

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
    llvmpipe under Xvfb where the host has it; which one runs is measured and named, never assumed.
    Fixed by spike E-S1 (step 39): with no switch, Linux under Xvfb already renders in software
    (ANGLE on desktop GL over Mesa's llvmpipe, `glImplementationParts` `gl=egl-angle,angle=opengl`),
    so `auto` there is software and is measured as such; `software` adds `--use-angle=swiftshader`,
    the engine's own software path (ANGLE on SwiftShader Vulkan), which works without
    `--enable-unsafe-swiftshader` (that switch only allows the automatic fallback), so the pack's
    `DEFAULT_IGNORED_ARGS` stay as they are and nothing new goes into `browserArgs`' allowlist.
    `--use-angle=vulkan` over Mesa's lavapipe is rejected: SystemInfo answers, but the page never
    answers again (every probe part timed out). macOS stays refused: SwiftShader does render there
    (`--use-angle=swiftshader --enable-unsafe-swiftshader`), but the host-capture persona keeps
    reporting the Metal GPU over it and WebGPU has no adapter, so the result would claim hardware.
  - `gpu` requires a hardware backend; measured software refuses the launch and closes the window.
  - `gpu` with `--disable-gpu` or `--use-angle=swiftshader` in `browserArgs` is a config refusal.
- **E3. Backend read from the browser process**: `SystemInfo.getInfo` on a browser-level CDP session over
  the driver's pipe (no TCP port; `scripts/native/check.mjs:113` already reaches `ctx.browser()`).
  Unanswered within its bound: `unverified`, never assumed.
- **E4. Page probes never open a tab in the person's browser**: a throwaway launch with the profile's
  resolved options and a temporary user-data folder (as `captureMacHost` does): headless on macOS (the
  capture's Metal path), headed on Linux on the screen the launch already uses (the private Xvfb on a
  server, the person's desktop otherwise, as the install self-check's own browser). Triggers: the install self-check,
  `cli.mjs validate`, and the first launch per runtime key (logged "measuring graphics once for this
  browser version"). The live browser gets only the E3 read and a comparison with the stored
  measurement.
- **E5. Value classes**: requested (profile or config), measured (E3 and probes), derived (build or
  seed: UA major, cores, memory, heap limit, media capabilities), unverified (no measurement).
- **E6. `validated` only with measured evidence** for the build, pack SHA-256 and runtime key; a
  missing measurement is `unverified`; a switch without a matching page result counts as failed.
  The `sandbox.on` rule (step 39): on macOS it reads `SANDBOX.on` only (the build has no sandbox
  status page). On Linux it also reads the engine's sandbox status page in the probe launch: the
  namespace layer (user, PID and network namespaces) is required, and seccomp-BPF too wherever the
  kernel is not emulated (an x64 build on an x64 host); a page that is not shown or times out makes
  the rule `unverified`, and a page showing a required layer missing makes it failed.
  `SystemInfo` `auxAttributes.sandboxed` (the GPU process) is not counted yet: it was false on
  every Linux path measured under emulation, so it is rechecked on an x64 host first.
- **E7. Linux screen follows the display**: on Xvfb the helper passes `virtualScreen` as `screenWidth`,
  `screenHeight`, `availWidth`, `availHeight`, `colorDepth` and `devicePixelRatio` (1, or the
  launch's `--force-device-scale-factor`; step 41) when the profile's `screen` is unset; a
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
  on a software backend), `screen.display` (kept a validator rule, step 43: it needs the launch's
  virtual screen), `screen.believable` (window within screen, avail within screen, DPR in a common
  set: 0.25 steps), `locale.timezone-vs-egress` (error), `locale.language-vs-egress`
  (warning). The time-zone-to-country table is generated from the IANA tz database's `zone.tab`
  and, where the system has it, `zone1970.tab` (public domain; macOS ships only `zone.tab`), each
  zone also under the name Intl reports for it (`Asia/Saigon`), into `scripts/rules/tzcountry.mjs`
  by `scripts/dev/tzcountry.mjs` (landed with step 32b).
- **E14. Engine audit** (pn `native/ENGINE-AUDIT.md`, private): every switch in `000`, every data table,
  its page surface, property class and recorded provenance.

### Design
| Path | Content |
|---|---|
| `scripts/native/graphics.mjs` (new, pure) | `GRAPHICS_BACKENDS`, `normalizeWebgpu`, `graphicsPlan({ requested, platform, browserKind, measured, userArgs })` returning `{ switches, engineKeys, refusals }`, `compatErrors(...)`, `runtimeKey(info)`, `GRAPHICS` state (like `SANDBOX`) |
| `scripts/native/backend.mjs` (new) | `readBackend(ctx, { ms })` returning `{ kind: "hardware" \| "software" \| "unverified", vendor, device, renderer, driver, source: "systeminfo" }`; pure `parseSystemInfo` |
| `scripts/native/probe.mjs` (new) | probe page and `runProbe(page)`; `probeLaunch(...)` sharing bounded steps with `captureMacHost` |
| `scripts/native/validate.mjs` (new, pure) | `validate({ requested, derived, measured, live })` returning Phase D's `validation[build]` with items; `RULES`; `measuredRecord` (the stored shape); `entryStatus(entry, { pack, runtimeKey })` |
| `scripts/native/properties.mjs` (new, pure) | the section 9 matrix as data: field, class per runtime, switch or key, rule; `classOf`, `runtimeOf` |
| `scripts/native-engine.mjs` | E1 guard, `normalizeWebgpu` on every layer, `graphicsPlan` merged, E7 screen, `graphics` read so it is not logged unknown |
| `scripts/config-schema.mjs` | `pairbrowse.graphics: { values: GRAPHICS_BACKENDS }` |
| `scripts/daemon/browser/launch.mjs`, `scripts/daemon/browser/graphics.mjs` (new, step 44) | steps 4 and 7 of section 3.2 |
| `scripts/daemon/serve/tools/status.mjs` | part `Graphics: <kind> (<renderer>), requested <backend>, <status> on <build>` |
| `scripts/daemon/diagnostics.mjs` | reports carry backend kind and status only, never GPU model or IDs |
| `scripts/native/check.mjs` | step "graphics: <kind>, WebGL <1/2>, WebGPU <adapter or unavailable>"; `probeLauncher`, `measureGraphics` (step 44) |
| `scripts/paths.mjs` | `fontCache` |

Probe measures: browser process (GPU devices, vendor and device IDs, driver, GL/ANGLE renderer, feature
status for rasterization, WebGL, WebGL2, WebGPU, Vulkan, decode and encode profiles; field set fixed
by E-S1 fixtures); page (on `127.0.0.1` and `localhost`): WebGL and WebGL2 availability, vendor,
renderer, unmasked strings, extensions, limits, precision, a fixed scene's `readPixels` hash; WebGPU
`navigator.gpu`, adapter info, features, limits, `requestDevice` with the reported limits, one compute
round trip; canvas 2D and text scenes hashed twice in one page, on two origins and across two launches;
`document.fonts.check` over the persona list and a control list; `screen`, DPR, window sizes; codec and
`mediaCapabilities` answers; time zone and languages. (Step 42 measures what the record keeps: of the
browser process the E3 read (`readBackend`); of WebGL the version, unmasked strings, extension count,
texture and renderbuffer limits and the scene's hash, compared across the two origins, no precision
formats; fonts by a text-width test against the three generic families, not `document.fonts.check`,
with the control list proving the test; no window sizes.)

Measured record in `validation[build].graphics`: `{ at, runtimeKey, pack, runtime: { platform, arch,
display, emulated, sandbox: { on, page } }, backend, webgl, webgl2, webgpu, canvas: { stable, repeat, noise },
fonts: { checked, missing, controlFound }, media, screen, locale, navigator }` (step 40: every key
present, a part not measured null; `screen`, `locale` and `navigator` added for `screen.display`,
`locale` and `ua.build`, `runtime.emulated` for `sandbox.on`'s seccomp-BPF rule).
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
`test/fixtures/systeminfo-*.json`, `probe-*.json`. Findings in step 39's "Landed as".

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
| Backend selection | `test/native-graphics.test.mjs`: "auto, software, gpu accepted, others refused"; "gpu with --disable-gpu refused"; "Linux plan sets disableGpuFingerprint and noise off"; "gpu requested, software measured: error" (the closed context: step 44); "software on macOS refused"; "require unmet errors"; "screen vs virtualScreen"; "runtimeKey changes with driver, display kind, pack"; "parseSystemInfo: Metal hardware, Xvfb software, garbage unverified" |
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
| Graphics requirements | profile `graphics.require` | checked against the measurement, never applied | M | M | M | `native-validate` rules `require.webgl`, `require.webgpu`, `require.platforms` | none |
| WebGL/WebGL2 vendor, renderer | host | capture (macOS), `disableGpuFingerprint` (Linux) | M | M | M | probe rule `webgl.strings-vs-backend` | none |
| WebGL limits, extensions, precision | host | same | M | M | M | `webgl.limits-vs-backend` | none |
| WebGL and canvas pixels | host GPU or software raster | none | M | M | M | `canvas.stable`, `canvas.repeat` | none |
| Canvas noise | build default | `fingerprintNoise` | C (on) | U (off on real pixels) | U (off on real pixels) | `native-graphics` "Linux plan sets noise off" | none |
| Canvas bridge | none (E1) | removed | U | U | U | rule `bridge.absent` | 960 |
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
| Saved card | session storage | autofill pref | C (with a key store) | C (U3 accepted the key file) | same | `browser.test.mjs` saved-card case | none |
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
4. `daemon/browser/supervise.mjs` (`ensureScreen`, `stopScreen`, `stopScreenNow`), `startVirtualDisplay`'s
   `onExit` (cookie removed, record kept for the next reap), launch and exit wiring, `ALLOWED` edge
   `context -> browser/supervise` (A4). -> 3
5. Window follows the screen (A2). -> 1
6. Crash-loop guard, `statusLine` `more` list, `statusParts` (A5). -> 4
   Landed as: `noteUnexpectedClose` from the close handler unless a switch, a shutdown or the
   helper's own reset caused it (`reset()`, which sets `st.resetting`: `serve.mjs`'s turn cap and
   its stalled disconnected participant, 30 s, often within a minute of a launch),
   `crashLoop()` read by `getContext()` and by `pairbrowse_status` (which then skips the launch and
   returns the line with the crash part); `statusParts()` names the virtual screen and a crash loop
   (the keep-alive part comes with step 8). The `ended` message is the supervisor's `onCrashLoop`
   dep, called once per hold; it stays a no-op until the Phase B notifier (step 21) passes one in.
   The `CRASH_WINDOW_MS` switch is left for the integration test that needs it (step 46): the unit
   tests inject the clock.
7. Sandbox in server mode and `"required"`; row A-2 (A10). -> 1
   Landed as: `browser-args.mjs` `sandboxRequired(config, { server })` gives the reason ("in server
   mode" or `with "browserSandbox": "required"`), named in each refusal; `sandboxDecision` adds
   `blocked` (root) and `required`; `launchEngine(..., { server, uid })` throws on `blocked` before the
   engine pack loads and, when required, on a sandbox failure (the engine's error as its `cause`).
   The launch reads server mode from the supervisor (`api.isServer()`, no new import edge); the
   install self-check (`native/check.mjs`) passes `serverMode(config, env)` too. The errors point to
   `docs/configuration.md` until `docs/server.md` exists (step 50).
8. `server.keepAlive`, `readUse`, relaunch backoff, `markServer` (A9, A11). -> 6
   Landed as: `createSupervisor(st, deps, api)` gains `keepAlive()`, `keepAliveStart()` (called by
   `daemon.mjs` once the runtime has loaded: the browser starts and restores at once) and
   `relaunchSoon(launchedAt)`, which the close handler calls only when `noteUnexpectedClose` says
   launches go on. Pauses 2, 10, 30 s (`RELAUNCH_MS`), one planned start at a time (`st.relaunchAt`,
   timer unref'd), counted in `st.relaunches` and started over once a browser stayed up past 60 s;
   the planned start is skipped while the helper stops, a switch runs, a browser runs or the guard
   holds, and a failed start is logged, not retried (the next action tries). `onClosed` ends the
   helper only without keep-alive. `readUse` reads `context.keepAlive()` as `kept`, and
   `busyReason` names it after every passing reason. `statusParts()` adds "keep-alive on" or the
   seconds to the planned start. Every close PairBrowse didn't cause brings the browser back,
   closing it by hand too (the close handler can't tell a hand close from a crash), and each counts
   toward the crash-loop limit; only stopping the helper keeps it closed. A newer version waiting
   on a keep-alive helper: `pendingLine(version, { kept })` and the handoff log say to restart the
   service. `where.mjs` `markServer()`, called by the supervisor when it is
   made in server mode (edge `browser/supervise -> where`). The `RELAUNCH_MS` test switch is left
   for the integration test that needs it (step 46), like `CRASH_WINDOW_MS`: unit tests inject the
   clock and timer. `docs/server.md` and its systemd unit come with step 50.
9. Canvas bridge launch guard (pb) and `--headless` harness-only; rows E-1, E-5 (E1 pb part, E12).
   (independent)
10. `normalizeWebgpu` on every layer (E10 W1). (independent)
11. Tests pinning today's F1, F3, F4, F7 behavior (before D7, D8, D12): the "F1/F4/F7 today" tests in
    `test/native-engine.test.mjs`, "F3 today" in `test/daemon-connect.test.mjs`; each later step turns its own around.
12. Close F2, F3, F5: closed `profileSelect`, `helperEnv`, auto/local as this computer (D8, D9). -> 11
   Landed as (at the Phase D gate, after step 38): `config-schema.mjs` `PROFILE_SELECT`, closed to
   the eight typed options, and `PROFILE_SELECT_REFUSED`, refused by name through a new `refused`
   spec field (`checkFields` names the key and the reason, never the value, and leaves it out;
   `configProblem` refuses it before a write); another key is named unknown as anywhere in the file.
   `helperEnv` drops every `PAIRBROWSE_ENGINE_*` (any case) it would pass on; the helper sets its own
   folders (step 38's `applyEngineEnv`). The "F3 today" test became "helperEnv drops inherited
   PAIRBROWSE_ENGINE_*"; "profileSelect is closed" is in `test/profile-schema.test.mjs`.
   D9: `native-engine.mjs` `readSettings` reads `pairbrowse.profile` `"auto"` and `"local"` as no
   persona pick (`map.mjs` `PICKS_THIS_COMPUTER`), so the launch takes the path of a config without
   one: the macOS host capture, else the seed persona (real graphics on Linux come with step 41);
   `measureHost`, `resolveAuto` and `resolveLocal` are gone from the helper, and `profileSelect` is
   read by nothing. The note (`map.mjs` `THIS_COMPUTER_NOTE`) is one launch log line and, for the
   config-backed default on the native build, a `note:` part of `profiles.mjs` `statusParts`. Tests:
   "auto never calls resolveAuto" (`test/native-engine.test.mjs`, whose recording pack now fails a
   launch that calls any of the three), `test/session-profiles.test.mjs`.
13. Close F1: filtered layers; `proxy` refusal shared with C10 (D7). -> 11
   Landed as (at the Phase D gate): `native-engine.mjs` `readSettings` copies the saved layer and,
   after the C10 proxy refusals, the canvas bridge rule and the `UNSUPPORTED` refusal, keeps only
   `PAIRBROWSE_ENGINE_KEYS` in the saved and persisted layers (`engineOnly`); the names of the rest
   go in one log line per layer (`droppedLine`: plain option names only, any other counted, never a
   value). The persona written back was already the fingerprint only. Every option the engine
   pack's own `splitFingerprintOptions` keeps is an engine key or refused, so a persona PairBrowse
   wrote logs nothing. The "F1 today" test became "launch controls are named and dropped", with
   "saved and persisted layers pass only engine keys" beside it (`test/native-engine.test.mjs`).
14. `daemon/audit.mjs`, `paths.audit` (B17).
   Landed as: `createAudit({ file, now, log, maxBytes, channels })` returns `{ append(entry), file }`;
   `append` writes synchronously and answers true or false (refused or not written, logged by field
   name or error code, never a value). The caller passes `kind`, `grant`, `session`, `tab`,
   `detail`; `t` is the audit's own (epoch ms from `now()`), and an absent field is written as null.
   `grant` is 8 lowercase hex, `session` a session name (`sessions.mjs` `validName`), `tab` cut to
   origin and path (http, https, or `about:blank`; any other address refuses the line), and a path
   segment of 32 or more key or token letters (`[A-Za-z0-9_-]`, as in the live view's and invite
   links' own addresses or a site's reset link) is written as `*`; an empty `detail` list is null. `detail` is
   one word or up to 8 distinct words from the kind's list (`DETAILS`): `minted` the action kinds
   and `replacement` (B16); `notified`, `notify-failed`, `reminded` the channel types (`CHANNEL_TYPES`,
   extended through `channels` so a new sender stays one file plus its table entry) and `no-link`,
   `no-channel`, `already-opened`; `reuse` `redeem-key`, `view-key`; `stream-refused`
   `second-stream`, `other-origin`, `other-session`, `expired`; `input-refused` `out-of-scope`,
   `not-allowed`, `expired`; `request-refused` `other-origin` (step 19); `ended` the B15 reasons; `redeemed` none. The name must be missing or
   a regular file (`lstat` first: a link, pipe or folder refuses the line); the file is opened
   `O_APPEND | O_NOFOLLOW | O_NONBLOCK` (a pipe swapped in fails ENXIO instead of blocking the helper),
   must be a regular file of the helper's uid, is put back to 0600 when found wider, and moves to
   `audit.jsonl.1` (one older generation, made 0600 first, only when the helper's uid owns it) before
   a line would take it past 1 MiB. Not wired into `daemon.mjs` yet: the composition root makes it with
   the grant table and `yourturn.mjs` (step 21, which frees the lines `daemon.mjs`'s budget needs), and
   `docs/configuration.md`'s paragraph on the trail lands with that step.
15. Reserved secrets, `loadSecrets` owner and symlink checks, atomic `writeSecrets`, masked
    `daemon/logfile.mjs` (B6, C3). -> 14
   Landed as: `scripts/rules/secrets.mjs` `reservedSecret(name)` (`PAIRBROWSE_` then capitals,
   digits and `_`), `RESERVED_RULE`, `RESERVED_MIN` (4) and `setReservedSecret(current, { name,
   value })` (reserved names only, 4 to 4096 characters, one line, no sites) for the later writers
   (C3's CLI, C14's Settings, B6's channels). `parseSecrets` and `writeSecrets` give a reserved
   name (any name starting with `PAIRBROWSE_`, the bare prefix too) no sites whatever its
   `_DOMAINS` line says; `setSecret` (the Profile panel's add form) refuses one. `policy.mjs`
   `secretNamesIn` never counts a reserved name (so it is never swapped for its value) and
   `reservedSecretsIn(tool, args, names)` finds a saved one (an unsaved `PAIRBROWSE_...` string
   is plain text, as only saved names are ever swapped): `browserToolProblem` refuses it for
   every agent; `runner.mjs` `preflight(steps, uploadsDir, secretNames)` refuses a run whose
   fill names one before any step runs, and fast mode's fill step refuses it again as a backstop. `pairbrowse_facts
   get` leaves reserved names out; the Profile panel summary marks them `reserved: true` and the
   panel offers delete only. `loadSecrets` checks the name with `lstat` (a link, a non-regular
   file, another uid or a mode wider than 0600 is refused with a problem) and again on the file
   it opened (`O_NOFOLLOW | O_NONBLOCK`, same inode); `writeSecrets` throws on a link, non-file or
   another uid at the name, else writes a fresh `.secrets.env.<pid>.<random>.tmp` (`wx`, 0600,
   fsync) and renames it over; `secretStore.save` refuses while the file on disk fails a check, so
   passwords it couldn't read are never written over, and the Profile panel shows the reason.
   `scripts/daemon/logfile.mjs` `createLogFile({ file, now, streams })` returns `{ log, maskWith,
   catchStrays, mask }`: every `daemon.log` line and every write to the helper's stdout and stderr
   (the same file) goes through `redact` with the store's values (`maskWith`, set right after the
   store, which logs its own problems through this log); the stray rejection and exception
   handlers moved there from `daemon.mjs`. Not masked: a value split across two stream writes,
   and the runtime's own print of a fatal error outside any handler.
16. `handoff` schema; senders (webhook, ntfy, Telegram, Discord, Slack) and the interface (B6, B7). -> 15
   Landed as: `config.json` `handoff` `{ enabled, away, publicLink, grantMinutes, remindMinutes,
   channels }` (defaults false, false, false, 15, 10, []; `channels` a list of objects whose own
   fields `daemon/notify/` checks), `away` (decision 8) and `publicLink` (U2) read and kept for
   their steps; `loadConfig` fills each field from its default and `config-schema.mjs`
   `handoffTimes` gives the remind fallback, `max(1, floor(grantMinutes * 2 / 3))`, with a warning
   (`remindMinutes` is any whole number from 1, so a value at or above `grantMinutes` falls back
   rather than being refused).
   `scripts/daemon/notify/`: `post.mjs` `httpsPost(url, body, { headers, timeoutMs, retryMs, wait,
   request })` answers `{ ok, status?, error }` (never the address; own `http`/`https` agents, so no
   proxy from the environment), `addressProblem`, `isLoopbackHost`; `message.mjs` `ACTIONS`,
   `END_REASONS`, `messageProblem` (unknown fields and values outside their rule refuse the whole
   message; `link` at most 1600 characters, so the longest message stays under Discord's 2000 whole;
   `expiresAt` a whole number of ms up to the last time a `Date` holds; `reason` is an ended message's B15 reason, or `browser-restarted` on a replacement turn,
   B16), `messageText(message, { withheld })` (times in UTC: the person's zone is unknown to a
   server); `channel.mjs` the field rules (`secret`, `address`, `values`, `pattern`) and
   `secretFor` (secrets read at each send, so a changed token counts at once); one file per sender
   with `{ type, fields, create(channel, { secret, post, messageText }) }`; `index.mjs` `SENDERS`,
   `buildSenders(channels, { secret, post, table })` (warnings name the channel and the secret's
   name, never a value), `createNotifier({ channels, secret, log, post, table, sendMaxMs })` with
   `send(message)` answering `{ sent, failed: [{ type, error }], withheld }` (each sender bounded at
   30 s, one failing never holds up the others), `usable()`, `warnings()`, `describe()`, and
   `handoffSends(config, { server })` (decision 8: `enabled` and server mode or `away`). Request
   shapes as checked against the providers' documentation on 2026-10-20: Telegram `sendMessage`
   with `link_preview_options: { is_disabled: true }` and no `parse_mode` (optional channel field
   `server` for a Bot API server of your own, default `https://api.telegram.org`); Discord Execute
   Webhook with `flags: 4` (SUPPRESS_EMBEDS) and `allowed_mentions: { parse: [] }`, a message over 2000
   characters refused rather than cut; Slack incoming
   webhook with `unfurl_links` and `unfurl_media` false, text escaped; ntfy `X-Title`,
   `X-Priority` (4, an end 3), `X-Tags: pairbrowse`, `X-Click`, `Authorization: Bearer`; ntfy
   `link` is `"auto" | "always" | "never"`. Topic, bot token and chat id values are checked by
   pattern before they reach an address. Not wired into `daemon.mjs` yet: `yourturn.mjs` (step 21)
   makes the notifier. Security row B-3 lands here with "nothing sends them yet".
17. `daemon/grants.mjs` (B2, B3, B4). -> 14
   Landed as: `createGrants({ now, mono, audit, log, timers })`. `mint({ session, page, action,
   minutes | expiresAt, replacement })` answers `{ id, redeemKey, expiresAt }` (the only time the
   redeem key leaves the table; `minutes` a whole number 1 to 120, default 15 (`GRANT_MINUTES`);
   `expiresAt`, a replaced link's deadline (B16), within 120 minutes; `action` one of `ACTIONS`;
   audit `minted` with the action, plus `replacement`); a grant already open on that page ends
   (`agent`), the page leaves any other live grant's scope (a pop-up handed over on its own) and a
   hold there is released, so a tab has one grant at a time. Keys are kept only as
   SHA-256 hashes compared in constant time against every grant (the redeem key itself only until
   it is used, for the one reminder: `redeemKey(id)`); hashes of used and ended keys stay until the
   grant's own expiry and a key found among them audits `reuse` (`redeem-key`, `view-key`) and
   answers null like an unknown key. `matchRedeem(key, { session })` never uses the key (B-AP1);
   `redeem(key, { session })` answers `{ id, viewKey, view }` once and audits `redeemed`;
   `matchView(key, { session })`; each ends the grant (`session-switched`) when `session` is not
   the grant's, and throws when `session` is not a session name (a missed argument ends nothing). `openStream(id)` answers `{ close() }` while no stream is open, else null with audit
   `stream-refused` `second-stream` (the stream gate of step 19 uses it). Scope: `inScope(page,
   id?)`, `forPage(page)`, `addToScope(opener, page)` (only an opener inside a live scope adds),
   and `closed(page)` (added: the handed-over tab closing ends its grant with `tab-closed`; any other
   scope tab only leaves the scope). `end(id, reason)` and `endWhere(test, reason)` take the B15
   reasons only and audit `ended`; `hold(page, { session })`, `held(page)`, `release(page |
   { session })`; `open()` lists `{ id, session, action, page, scope, createdAt, expiresAt,
   redeemed, streaming }`; `onEnd(fn(view, reason))` (the view as the grant was when it
   ended, so `redeemed` tells a link never opened from one opened but not finished); `ended(page)` a promise of `{ id, reason }`
   or null when no grant covers the tab. Expiry on the wall and monotonic clocks as invites, read
   at every call (`sweep`) and by a timer per grant (unref'd), so a waiter wakes at the deadline
   with nobody calling. `RIGHTS` (`liveview/invites.mjs`) gains `turn` (`page, events, thumb,
   state, input, turn`) and `redeem` (`page`); the refusal of `POST pause` to role turn lands with
   the gate (step 19). New structure edges `grants -> audit` (`tabPlace`) and `grants ->
   notify/message` (`ACTIONS`, `END_REASONS`). Not wired into `daemon.mjs` yet (step 21). Security
   row B-1 lands here for the table, with "nothing makes one yet" and `test/grants.test.mjs` only;
   `test/liveview-grants.test.mjs` joins it in step 19.
18. `char` input and fuzz (B8). Landed: `char` in `readViewerInput` and `replay` (`charOf`), unit test
    in `test/input.test.mjs`, fuzz in `test/fuzz/joiner-input.test.js`; row B-2 lands with "nothing sends it
    yet" (the type box, and its "keeps nothing", come with the turn viewer, step 20).
19. Live view grant server: redeem page, stream gate, `routes/turn.mjs`, pinning, filters, events
    (B-AP1, B3, B4, B5). -> 17, 18
   Landed as: `startLiveView({ grants })` (null: no grant key ever matches). `scripts/liveview/grants.mjs`
   `createTurnGate(...)`: the dispatcher matches the owner's key, the pages' key, invites, then
   grants (`grants.match(key, { session })`, added: both keys in one pass, so a used key audits
   `reuse` once), as a guest `{ id: "turn-<id>" | "redeem-<id>", grant, role, label: "Hand-off" }`;
   only on the owner's port, under loopback or `liveViewHosts` names (B5). A grant-key request
   with an Origin that is neither loopback nor `inviteOrigin` is refused, GETs too (another site
   could otherwise hold the one stream), and audited through `grants.refused(id, kind, detail)`
   (added: `stream-refused` `other-origin` for the view key's event stream, `request-refused`
   `other-origin` for any other GET such as the landing page, `input-refused` `not-allowed` or
   `out-of-scope`). The
   landing page is its own small page, `scripts/liveview-redeem.html` with `liveview-redeem.js` and
   `.css` (in `ASSETS`), served for role redeem at `GET /<redeemKey>/` under `VIEWER_CSP`: the step
   sentence (`actionSentence`), the host, the expiry (UTC, rewritten in the phone's own time) and
   "Take over", which posts `redeem` and moves with `location.replace` (B-AP1). `routes/turn.mjs`:
   `POST redeem` (role redeem; 404 alike for used, ended or unknown), `POST turn-done`, `POST turn
   { show: tabId }` (scope tabs only, else 409), `POST turn-revoke { id }` (right `tools`, the
   owner). `turn-fill-card` moves to step 45 with the saved card. Stream gate in the viewer's
   events route: `openStream` or 409 "This hand-off is open somewhere else. Close it there, ..."; the stream joins
   `linkGuests` (approval card rule applies). Filters: `forTurn` keeps tabs and activity of scope
   tabs, by each tab's id (`tabsInfo()` entries carry `id`; a tab number shifts when a tab closes
   while the list is built); frames, `thumb.jpg` (409 when another tab is on screen) and the first frame come only
   from scope, uncovered, and `guest-frames.mjs` skips turn streams, so other guests keep covers.
   Input: 409 "That tab isn't on screen. Go back ..." unless a scope tab is shown, checked again in the input
   queue; `readViewerInput` and `replay` drop `nav go` for role turn; `POST pause` is 403 for
   role turn. Pinning: `cast.mjs` `follow()` takes `pinned()` (every open turn stream's scope):
   while one is open the picture stays on a scope tab and goes back to the grant's tab whenever
   another is shown (the owner's own switch too, at the next tick); a pinned `follow()` records
   no `followed` address, so the `follow()` that `onEnd` calls brings the picture back to the
   agent's tab even when its address did not change. Events (`ui/events.js`,
   `to: "turn"`): `turn` `{ id, action, host, expiresAt, scope: [{ id, title, host, shown }], state:
   "on" | "off" }` at stream open and whenever it changes (tabs broadcast, a pop-up joining), and
   `turn-ended` `{ reason }` from `onEnd`, after which the stream closes; the viewer
   (`liveview.js`, until step 20's turn viewer) closes its EventSource on `turn-ended` and never
   opens it again, so its own reconnect with the dead view key does not audit a false `reuse`. Scope: the gate watches
   the browser context from the first open grant (each tick, or the live view's `watchGrants()`
   right after a mint, step 21): a tab opened later whose `opener()` (bounded, 1 s) is in a scope
   joins it (`addToScope`), any tab closing calls `grants.closed`; tabs open before the watch are
   not asked. Each tick ends grants of another session than the one shown (`session-switched`).
   `invites.onRevokeAll` (added) ends every grant `revoked` (`pairbrowse_invite revoke_all`; also
   `sharing.endAll` when the window closes, which step 21 or 22 precedes with `browser-restarted`
   or `helper-stopped`). Tests: `test/liveview-grants.test.mjs`; the masking half of "another
   joiner's ... agent's results stay masked" lands with B10 (step 21).
20. Turn viewer `liveview-turn.js` (phone-first) and mobile viewer tests (B8). -> 19
   Landed as: `scripts/liveview-turn.js` (in `ASSETS`) `startTurn({ base, img, stage, on, frame,
   reopen, end })`, imported by `liveview.js` for role turn only and before the stream opens (so it
   hears the first `turn` event); `liveview.js` keeps the stream, the picture, its size and the
   end overlay (`endTurn`), and its desktop input handlers stand aside for role turn. Layout:
   `body[data-role="turn"]` in `liveview.css` hides the column, strip, toolbar and activity; the
   module adds a header (action kind words, host, `m:ss left` from `expiresAt`, connection chip,
   Done, a scope `<select>` shown from two scope tabs, "That tab isn't on screen." with "Go back"
   posting `turn { show }` of the grant's tab) and a keys row (the type box, `-`, the zoom level
   which resets to 1x, `+`), 44 px targets, the box at 1rem so a phone doesn't zoom on focus.
   Touch: a press starts after `HOLD_MS` 200 ms without travel (so a 2 s hold reaches the page as
   about 1.8 s), a release before that is moved, pressed, released together; travel past 8 px
   before the press is `wheel` at the start point in page pixels at the current zoom; a moved
   press drags with `buttons: 1`; a cancelled press still releases; a second finger before the
   press pinches (the picture point under the fingers' midpoint stays under it, panning too), after
   it is ignored. Zoom is a transform on `#frame` (1x to 4x, `+`/`-` by 1.5, clamped so the
   picture covers the stage), so `point()` still maps through `getBoundingClientRect()`. A mouse
   (the link opened on a computer) clicks and drags directly. Type box: `keydown` sends the named
   keys (Backspace, Enter, Tab, Escape, arrows, Home, End, page keys; Shift or nothing),
   `beforeinput` maps `insertText`/`insertReplacementText`/`insertFromPaste` (a `char` per code point,
   one `text` above 32), `deleteContentBackward` to Backspace, `deleteContentForward` to Delete,
   `insertLineBreak`/`insertParagraph` to Enter, composition once at `compositionend`, and an
   `input` fallback sends anything that slipped in once (not the text a composition just sent);
   the box is emptied each time. Queue: one POST in flight; hover moves and wheel deltas merge
   while it is out; input goes only once the stream is up and has sent its `turn` event (after a
   reconnect, or after the page was hidden long enough for `liveview.js` to close the stream, which
   it now says as reconnecting, the picture is back on the grant's tab first); a POST that fails or answers 5xx is
   sent again unchanged after 1 s; 409 shows "That tab isn't on screen" (dropped, as the helper
   did not replay it); 404 or 403 ends the viewer. Added (not in B8): each batch is `POST
   input?run=<16 hex per page load>&seq=<n>` and `liveview/grants.mjs` `batchOf(guest, req)`
   keeps per grant and run (at most 8 runs per grant, dropped when the grant ends) the last number
   replayed: a repeat (number not above it) is answered 204 without replaying, the same number
   while it is still being replayed is answered 503 (sent again in 1 s), and a number counts only
   once `humanPost` resolved (a 409 or a 500 leaves it unrecorded, so the retry is replayed). So a
   request whose answer was lost is never applied twice, two pages on one view key never mix their
   numbers, and a failed one is never lost; a batch without them is always fresh. A mouse press
   keeps its last place, so a cancelled one is released there. Reconnect:
   EventSource retries a network drop itself; when it is refused (409 while the helper still holds
   the dropped stream) `liveview.js` hands it to `lost()`, which asks `state.json` (404: the
   hand-off ended while away, the viewer ends) and else reopens after 2 s. Done waits up to 5 s for
   the queue to empty, then posts `turn-done`. Status events no longer move focus to the stage in
   a turn viewer (it would close the phone's keyboard). Tests: `test/liveview-mobile.test.mjs`
   (the viewer's tests of the acceptance table's Interaction and Mobile hand-off rows, in the
   runtime's browser at 390x844 with `isMobile` and `hasTouch` through a loopback relay that drops
   connections as a lost signal does, since the browser's offline switch leaves an open stream
   alone; hidden then shown, input held until the turn event; a cancelled mouse press released;
   plus the repeat rule, a 500 retried and two runs on one key without a browser), `test/liveview.test.mjs` (served asset). Row B-2
   now names the type box, the viewer and `test/liveview-mobile.test.mjs`.
21. `daemon/yourturn.mjs`, lambdas out of `daemon.mjs`, status result, `TURN_MS`, masking (B7, B10,
    B11). -> 16, 19
   Landed as: `createYourTurn({ config, grants, notifier, sends, handoffs, journal, saveTabs,
   hostNote, audit, hud, sessionName, linkFor, agentBy, log, turnMs, timers, now })` (no `context`,
   `presence`, `notifyLocal` or `coherence`: the window's own notification stays the badge's, and
   B14's lists come with the coherence rules). It takes over the hud's `onStatus` (`onBadge`: the
   Tools tab entry, now with the step's kind), popups' `onYourTurn`/`onCleared` (`onChallenge`,
   `onChallengeCleared`) and serve's `onRunStatus`; `daemon.mjs` makes the audit, the grant table
   and the notifier (`createNotifier` with `secrets.get().values` read at each send) and passes
   `sends: () => handoffSends(config, { server: context.isServer() })` (`isServer` now on the
   context facade). `onStatus(participant, args, page)` replaces `report()`: called by
   `pairbrowse_status` before the badge (so the step kind is set when `onBadge` runs), it answers
   a promise of the result's second line, waited for at most `REPORT_MS` (12 s; "on its way"
   after that): "Your turn sent (webhook, ntfy): hand-off 3fa1c2d9 for tab 2, until 14:35 UTC.
   Don't act in this tab; wait with browser_wait_for.", plus channels that left the link out or
   failed; all failing: "Couldn't reach any hand-off channel (...): tell the user directly"
   (the grant stays); enabled with no usable channel: no grant, audit `notify-failed`
   `no-channel`. `pairbrowse_status` gains `step` (`ui/vocab.js` `STATUS_STEPS`, the same list as
   `ACTIONS`, checked in `refuse.mjs`); without it the kind is `handoffKind(text)`. The page is the
   agent's spark tab, else its own tab; a check's grant is the check's page (one at a time; the
   same check seen again mints nothing). A tab on no website (no http(s) host, which every message
   names) mints nothing: the step stays in the window. Channel types are listed once (two webhooks
   send as one `webhook`). Any other status kind ends the agent's grant (`agent`).
   Messages: one `turn`, exactly one `reminder` at `remindMinutes` (two thirds of `TURN_MS` in
   tests; the link only while `grants.redeemKey` holds it, else audit `already-opened`), and
   `ended` on every end but `done` when a turn message went out (on expiry exactly one). Audit
   `notified`/`reminded` with the channel types (and `no-link`), `notify-failed` with the failed
   ones. Expiry (B11): the tab is held first, then `journal.flushNow()`, `saveTabs()`, the goal
   log's Your turn gets "Not done in time: <step sentence>", the ended message, the badge (the
   agent's own status with its label, or PairBrowse's for a check) and Tools entry "Timed out: ...", one
   host note (`TIMEOUT_NOTE`). A check that clears after its timeout takes its "Timed out" badge down
   and releases its tab. `personUsed(page)` (presence's `onUsed`) releases a held tab; so do a new
   "you" (mint) and `browserClosed()` (the window closing: grants end `browser-restarted`, before
   `sharing.endAll`); the helper's stop ends them `helper-stopped` and waits up to 5 s for the
   messages. B10: `masked(page)` (a live grant's scope, and also a held tab) makes
   `serve/result.mjs`, `serve.mjs` `reply` and `pairbrowse_click_at` treat the result as a joiner's
   agent's (sensitive values, card masking, covered pictures or none). `handedOff(page)` is the
   same test, for step 22's refusals. `sharing.handoffLink(key)`: `inviteBaseUrl` or loopback with
   the live view's port, and `watchGrants()`; the live view gets the grant table (`grants`).
   `TURN_MS` in `testenv.mjs`. Not here: `recover()` and `turn.json` (B16, step 22; a browser
   restart now ends the grant), the supervisor's `onCrashLoop` (still a no-op until B16), B14's two
   lists, B15's end note and the `browser_wait_for` wake (step 22). Away switch (decision 8): GET
   config.json gains `away: { on, server, ready }` (`ready`: `handoff.enabled` and a usable
   channel) and POST config `away` (refused without `ready` and on a server; writes only
   `handoff.away` into config.json's own `handoff`, the running config's filled-in values stay
   out of the file); `ui/panels.js` `awaySwitch` draws it in the side panel's Tools tab
   (Hand-offs), Settings (Agents and approvals) and the live view's Profile panel, each kept
   current by the `config` event. For `daemon.mjs`'s budget (now 850), the download event moved
   into `toolstab.mjs` `createDownloads({ agentOf }).event`. New structure edges `yourturn ->
   notify/message` (`ACTIONS`, `actionSentence`, `clock`) and `yourturn -> toolstab`
   (`handoffKind`). Security rows B-1, B-3, B-7 now say what makes and sends links and writes the
   trail; B-5 lands; B-8 (diagnostics, badge, and the invite-links limit); the settings row names `away`. Tests: `test/yourturn.test.mjs`,
   `test/config-route.test.mjs` (Away).
22. `browser_wait_for` early wake, `handedOff` refusals, card-field refusals in every session,
    fast-mode step, `turn.json` recovery (B9, B13, B15, B16). -> 21, 8
   Landed as: B9: `yourturn.handedOff(page)` answers `"open"`, `"held"` or `""`; `tabRefusal(...,
   { handedOff })` (passed by `rewrite.mjs`) refuses every `HAND_TOOLS` tool, `pairbrowse_run`,
   `browser_navigate`, `browser_navigate_back` and `browser_tabs close` of the tab (its own, or by
   index) with `HANDED_OFF_RULE` or `HELD_RULE`; a refused click leaves the "you" badge up. B13 (as
   13.1): pure rules in `scripts/rules/cards.mjs` (`CARD_TOKENS`, `isCardNumber`: Luhn plus a network
   table of prefixes and lengths, 13-digit Visa left out so EAN and ISBN codes pass; `cardNumbersIn`
   on `maskCards`' shapes; `cardKey` for digits and Cmd/Ctrl+V (Shift and Alt held too, as "paste
   and match style" is), Shift+Insert; `cardRefusal(signal)`,
   "Refused (<signal>). Card details are the person's to enter: hand this step over with
   pairbrowse_status kind you, step payment, then wait with browser_wait_for."), the page reads in
   `scripts/runner/cards.mjs` (`cardFieldOf`, `cardFieldAt`, `focusedCardField`, each read bounded at
   1.5 s and read as no card field when the page doesn't answer: the text is still checked).
   `refuse.mjs` `cardProblem` runs in `browserToolProblem` right after the reserved-secret check:
   `browser_type`, `browser_fill_form`, `browser_drop` `data`, `browser_select_option`, and
   `browser_press_key` digits or paste into the focused field. Fast mode: `preflight` refuses a fill
   with a card number before any step; `fill.mjs` refuses a saved password holding one and any card
   field (its combobox fallback too); added beyond 13.1 for the same rule: `select.mjs` (native and
   main path) and `press.mjs` (digits, paste). `facts.mjs` refuses a card number from `remember` and
   drops one from `seenInForm`. B15: `yourturn.ended(page, participant)` (the agent's own "you" or
   run step, else the grant covering the tab) is raced by `browser_wait_for` (`wait-for.mjs`: the
   `time` sleep and the `text`/`textGone` looks alike, and with nothing named it waits for the
   hand-off up to 120 s (found at the Phase B gate: `refuse.mjs` `argProblem` refused a wait with
   nothing named before it reached the tool; that check now lives in `wait-for.mjs`, for a tab with
   no hand-off only);
   `endedLine`: "ended (<reason>)... take a browser_snapshot", or at expiry "timed out ... Stop
   here"); `onRunStatus` now mints a grant for a fast-mode `handoff` step when hand-offs go to the
   channels, which the step races through `hooks.turnEnded` (Done or cleared finishes it, expiry and
   other ends stop the run) and ends with `agent` when the step ends; on every end but `expired` one
   host note: why, `presence.didIn(page)` (field and button names), and to take a snapshot. B16:
   `createYourTurn` deps `turnFile` (`sessionFile(name, "turn.json")`), `keptAlive`, `successorOf`,
   `pagesNow`, `actionsIn`; `turn.json` is `{ v: 1, turns: [{ id, key, action, host, url, expiresAt,
   reminded, sent }] }` (0600, rewritten on each change, removed when empty, read once per session
   per helper before its first write). Differs from B16 as written: an end by `browser-restarted`
   under keep-alive sends no ended message yet; `recover()` (called by `browser/tabs.mjs` after a
   restore through the new `onRestored` dep, and by `daemon.mjs`) mints the replacement on the
   successor tab (else the tab at the same address, else the same origin and path) with the same
   deadline and no second reminder if one went, or sends the deferred ended message (now "the browser
   restarted. The step was stopped safely."). The supervisor's `onCrashLoop` is `yourTurn.crashLoop()`,
   which sends those deferred messages. A helper stop still sends its `helper-stopped` message at
   once (the person may not see that helper again) and keeps the entry; the next helper reissues it
   once if more than 5 s are left, else drops it. Tests: the four that typed a card through an agent
   tool: `click-flows` now asserts the refusal (the form's `cc-*` fields alone make its submit a
   payment), `shared-rules` and `join` set the card with the new `pairbrowse_test_fill` (switch
   `FILL`: `page.fill` as a person would), `fastmode-forms` asserts the preflight refusal and keeps
   the frame case with a non-card value. Unit: `test/cards.test.mjs` (new), `test/refusals.test.mjs`,
   `test/wait-for.test.mjs` (new), `test/yourturn.test.mjs`. Security rows: "Card details are
   entered by a person, never by an agent, in every session and app" and "An agent finishes a step
   meant for a person" (B-4) are new; the Pay click, masking, hand-off link and files-at-rest rows
   name them. Not here: the CHANGELOG entry (with the release, step 50), the shared-rules case
   "after a payment hand-off ends, an agent's click on the site's Pay button still needs the Pay:
   name" (the Pay rule itself is unchanged; landed at the Phase B gate in `test/shared-rules.test.mjs`
   on the grant table, `tabRefusal`, `clickRule` and `decide`), the integration test of the full path
   (landed at the Phase B gate on the existing live harness, not step 46's: `test/integration/your-turn.test.mjs`
   with a loopback webhook, Away on, the person's side as plain requests to the view key, so one
   browser; T-B18 is reported for the touch half, `dispatchTouchEvent` alone; select and autofill
   lists in frames are not measured).
23. `skills/pairbrowse/SKILL.md` and `core.md` text (B15). -> 22
   Landed as: SKILL.md "Hand-offs and waiting" replaces the 20-loop with: `step` on the status,
   leave the tab (the B9 refusals; the next status ends the hand-off), `browser_wait_for` with
   nothing named when the step went to the phone (it returns at the end and says why), `textGone`/
   `text` with `time` between looks in the window only (decision 8: no grant, nothing wakes it),
   snapshot after (Done is a hint, the host note names what the person did), stop at "timed out"
   or a held tab; a Payments paragraph (fill the rest, hand over with step payment, the Pay name
   still applies). The joiner masking line names handed-off tabs. `core.md` (4,995 of 5,000
   characters): a hard rule that card numbers, codes and expiry dates are the person's (test
   cards too), the hand-off line with step, leave the tab, wait, snapshot and the timeout stop;
   the CAPTCHA rule points at it and the testing list is one line. Beyond the step, for the same
   rule: the signup and listing skills lose their 20-loop too, and the test-site skill gets the
   card rule as a hard rule plus what to do with card test cases. `docs/security.md`: the card
   and hand-off rows say the agents are told, the badge row no longer says agents never ask for a
   card. CHANGELOG: an Unreleased note (step 50 moves it under the release). Tests:
   `test/core.test.mjs` (core and skills wording).
24. `net/config.mjs` and `network` schema (C4). -> 15
   Landed as: `scripts/net/config.mjs` `checkNetwork(raw)` answers `{ network, problem,
   proxyProblems, sessionProblems, warnings, messages }` and never throws; `networkFor(config, session,
   { profileNetwork })` answers `{ session, id, source, proxy, strict, checkUrl, recheckMinutes,
   problem }` (`source` `session`, `profile`, `default` or `direct`); `parseServer` writes a
   server back as `scheme://host:port` (ports 80, 443, 1080 filled in; host a name, a dotted-quad
   IPv4 or a bracketed IPv6); no message repeats a value written in the block, only its kind (a
   list, a string), and names a proxy id, session name or unknown key only when it has that shape
   (any of them may hold a password written there by mistake); `readNetwork(file)` reads
   `config.json`'s `network` for the launch (absent file or key: direct; unreadable, unparsable or
   not an object: a problem). Fail closed: a wrong type or unknown key at the block's top (or too many
   proxies, over 64) refuses every session; a proxy entry with a wrong value or an unknown key (a
   misspelt `expectEgress` would drop the expectation), user info, `socks4:`, PAC, `direct:`, a
   path, SOCKS5 with `auth` (U4) or, in strict mode, a non-loopback `bypass` refuses the sessions
   using it; a map entry that isn't an id or `null` refuses that session; an undefined id named by
   the map, a profile or the default refuses at `networkFor`. Only `strict` (to `true`) and
   `recheckMinutes` (1 to 1440, to 10) fall back. `bypass` entries are host names (optionally
   `*.`), addresses with an optional port, bare IPv6 addresses (no port), or ranges; the loopback ones strict allows are
   `localhost`, `127.0.0.1`, `[::1]`, `::1`. `expectEgress` items are addresses, ranges or
   `country:XX`; `[]` reads as `null`. `checkUrl` must be https with no user info. Schema:
   `DEFAULT_CONFIG.network` is `null`; `config-schema.mjs` keeps the value as written (no type, so
   a wrong one is never swapped for the default) and `configProblem` refuses a write that brings
   any of `checkNetwork`'s messages; `loadConfig` adds its warnings. `saveConfig` refuses (throws,
   nothing written) when `config.json` is there but isn't valid JSON or an object, rather than
   writing a file of only the new fields: an automatic save (a participant name, `joinHosts`, the
   install step's `browser`) would otherwise drop the `network` block and turn proxied sessions direct. Not here: `launchPart` (with
   `forLaunch`, step 27, where its strict switches and auth file are used) and
   `net/credentials.mjs` (the secret names, the CLI). Until step 27 the block is read and checked
   but no launch uses it (`docs/configuration.md` says so). Tests: `test/net-config.test.mjs`.
25. Native-engine proxy rules: saved persona refusal, `proxyAuthFile` in `shellFrom` and
    `EXTENSION_SHELL` (C1, C10). -> 13, 24
   Landed as (ahead of step 13, which reuses the refusal): `native-engine.mjs` `personaProxyRefusal(where)`,
   thrown in `readSettings` when the saved profile or the persisted persona has a `proxy` key (any
   value, `null` included; the sentence names neither address nor credentials and points to
   `network.proxies`); config.json's own `pairbrowse.proxy` stays named and dropped as before.
   `proxyCredentials(proxy)` and `PROXY_CREDENTIALS_REFUSAL`: a launch's `proxy` option with a
   `username`, a `password` or user info in its `server` stops `launchNative` first thing (before a
   host capture) and again on `merged.proxy` before `pack.resolveProxy`, so no credential reaches the
   driver or a switch. `proxyAuthFile(manifest)` reads the manifest field (an integer 1 and up);
   `shellFrom` carries it (`proxyAuthFile`), `EXTENSION_SHELL` has it `false`, so the open build and
   a native build without its own pages never take credentials; `daemon/browser/launch.mjs` `shellFor`
   has the same field (seam `proxyAuthFileOf`). The auth file itself and the refusal of `auth` without
   `proxyAuthFile` are `launchPart` (step 27). Tests: `test/native-engine.test.mjs` (the F1 test no
   longer pins the proxy), `test/browser-choice.test.mjs`.
26. Geoip fields out of the persona, quiet geoip (C9).
   Landed as: `native-engine.mjs` `savePersona` drops `GEOIP_FIELDS` (time zone, languages, WebRTC
   address, location) whenever `pairbrowse.geoip` is on, whichever layer set them (a value set in
   config.json or a saved profile is read from there again each launch); a persona written before
   loses them at the next geoip launch. `applyGeoipQuietly` calls `pack.applyGeoip(fingerprint,
   options.proxy, true)`: the launch's own proxy only (the persisted and saved layers' `proxy` is
   refused since step 25, so the old `rest.proxy` fallback is gone), quiet so the pack writes no
   exit address to stderr (`daemon.log`), and a failure's sentence has its addresses taken out
   (`withoutAddresses`) before it becomes the launch error. Through a proxy that needs credentials
   the pack's lookup cannot authenticate (the credentials reach only the browser, C1), so such a
   geoip launch stops until step 48's `applyGeoip` takes the IP C6 measured. The pack's one-time
   region database download stays direct until step 48 (E11); `docs/configuration.md` says so. The
   existing GeoIP test kept its expectation (the migration note's line 548 needed no change). Tests:
   `test/native-engine.test.mjs` ("geoip with a proxy never writes its fields into the persona", and
   config values, geoip off, a failure naming no address, `withoutAddresses`).
27. `daemon/network.mjs` `forLaunch`, launch wiring in section 3.2 order (C5). -> 4, 24
   Landed as: `scripts/net/config.mjs` `launchPart(net, { shell, secrets })` (net: `networkFor`'s
   answer; secrets: `loadSecrets`'s `{ values, problem }`) answers `{ proxy, args, authFile, drop }`
   or `{ problem }`: `proxy` the driver's `{ server, bypass }` with `localhost,127.0.0.1,[::1]`
   first (`DRIVER_LOOPBACK`; the driver otherwise adds `<-loopback>`) then the entry's bypass
   (lower-case, a bare IPv6 address bracketed); `args` the resolver rule `MAP * ~NOTFOUND, EXCLUDE
   <proxy host>, EXCLUDE localhost` in strict mode and, beyond C5, always for SOCKS5 (the driver's own
   SOCKS rule comes first and a user's local rule would otherwise replace it), and in strict mode
   `STRICT_WEBRTC` (and, since step 28, `STRICT_WEBRTC_OPEN` off a native build); `drop` `host-resolver-rules` whenever the helper sets its own;
   `authFile` the engine contract's `{ server, username, password }` for a proxy with `auth` on a
   shell with `proxyAuthFile` (refused on every other shell, the open build too, and when the
   secrets are missing, under 4 characters or `secrets.env` fails its checks). `applyLaunchPart`
   applies it to launch options (user switches taken out, the helper's last). `scripts/net/
   credentials.mjs` landed with `NETWORK_ID` (moved from config.mjs, re-exported there),
   `proxySecretNames` and `credentialsFor` only; its CLI (`set`, `remove`, `list`) is not here
   (it landed at the Phase C gate: `node scripts/net/credentials.mjs` runs
   `net/credentials-cli.mjs`, loaded only then so the module stays pure; `set <id>` takes the
   username and password with echo off at a terminal or as stdin's first two lines, never as
   arguments, checks `secrets.env` with `loadSecrets` first and writes it with `writeSecrets`;
   `remove <id>`, `list` (names only). Also at the gate: `createNetwork` reads `secrets.env`
   through `readSecrets`, which `daemon.mjs` gives as the helper store's `reload()`, so a credential
   added while the helper runs is masked in its logs from the launch that uses it on).
   `scripts/daemon/network.mjs` `createNetwork({ log, configFile, secretsFile, runDir })`:
   `forLaunch(session, { profileNetwork, shell })` reads `config.json` (`readNetwork`) and, only
   for a proxy with `auth` on such a shell, `secrets.env` fresh at each launch; throws the refusal
   sentence (`sessionRefusal`); writes the auth file (`writeProxyAuthFile`: one line of JSON, 0600,
   `run/proxy-auth-<random>`, older ones swept) and adds `--pairbrowse-proxy-auth-file=<path>`;
   answers `{ id, source, strict, proxy, apply(options), drop() }`; also `current()` and
   `strict()`. Logs name the id, source and strict, never an address or credential. Wiring:
   `daemon.mjs` passes `network: createNetwork({ log })` to `createContext` (a dep, no new
   import edge; `null` only in tests: direct), `launch.mjs` calls `forLaunch` right after
   `ensureScreen` (section 3.2 step 3; profiles, step 2, come with step 37) and before any key file,
   passes `net.apply(options)` to `launchEngine` and drops the auth file in its `finally` (up, or
   failed). `native-engine.mjs` keeps a WebRTC switch equal to `STRICT_WEBRTC` (the pack then adds
   none) and still drops every other one. No egress check yet (steps 28, 29): until then a proxied
   session starts without one (`docs/configuration.md` says so). Tests: `test/net-launch.test.mjs`
   (the three named in Phase C, plus credentials, refusals, the auth file and the wiring order),
   `test/net-credentials.test.mjs` (names and lookup), `test/native-engine.test.mjs` (strict switches
   on the native launch), `test/structure.test.mjs` (`daemon.mjs` passes `network:`).
28. Probe, verdict, browser check, `NET_CHECK` (C2, C6).
   Landed as: `scripts/net/probe.mjs` `probeEgress({ proxy, checkUrl, auth, timeoutMs })` answers
   `{ ok: true, ip, loc }` or `{ ok: false, step, problem, timedOut }` and never throws: one deadline
   (`CHECK_MS`, 10 s) over every step (connect, tunnel or socks5, tls, answer), each awaited through
   `within`; http: and https: proxies through CONNECT (Basic `Proxy-Authorization` only there; an
   https: proxy over TLS), socks5: without authentication (U4: credentials refused before
   anything is sent; RFC 1929 is not implemented, so the Phase C test name lost it), the check host
   sent as a name (type 3; an address as type 1 or 4); TLS to the proxy and the check host against
   Node's list plus the system's (`tls.getCACertificates` where this Node has it), no insecure
   option; a redirect is not followed; the answer capped (`BODY_MAX`, 64 KB), Content-Length,
   chunked or to the close. `proxy: null` probes this computer's own exit (only compared, C9).
   Problems name the proxy's host:port or the check host and the step, from the error's code only,
   never a credential. `parseTrace` reads `ip=` (written-out addresses only) and `loc=` (two
   capital letters). `checkTargets(net)` gives `{ checkUrl, directUrl, stun, timeoutMs }`:
   `network.checkUrl`, `STUN_URL` and `CHECK_MS`, or with `NET_CHECK` (JSON `{ checkUrl, directUrl,
   stun, ms }`, http: allowed, a malformed value ignored) local stand-ins. `scripts/net/verdict.mjs`:
   `normalIp`, `inExpected(ip, loc, expectEgress)` (ranges and countries each required when named;
   null without an expectation), `egressVerdict({ helper, browser, direct, expectEgress, baseline })`
   (`ok`, `failed` or `changed`; `sameAsDirect` null when the direct exit isn't known, as behind a
   proxy-only network; a failure outranks a change), `parseCandidate` and
   `webrtcVerdict(gather, { egress })` (a candidate address or raddr other than an mDNS name, the
   unspecified address or the exit is a leak, an unreadable line too; candidates kept as `{ type, kind
   }` without addresses); no reason names an exit address. `scripts/net/browsercheck.mjs`
   `checkInBrowser(context, { checkUrl, stun, timeoutMs, gatherMs })`: a new tab, a DevTools session,
   `Page.getFrameTree`, `Network.loadNetworkResource` (no cache, no credentials), `IO.read` to the
   end and `IO.close`, then an `RTCPeerConnection` gathering bounded in the page (`GATHER_MS`, 5 s)
   and again outside; the tab and session closed whatever happened, each bounded. Not here: the
   check tab kept out of tab memory and the strip, and calling all this at launch (step 29).
   Found and fixed here: on the open build the browser ignores `STRICT_WEBRTC`
   (`--webrtc-ip-handling-policy`, the native engine's spelling) and gathers srflx candidates (this
   computer's public address); the spelling `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`
   stops them. `launchPart(net, { shell, secrets, native })` now adds `STRICT_WEBRTC_OPEN` (that
   spelling) after `STRICT_WEBRTC` in strict mode unless `native` (`forLaunch` passes
   `native: next.browserEngine === "pairbrowse"`); never on a native build, whose `native-engine.mjs`
   `webrtcPolicy` drops every WebRTC policy switch but `STRICT_WEBRTC` and logs it as the user's
   (step 29 keeps that in mind). The integration test launches with `launchPart`'s own args. Tests: `test/net-probe.test.mjs`,
   `test/net-verdict.test.mjs`, `test/net-browsercheck.test.mjs`, `test/integration/net-browsercheck.test.mjs`,
   `test/security.test.mjs` (`NET_CHECK`); stubs in `test/helpers/proxies.mjs` (trace echo, HTTP and
   SOCKS5 proxies, hung and garbled ones, a STUN responder, an openssl-made test CA).
29. `checkAtLaunch`, fail closed, refusal, status; row C-1 (C7). -> 27, 28
   Landed as: `daemon/network.mjs` `createNetwork` gains `notify`, `observationsFile` and, for
   tests, `probe`, `inBrowser`, `now`. `forLaunch` starts the helper's probes for a proxied
   session (`checkTargets(net)`; through the proxy with the auth file's credentials for an http: or
   https: proxy, and this computer's own exit only when the proxy has no `expectEgress`), so they
   run while the browser starts rather than before `launchEngine` as C6 (1) put it: an unreachable
   proxy still fails before any tab is adopted, at the cost of a window opened and closed.
   `checkAtLaunch(ctx, session, launch)` (section 3.2 step 6, right after the lost-screen check in
   `launch.mjs`, before `net.started()`, the page script, `api.adopt`, the `page` and `close`
   listeners and the restore, so the check tab never reaches tab memory or the strip) runs
   `checkInBrowser`, awaits the probes (bounded), and judges with `egressVerdict` and
   `webrtcVerdict`; it answers `{ ok: true }` (a direct session runs nothing) or `{ ok: false,
   refusal }` and never throws. The launch's state (its network, targets and probes) is kept with
   the handle `forLaunch` returned, not in the part, so a later `forLaunch` (a Settings test, a
   recheck, a probe launch) can't take it; a handle with no state (none, another session's, checked
   already) is refused, never passed unchecked. WebRTC is judged only in strict mode (decided here: without
   strict's policy a proxied browser always gathers this computer's srflx address, so C7 would make
   `strict: false` unusable); it is recorded either way. C7's "strict switches not applicable" has
   no check of its own: a browser that ignores them fails the WebRTC or egress verdict. On a failure
   `launch.mjs` closes the browser (bounded; the close handler isn't on yet, so it is no crash for
   the guard and no `onClosed`), drops the key files and throws the refusal: `Session "x" doesn't
   start: network "id" failed its check before any saved tab opened, so the browser closed.` plus
   the verdict's reason (never an exit address) and what to do. `refusal(session)` then holds the
   session's starts (`getContext` rejects with it, no launch) for `HOLD_MS` (60 s) or until
   `config.json` or `secrets.env` changes (their mtimes). The person is notified once per session
   and reason through the helper's `notify` (`panel.notify`: side panel or the system's); a
   message to the Phase B channels needs a new message kind and comes with step 31. Each check is
   appended to `sessionFile(name, "network.json")` (0600 via `writeJsonAtomic`, `OBSERVATIONS_MAX`
   50, memory only for a clean session; `observations(session)` reads it) in the observation
   file's shape, `dns` "strict" or "local", the direct exit never kept. `statusParts(session)`:
   the held refusal as a warning, else `network "id" (strict): exit checked at launch, country XX`;
   `context.statusParts` appends it to the supervisor's parts and `context.networkRefusal()` lets
   `pairbrowse_status` answer while a failure holds (a start that fails now is caught there too).
   `daemon.mjs` passes `notify`. Row C-1 landed without "egress change pauses agents" (step 31
   adds it) and names `test/net-browsercheck.test.mjs` and `test/net-refuse.test.mjs`;
   `test/integration/proxy.test.mjs` joins it when it exists. Tests: `test/net-refuse.test.mjs`
   (passing check and its record, direct, every C7 failure, strict-only WebRTC, hold, status and
   notification, clean sessions, through `createContext`, the wiring order), `test/net-launch.test.mjs`
   and `test/supervise.test.mjs` (updated pins).
30. NetLog leak tests (C12). -> 29
   Landed as: `testenv.mjs` `NETLOG`; `daemon/browser/launch.mjs` `withNetLog(options)` adds
   `--log-net-log=<paths.netlog>` (`paths.mjs` `netlog`, `<home>/netlog.json`, written anew each
   launch) after every other switch, only while the switch is kept (the gate removes it outside a
   harness-started helper; `browserArgs` can't ask for it, the allowlist has no such switch). The
   reader is test-only, `test/helpers/netlog.mjs`: `parseNetLog` (a file cut short by a killed
   browser read up to its last whole event), `resolvedHosts` (the `host` or `hostname` of every
   `HOST_RESOLVER_*` and `DNS_*` event, bare: no scheme, port or brackets) and `dnsLeaks(log, {
   proxyHost })` (everything but the proxy's host, loopback, `*.localhost` and `~notfound`).
   Found here: strict mode's rule doesn't stop the resolver from being asked, it changes the name
   first, so the NetLog shows requests for `~notfound` (the network quality estimator asks for each
   request's host), never the page's name; the reader counts that as no lookup. Without strict, an
   `http:` proxy session's browser looked up the page's own names and its background services'
   itself (the estimator, prefetch, updates), so strict mode is what keeps names off this computer's
   resolver, not the proxy alone (`docs/configuration.md` says so). The STUN server's name never
   showed in the NetLog either way: WebRTC's leak test stays the browser check's gathering (step 28,
   `test/integration/net-browsercheck.test.mjs`). `test/integration/proxy.test.mjs` starts here with
   the DNS leak test through an `http:` and a `socks5:` proxy in strict mode (the page, an image, a
   dns-prefetch, a preconnect, a prefetch, a WebSocket and a STUN server, names new each run; no
   leak, the page through the proxy) and its proof with strict off (the page's names leak); the rest
   of that file's Phase C cases come with their steps. The Docker opt-in half of C12 (a stub DNS
   server and a STUN responder on the direct network) needs the A13 container and lands with
   `test/optin/proxy-docker.test.mjs` in step 39b. Row C-1 names `test/netlog.test.mjs` and
   `test/integration/proxy.test.mjs`; the test-switch row (C-6) names the NetLog. Tests:
   `test/netlog.test.mjs`, `test/security.test.mjs` (`NETLOG`), `test/integration/proxy.test.mjs`.
31. Recheck, egress change, pause and notify through the B notifier (C8). -> 29, 16
   Landed as: `daemon/network.mjs` `createNetwork` gains `pause(who)`, `channels(message)` and, for
   tests, `recheckMs` and `timers`. A passing `checkAtLaunch` keeps what the rechecks need with the
   launch's handle (its network, targets, the auth the auth file held, the exit it read as baseline);
   the handle's `started()` arms them (no separate `start` in the part's answer), `stop(handle)` ends
   them: `launch.mjs` ties `ctx.once("close", () => network.stop(net))` on in the same statement as
   `started()` (a browser that crashes before the launch's own close handler is on still ends
   them) and stops them when the rest of the launch throws, always with its own handle, so an older
   browser closing late never ends the next one's; `recheck()` runs one now (tests). Every `recheckMinutes` (or the
   new test switch `RECHECK_MS`; timer unref'd) the helper's probe reads the exit through the same
   proxy with the launch's credentials, and this computer's own exit without `expectEgress`, bounded
   by the check's bound plus a second; decided here: no browser-side read on a recheck (it would open
   a tab in the person's window every time, and the browser's proxy can't change while it runs), so
   `egressVerdict` takes the helper's read for both and the stored baseline. A result that comes back
   after its browser closed is dropped. Each recheck is kept as `kind: "recheck"` with `browser` and
   `webrtc` `null`. `"changed"` moves the baseline (once per change); `"failed"` acts once per run of
   failures, again after a passing recheck. `onEgressChange`: `"pause"` calls `pause(RECHECK_PAUSER)`
   ("Proxy check"; `daemon.mjs` passes `pause.hold`: decided here, a hold of its own in
   `pause.mjs` that holds every agent as the shared Pause does but that `mirror` never clears, so in
   a session joined from here the host's next push can't undo it; a person's Resume here lifts it,
   `resume` or, joined, `resumeAgents` before the press goes to the host);
   `"notify"` tells only; `"ignore"` lets a change pass (logged and kept) but a failed recheck pauses
   as `"pause"` does (decided here: its `expectEgress` countries are what keeps a rotating exit in
   bounds). The person is told through `notify` (the side panel or the system's) and through
   `channels`, which `daemon.mjs` builds with `notify/index.mjs` `sendWhereHandoffsGo(config, {
   server, notifier })`: through the hand-off notifier only when `handoffSends` (decision 8: server
   mode, or Away), read at each send. New message kind `"network"` in `notify/message.mjs`:
   `{ kind, network, change, paused, at }` (`NETWORK_CHANGES` `changed`, `failed`), checked whole
   like the others, with its own title and text (`NETWORK_TITLES`); the webhook posts `{ event:
   "pairbrowse.network", network, change, paused, at }`. It names no session, address, country or
   reason. `statusParts` after a recheck: `last rechecked at HH:MM UTC`, or a warning for a failure
   or an acted-on change until a recheck passes. No audit line (the audit trail stays the hand-off's,
   B17). Row C-1 now has "egress change pauses agents" and names `test/net-recheck.test.mjs`; row B-3
   says what the network message carries; both name `test/integration/proxy.test.mjs`. Tests:
   `test/net-recheck.test.mjs` (with the launch's close and failure paths and the decision 8 gate
   run), `test/pause.test.mjs` (the hold), `test/notify-channels.test.mjs` (the message, each
   channel's request), `test/security.test.mjs` (`RECHECK_MS`), `test/integration/proxy.test.mjs`
   (an exit change pauses agents and notifies once, a person resumes; a proxy killed mid-session
   pauses them, said once, nothing around it).
32. Session rename and delete with network; strict sessions share frames (C4, C11).
   Landed as: `sessions.mjs` gains `networkFile(name)` (`sessionFile(name, "network.json")`) in one
   `SESSION_FILES` list that the rename moves, the deletion removes and `sessionFilesExist` checks
   (a stray `network.json` under the new name blocks a rename like the other files). The map entry:
   pure `net/config.mjs` `sessionMoved(network, from, to)` (to null: deleted) moves the session's
   own `network.sessions` entry to the new name in its place, whatever value it holds (a wrong one
   keeps refusing), and, decided here, drops an entry already under the new name, so a rename never
   changes which network the session uses; `null` when there is nothing to change or no map (a
   block that isn't an object refuses every session anyway). `sessions.mjs` writes it into
   `config.json` (`writeJsonAtomic` of the file's own object, every other key kept; not
   `saveConfig`, whose `configProblem` would refuse the move over an unrelated bad proxy entry)
   before any file moves, and puts the block back if a move fails. Decided here: a `config.json`
   that is there but can't be read or parsed stops a kept session's rename and deletion with one
   sentence (`Session "x" wasn't renamed: config.json isn't valid JSON ...`), nothing changed and
   the file never rewritten, since a rename without its entry could start the session direct and a
   deletion that kept it would pass its choice to the next session of that name; a clean session's
   deletion (at a switch, at startup) leaves the map alone and never fails on it.
   `pairbrowse_session delete` answers that sentence as its error. C11:
   `daemon/screenshare.mjs` `createScreenShare` takes `strict()` (`daemon.mjs` passes
   `context.networkStrict()`, new in `context.mjs`, from `network.strict()`); while it is true
   `available()` is false (a strict state that can't be read counts as strict), `offer` throws
   `NoDirect`, and the new `strict()` lets `liveview.mjs` answer `want` with `route: "frames"` and
   `STRICT_SHARE` and `sharing.mjs` word the invite. On the joiner's side `follow.mjs` passes
   `strict` to `join/screens.mjs` `createJoinScreens`: a strict session's picture pages take the
   slower route from their first round, never asking `want`, and let go of a direct connection
   asked for before. The frames go through the join channel, the helper's own traffic (section
   3.3). Row C-3 landed in the shared-browser row of `docs/security.md`; row C-1 says what a rename
   and deletion do and names `test/sessions.test.mjs` and `test/net-config.test.mjs`. Tests:
   `test/sessions.test.mjs` (moves, the map, a broken `config.json`, a failed move put back),
   `test/net-config.test.mjs` (`sessionMoved`), `test/screenshare.test.mjs` (host and joiner, the
   wiring), `test/liveview.test.mjs` (`want` while strict), `test/net-refuse.test.mjs`
   (`context.networkStrict`).
32b. Settings "Network" section and owner routes: add, edit, test, remove a proxy, default and
    per-session choice, write-only password, test result with exit country and coherence warning;
    tests in `test/ui-settings.test.mjs` and `test/liveview-network-routes.test.mjs` (C14). -> 24, 29, 32
   Landed as: `scripts/net/settings.mjs` (pure): `networkSummary(raw, { sessions, values, problem })`
   (proxies with `username` and `password` true when saved, never the values, and a proxy's own
   problem; the default; each kept session's choice `default`, `direct` or `proxy`; clean sessions
   never listed), `readProxyForm` (id, type `http`/`https`/`socks5`, host, port, `auth`, credentials
   4 to 4096 characters, one line; written back through `parseServer`, so user info, paths and SOCKS4
   are refused as in config.json; SOCKS5 with `auth` refused with `SOCKS5_AUTH_REFUSAL`, the U4
   clause `net/config.mjs` `SOCKS5_AUTH` now also uses), `readNetworkOp` (each op's own fields only)
   and `networkChange(raw, op, { values })` (`add`, `edit`, `remove`, `default`, `session` ->
   `{ network, set, remove, text }` or `{ error }`): an edit keeps the fields Settings doesn't show
   (`bypass`, `expectEgress`, `onEgressChange`); a credential left empty keeps the saved one;
   `auth` off (or a removal) deletes both; decided here, a proxy still named by `default` or a
   session is not removed (its sessions would refuse to start, and quietly turning them direct
   would break C7's spirit); a block with a top-level problem, or a change that leaves the edited
   entry or the block with one (`checkNetwork`), is refused whole. `scripts/liveview/network.mjs`
   `createNetworkSettings({ configFile, secrets, sessions, locale, probe, log })` reads
   `config.json` as written (one that can't be parsed: nothing written, as `saveConfig`) and replaces
   only its `network` with `writeJsonAtomic` (not `saveConfig`, whose schema check would refuse a
   change over an unrelated proxy's problem); credentials go through the helper's secret store
   (`setReservedSecret`, `deleteSecret`, `secretStore.save`), set before the config write and
   deleted after it, so masking (`logfile.mjs` `maskWith`) has them at once. `test(op)` (one at a
   time) probes through the form's proxy with the typed or saved credentials (used for that probe
   only) and, without `expectEgress`, this computer's exit, judged by `egressVerdict` with the
   helper's read for both sides; it answers `{ verdict, reason, exit: { ip, country }, sameAsDirect,
   coherence, locale, note }` and logs only that it ran and its verdict. Decided here: the coherence
   input is `localeOf(config, { native })`: the native build's `pairbrowse.timezone` and
   `acceptLanguage` when it is the browser chosen, else this computer's (Intl); nothing with
   `geoip`, which follows the exit; per-profile locale comes with Phase D. `scripts/rules/coherence.mjs`
   lands `localeVsEgress` (`locale.timezone-vs-egress`, error; `locale.language-vs-egress`, warning,
   from the languages' region subtags only) and `scripts/rules/tzcountry.mjs` (`countriesOf`, from
   `scripts/dev/tzcountry.mjs`); step 43 adds the other E13 rules and wires them into D, C verdicts
   and B. Routes `scripts/liveview/routes/network.mjs`: `GET network.json` and `POST network`
   (bodies up to `BODY_MAX.profile`), the new owner-only right `network` (`invites.mjs` RIGHTS), the
   new `network` event (owner streams, `ui/events.js`) with the summary after each change; Test
   answers in its reply only. `createSettings` takes `secrets` (`daemon.mjs` passes the store on
   its existing line) and answers `network`; `startLiveView` mounts its routes from
   `settings.network`. UI: `ui/network.js` `networkPanel(root, base, { shown })` (flat, re-exported
   by `common.js`, served to the live view): rows with Edit, Test and Remove (asked in the row), the
   add/edit form (the password field `type=password`, emptied after every save or test), the test
   result (exit, country, leak line, coherence items, what a session's start checks), the default and
   each session's choice; Settings gets a `Network` section and nav link, shown once the helper
   answers `network.json` (Enter in the search now skips items in hidden sections); the live view's
   Profile drawer gets the same panel. Tests: `test/liveview-network-routes.test.mjs`,
   `test/ui-settings.test.mjs` (14), `test/coherence.test.mjs`, `test/liveview.test.mjs` (the asset).
33. `profiles/schema.mjs`, `upgrade.mjs` (D19). -> 12
   Landed as (ahead of step 12, which it does not need: the record's `persona.source` is already
   `"seed" | "host"`): `scripts/profiles/schema.mjs` (pure) `SCHEMA_VERSION = 1`, `FORMAT_VERSION = 1`,
   `EXPORT_FORMAT`, `PROFILE_SCHEMA` in `config-schema.mjs`'s spec format (its `fits` and `expected`)
   plus `pattern`, `maxLength`, `each`, `maxItems`, `maxJson` and `entries`, and
   `checkProfile(raw)` answering `{ profile, problems }`: strict, unlike `config.json` (any unknown
   key, wrong or missing value, or broken cross-field rule refuses the whole record, every problem
   named by its key; numbers, booleans and null are repeated, strings never, so a credential in the
   wrong field never reaches a message). Every key of the design's record is required; "not set" is
   `null`: `engine` (never launched on the native build), `screen` and `window` (this computer's,
   E7), `display.colorScheme` and `reducedMotion`, `locale.languages` and `timezone`; in
   `validation[build]` only `runtimeKey` and `graphics` may be left out. Ranges: screen and window
   320 to 16384, DPR 0.5 to 5, color depth 16, 24, 30 or 32, up to 10 languages (checked by
   `Intl.getCanonicalLocales`), a time zone `Intl` knows, a seed of up to 128 letters, digits, `-`
   and `_` (never `off`), `history` up to `HISTORY_MAX` (1000) entries, `provenance` up to 50,
   `validation[build].graphics` up to 20000 characters as JSON. `history[].by` is `person`, `config`
   (D5's `configHash` change), `migration` or `upgrade`. Cross-field: avail within the screen,
   `engine.build` of `engine.major`, kind `config` only for `default` and no store profile named
   `default` (any case), no provenance on `default`, no seed with `persona.source: "host"`, no
   history entry after the record's revision. D6's names (`FORBIDDEN_KEYS`: paths, extensions,
   proxy servers and credentials, launch options, agent options, `canvasBridge`, hardware values)
   are refused at any depth with the reason; only `graphics.require` holds `webgl` and `webgpu`, as
   requirements. `profileDefaults()` gives a new record's settings (the store adds identity). Left
   to step 35: `license` as the most restrictive in `provenance`. `scripts/profiles/upgrade.mjs`
   (pure): `RECORD_STEPS` and `EXPORT_STEPS` (frozen, empty until a version 2), `chainGaps`,
   `upgradeProfile(raw, { at })` answering `{ profile, from, upgraded, problems }` (a newer schema
   refused naming both versions, never rewritten; each step on a copy; history kept through every
   step and one `{ revision, at, change: ["schema"], by: "upgrade" }` entry added without a new
   revision; the result through `checkProfile`), `upgradeExport(raw)` for `formatVersion` (run after
   import checks the file's SHA-256 as written). Both take `steps` and `current` for tests. Tests:
   `test/profile-schema.test.mjs`, `test/profile-upgrade.test.mjs`, fixture
   `test/fixtures/profiles/record-1.json`. "profileSelect is closed" stays with step 12.
34. `profiles/store.mjs`, paths and config keys (D4, D5). -> 33
   Landed as: `paths.browserProfiles`, `paths.engineProfiles` (home) and `paths.identityLocks`
   (shared home); `requireValidatedProfiles` (default false) in `DEFAULT_CONFIG` and the schema,
   read from step 37 on. `scripts/profiles/store.mjs` `createProfileStore({ dir, now, randomId,
   assignedTo })`: `list` (the default first, then by name; a file that can't be read listed with its
   problem), `get` (by id or name, names case-insensitively), `use(ref, { session, configSettings })`
   (what assignment and launch call: unknown, retired, unreadable or newer refused naming the session
   and profile, each only when it is an id or a plain name, else "(that name)", never falling back to
   `default`; for the default, `configSettings` (`fromConfig(config)`) answers `configProfile`'s
   whole record, and without it only the stored part marked `settings: "config.json"`, which is no
   record to launch), `create` (settings and an import's `provenance` and `license`; anything else
   refused by name; a name is unique case-insensitively, never `default` and never shaped like a
   profile id), `update(ref, fields, { expectRevision })` (name and
   settings only, object settings merged one level, nothing differing writes nothing, history entry
   naming the changed field paths), `retire`, `restore`, `remove` (refused while `assignedTo(id)`
   names sessions: step 36 passes `sessions.mjs`'s), and, for D4's revisions and the "history
   offered" of a corrupt file, `revisions`, `revision(ref, n)` and `revert(id, n)` (also when the
   current file can't be read; the unusable file is copied aside first and the new revision lands
   above the lost one: its own number plus one when it parses, else two past the highest kept, so a
   writer still holding it is stale; a name another profile took meanwhile is refused). Each write runs under
   `install-lock.mjs`'s sync lock on `browser-profiles/.lock` (which gained a `what` for its
   refusal); the file as it was is kept as `<id>.history/<revision>.json` before the next takes its
   place (an upgraded older record is thus written at its next change, its old file kept), revision
   files past `HISTORY_MAX` pruned. Records are read only from regular files (a link refused) through
   `upgradeProfile`. D5: the default's file holds `{ schema, id, name, kind: "config", revision,
   status, created, engine, validation, history, configHash, sections }` (the SHA-256 of the
   settings' canonical JSON, and 16 hex digits per settings section so the history entry, by
   `config`, names the sections that changed); `configProfile(settings)` (step 36 passes
   `fromConfig(config)`) makes it at revision 1, bumps it on a changed hash and answers the whole
   checked record; it makes one only when no file in `browser-profiles/` holds `kind: "config"`: one
   that does but can't be used (newer, PROFILE_NEWER; invalid), or a file that can't be read at all,
   refuses naming that file (D19: never rewritten, and the default's id, history and sessions kept); it has no revision files (its settings were never stored). Moved to step 38:
   setting `PAIRBROWSE_ENGINE_PROFILE_DIR`, `PAIRBROWSE_ENGINE_PROFILE_SOURCE` and
   `PAIRBROWSE_ENGINE_CACHE` (D4), which must follow the migration's copy of `~/.pairbrowse-engine`
   into `engine-profiles/` or saved personas would be left behind. Tests: `test/profile-store.test.mjs`.
35. `profiles/device.mjs`, `import.mjs` (settings only, hardware unsupported), `export.mjs` (D-AP2,
    D15 to D18). -> 34
   Landed as: `scripts/profiles/device.mjs` (pure): `DEVICE_SECTIONS`, the collector's top-level
   sections each with its section 9 class, what an import does with it and the engine patch the
   property matrix names (`140` screen, `002` persona hardware, `040` fonts, `146` memory, `147`
   codecs, `961` WebGPU); `classifySection`, `fieldReport(format, raw)`, `deviceSettings` and
   `personaSettings` (`PERSONA_APPLIED`; GPU, cores, memory, touch points, platform, library
   profiles, WebRTC address, location, proxy, canvas bridge and every D6 name `unsupported`,
   `platformVersion`/`brand`/`brandVersion` `derived`, other engine options `not-applied`). Items
   take D10's shape with `field` naming the file's own key and `requested` set only on applied
   values. A screen with only a width and height takes the whole screen as available, depth 24 and
   ratio 1, each reported `derived`; languages are deduplicated and the first ten kept (the rest
   reported); a persona's Accept-Language loses its weights, a numeric seed becomes its string.
   `scripts/profiles/import.mjs`: `checkImport(bytes, host)` (pure; host `{ file, at, source,
   license, terms, name }`) runs `IMPORT_CHECKS` in order: `size` (1 MiB, before parsing), `json`
   (fatal UTF-8, `JSON.parse`), `shape` (an object, at most 32 deep, checked without recursion),
   `format` (`detectFormat`: `format` key, else a `navigator` object, else an `options` object;
   both refused as ambiguous), `integrity` (an export's `sha256` over the canonical JSON of the rest,
   so a reformatted file passes and an edited one fails), `version` (`upgradeExport`, or
   `meta.schema_version`), `fields` (an export's `profile` holds only `name`, the settings and
   `history`; the settings read are checked as the whole record the store will make), `provenance`.
   The first failing check refuses with "Import of "<file>" refused at the <check> check: ..." and the
   field report without values. Coherence (`rules/coherence.mjs` `screenBelievable`, landed here
   rather than with step 43: aspect over 3.6, available area under half, over 16384 device pixels a
   side, a ratio off the 0.25 steps) only warns, as `mismatch` items. Provenance: from a PairBrowse
   export the file's license and a source naming the export's version (a different `--license`
   refused naming the file's), the export's own sources kept before the new entry (at most 50 in
   all); from a device or persona file `source` and `license` are the person's and required.
   `license: "unknown"` imports with `unverified: true` and a warning item; the launch warning comes
   with step 37, which reads the record's `license`. Network ids in an export are reported and never
   applied; an export's `history` is reported and not applied (the new profile starts its own).
   `importInto(store, bytes, host)` (with `dryRun`, which writes nothing) writes through
   `store.create`, naming the profile from the file (cleaned; `-imported` added to `default` or an
   id-shaped name; `-2`, `-3` when taken) unless the person names it; `readImportFile` opens one
   regular file with `O_NOFOLLOW` and checks its size by `fstat` before reading at most 1 MiB plus one
   byte; `importFile` joins them. `scripts/profiles/export.mjs`: `exportProfile(record, {
   withHistory, includeIdentity, at, version })` and `exportToFile` (0600, never over a link or
   folder, an existing file only with `overwrite`); the export's `profile` is the name and settings
   with `network` null and the seed null unless asked; `license` is the most restrictive of the
   sources and the record's own. `scripts/profiles/schema.mjs` gained `SETTINGS` (moved from the
   store), `canonicalJson` (moved too), `licenseRank` and `mostRestrictive` (unknown, then any id not
   listed, AGPL/SSPL, CC-BY-NC, GPL, share-alike and no-derivatives, LGPL, weak copyleft,
   attribution, permissive, public domain, own-capture; `OR` takes the least, `AND` the most), a
   cross-field rule that a record's `license` is never looser than its provenance's most
   restrictive, and `forbiddenWhy`. Tests: `test/profile-import.test.mjs`,
   `test/profile-export.test.mjs`, `test/fuzz/profile-import.test.js` (every file system read
   throws while `checkImport` runs), `test/coherence.test.mjs`, `test/profile-schema.test.mjs`;
   fixtures `test/fixtures/profiles/engine-device-1.json` and `engine-persona.json` (hand-written).
36. `profiles/map.mjs`; session assignment in `sessions.mjs` (D1, D6, D11, D12). -> 34, 24
   Landed as: `scripts/profiles/map.mjs` (pure). `readConfig(config, { native, platform })` answers
   `{ settings, items }` and `fromConfig` its settings, for the store's `configProfile`: `browser.kind`
   by `browserKindOf` (browser/choice.mjs's reading, repeated so the module loads nothing with side
   effects; a path is the open build, named); from the screened `browserArgs` `--lang` (`_` read as
   `-`), `--window-size`, `--force-dark-mode`, `--force-prefers-reduced-motion`, `--disable-gpu`
   (as `graphics.backend: "software"`; `--use-gl`/`--use-angle` named and left as written), a switch
   given twice with different values not read; from the `pairbrowse` block, only when config starts
   the native build (the open build never read it), `acceptLanguage` (over `--lang`; weights and
   repeats dropped, ten kept), `timezone`, `geoip` (`locale.source: "geoip"`), the screen keys (a
   width and a height make one; avail, depth 24 and the ratio, else `--force-device-scale-factor`,
   else 1, filled in), `fingerprint` (a whole number as its string), `profile` `"auto"`/`"local"`
   as D9's host (macOS) or seed persona. Every other block key is an item (hardware U6 `unsupported`,
   `fingerprintProfile`, `profileSelect`, helper-wide and other engine keys `not-applied`); a
   setting whose value doesn't make a valid record is left at its default with a warning naming it;
   `network` is always `null` and `payments.savedCard` false, so a network change never bumps the
   default's revision. Items repeat no value from config.json. `toLaunch(profile, { browserKind,
   platform })` checks the record and answers `{ switches, engineKeys, prefs, geoip, network,
   adBlocker, results, problem }`: switches only from `SWITCHES` (`lang`, `window-size`,
   `force-dark-mode`, `force-prefers-reduced-motion`, `disable-gpu`), screened again as the launch
   screens `browserArgs`; engine keys only from `ENGINE_KEYS` (`acceptLanguage`, `timezone`, the
   six screen keys, `fingerprint`), native build only; `prefs` empty until step 45; `network` the
   id for `networkFor`'s `profileNetwork`. D11 refusals (`problem` naming the profile and each
   field, nothing to launch with): a profile for the other browser (`mismatch`); on the open build a
   time zone, screen, seed, geoip or a first language `--lang` doesn't take; on either a light
   scheme or `reducedMotion: false` (no switch forces either; `null` follows the computer),
   `graphics.backend: "gpu"` and `graphics.require` (unchecked until Phase E replaces this), a saved
   card (step 45). The open build sends only the first language, the rest a warning item. Unset
   locale, screen and seed are `derived` items, and the record is never changed (D12). `store.use`
   now makes the config-backed default from `configSettings` when it was never made. `sessions.mjs`:
   `assignmentFile` (`assignment.json` beside the session's files, in the rename and delete
   lists), `readAssignment(name)` `{ ref, profileId, problem }` (no file: `ref` `"default"`, as every
   session before profiles; a link, folder, non-JSON (copied aside) or anything but `{ profileId }`
   a problem, never the default), `assignProfile(name, ref, { store, configSettings })` (the store's
   `use` refuses unknown and retired by name; the id written 0600; the binding rewrite joins it in
   step 37), `createSession(name, profileId, { store, configSettings })` (`profileId` left out:
   no choice, as every launch calls it; given, `"default"` in any case included, it is a choice: only a
   session this call makes is assigned; a session that was there already is refused any profile but
   its own (unassigned, `"default"`), never reassigned; a new folder removed when refused), `assignedTo(profileId)` for the store's `remove`. Tests: `test/profile-map.test.mjs`,
   `test/sessions.test.mjs`, `test/profile-store.test.mjs`, `test/fuzz/profile-schema.test.js`.
   D12's launch half landed at the Phase D gate (F4, F7): `native-engine.mjs` `DERIVED_FIELDS`
   (`platform`, `brandVersion`, `timezone`, `acceptLanguage`) are worked out at each launch when no
   setting gives them and never kept in the persona (`savePersona`); one an older version kept
   there is not read (`readSettings`), so a build update in the same major launches with its own
   version and a copied persona brings no platform along; config.json's legacy `platform` and
   `brandVersion` (U6) still apply. Languages: a setting's (the profile's `locale.languages` as
   `acceptLanguage`, config.json's) first, else the `navigator.languages` of a device profile a
   setting gives (never this Mac's capture or one kept from before), else this computer's `Intl`.
   Tests: "in-major update keeps no old brandVersion" and "profile languages reach --accept-lang"
   (the real pack's `--accept-lang` when `PAIRBROWSE_TEST_ENGINE` is set), replacing "F4 today"
   and "F7 today".
37. `daemon/sessions/profiles.mjs`, binding, persona under the profile id, launch wiring (D2, D10,
    D13). -> 36, 27
   Landed as: `scripts/daemon/sessions/profiles.mjs` `createProfiles(st, deps)` (deps `config`, `log`,
   `profileStore`: `createContext`'s new dep, the home's own store when null; tests pass `now` and
   `platform`), made by `context.mjs` as `api.profiles` (the `ALLOWED` edge `context ->
   sessions/profiles`; `daemon.mjs` passes nothing new). `forLaunch(session, { browserKind, build,
   pack })`: `readAssignment` (a problem refuses), `store.use` with `fromConfig(config, { native })`
   (unknown, retired, unreadable refused by name), the binding (`sessions.mjs` `readBinding`: a link,
   non-JSON (copied aside) or anything but `{ profileId, created }` refuses; another profile's id
   refuses naming both; none: written 0600 once every check passed, a write that fails refuses), D10
   (`build` the native build's manifest version: `record.engine` of another major refuses "re-validate
   the profile on this build or migrate it", except for the config-backed `default`, which until step
   38 started `unverified` with a log line, its pin kept (step 38 holds it to the new build at that start instead); the status is `validation[build].status`, else
   `unverified`, so another build of the same major is unverified), `toLaunch` (its `problem`
   refuses), `requireValidatedProfiles` (anything but `validated`, or a validated entry with an
   error item, refuses; the open build is never validated, so it always refuses there). Then
   `store.recordLaunch(id, { engine, build, entry })` (new in `store.mjs`): `engine` set once (null
   before), `validation[build]` the launch's `{ status: "unverified", at, pack, items }` (`pack`
   `NATIVE.engine.sha256`), written only when there is none or an unverified one with other items,
   a validated or failed (measured) entry left as it is; no revision, no history entry; a record of an
   older schema waits for its next change; the default's stub takes it too. A failed record is
   logged, never a refusal. Answers `{ id, name, kind, revision, status, build, switches, network,
   adBlocker, results, warnings, engine: { id, kind, geoip, engineKeys } }`; `license: "unknown"`
   warns in the log at every launch and in the status part. `statusParts()`: `Profile: <name> (rev
   <n>, <status> on <build>)` (`the open build` there), placed by `context.statusParts` after the
   supervisor's and before the network's; `release()` forgets it (the close handler of the browser in
   use, and every failed launch; the identity lock joins it in step 38); `list()` the store's. Wiring
   in `launch.mjs`: `forLaunch` right after `ensureScreen` and `createSession`, before the key
   files and before `prepareProfile` (moved after it, so the profile's `adBlocker`, else
   `config.adBlocker`, reaches the preferences; a refused profile writes no preference);
   `network.forLaunch(..., { profileNetwork })`; `launchOptions(..., { profileArgs })`
   (`browser.mjs` `launchArgs`: the profile's switches screened as `browserArgs` are and placed after
   them, a profile `--window-size` taking the fixed size's place, the virtual screen's position kept);
   `launchEngine` gets `{ ...next, browserProfile: chosen.engine }`. `native-engine.mjs`
   `readSettings`: the profile's `engineKeys` (only `map.mjs` `ENGINE_KEYS`) over config.json's;
   for a store profile config.json's own `ENGINE_KEYS`, `fingerprintProfile`, `geoip`, `profile`
   and `profileSelect` are not read (the U6 hardware keys still are); the persisted persona must be
   named the profile's id, or "pairbrowse" (`LEGACY_PERSONA`) for the config-backed default only,
   else `personaBindingRefusal`; `savePersona` saves under the id ("pairbrowse" without a profile:
   the install self-check). `sessions.mjs`: `BINDING_FILE`, `bindingFile`, `readBinding`,
   `writeBinding`, `PERSONA_FILE`, `LEGACY_PERSONA`, `personaFile`, `personaNameOf`;
   `assignProfile` now rewrites the binding with the assignment (a binding write that fails puts the
   assignment back) and removes a persona named for another profile (the default keeps a legacy one
   of a session never bound elsewhere), so a reassigned session starts. D2 needed no code: one
   browser per helper and its one `st.profile`. Until step 38 (`cli.mjs validate`, `migrate`) there is
   no way to clear an engine pin, so a native build of a new major refuses store profiles pinned to
   the old one until then; the `default` is let through (above) so a desktop user is never locked
   out, and step 38 re-pins it at that start (below). Release
   gate: no version bump ships a native build of a new major before step 38. Tests: `test/session-profiles.test.mjs`, `test/profile-store.test.mjs`,
   `test/native-engine.test.mjs`, `test/browser-args.test.mjs`, `test/net-launch.test.mjs`,
   `test/supervise.test.mjs`, `test/structure.test.mjs`.
38. Identity lock, migration and undo, `pairbrowse_session` `profile`, CLI, owner routes and UI (D3,
    D14, Phase D migration). -> 37
   Landed as: `scripts/profiles/lock.mjs` `takeIdentity(seed, { session, profileId, name }, { dir })`
   (D3): one file per pinned seed in `paths.identityLocks` (0700), `<sha256(seed)>.lock` (0600, the
   seed never written) holding `{ pid, start, token, session, profileId, instance, at }`, linked into
   place from a file of its own so a reader never sees half of one; a live holder refuses naming its
   session, instance and process (`PROFILE_IDENTITY_HELD`); a gone one (pid dead, or `startOf` differs)
   or a lock file that is empty, cut short or unreadable (`{ pid: 0 }`, `install-lock.mjs`
   `readHolder`'s rule) is moved aside atomically and taken over; no time-out (a browser runs for weeks while its helper
   lives); this process's own hold for the same session and profile is taken again, for another
   session refused; every hold given back at process exit. `forLaunch` takes it after every other
   check and before the binding write (a failed write gives it back); `release()` gives it back.
   `scripts/profiles/migrate.mjs`: `migrationReport` (step 1; a saved persona `pairbrowse.profile`
   names is checked by a dry-run `checkImport` from `~/.pairbrowse-engine/profiles/<name>.json`,
   never imported), `migrate` (steps 2 to 4; each change recorded with the file as it was, base64,
   in `browser-profiles/migration.json`; any failure puts back everything done so far), and
   `ensureMigrated` (under `paths.profileMigrationLock`, once per home, then `applyEngineEnv`:
   `PAIRBROWSE_ENGINE_PROFILE_DIR` = `engine-profiles/profiles`, `PAIRBROWSE_ENGINE_PROFILE_SOURCE` =
   `engine-profiles/source` (empty, 0700), `PAIRBROWSE_ENGINE_CACHE` = `engine-profiles/cache`, set
   in the helper's own `process.env` before the pack loads; a failed migration sets none, so the pack
   keeps its own folders). `createProfiles` runs it from `prepare({ native })`, which `launch.mjs` `chooseEngine` calls
   before `ensureNative` (an install's `selfCheck` loads the pack in the helper's process, and the
   pack reads those variables once, when it loads), and again harmlessly from `forLaunch`, in the
   helper's own home (a part given a `profileStore`, as tests do, never migrates; tests pass `env`
   and `migrateHome`; `createLaunch` takes `ensureNativeBuild` for the order test); a failure is a log and status
   warning and the launch runs on step 37's path. The note left by the copy is `COPIED-FROM.txt` in
   `engine-profiles/` (the original folder is never written to); links inside it are not copied.
   Sessions already assigned keep their profile; a session whose assignment or binding can't be read
   is listed and left as it is. Status names the keys kept out of `default` (`migrationNote`) until
   `cli.mjs migrate --dismiss`. `migrateLocked` (the lock and record check `ensureMigrated` and `cli.mjs migrate` both use).
   `undoMigration`: refused while `daemon.lock` names a live helper;
   every store profile exported to `paths.profileExports` with history and pinned seed first (a
   profile that can't be read stops it, nothing removed); each session file the migration wrote and
   still finds as written is put back byte for byte, other assignment and binding files removed, a
   persona under the default's id renamed back to "pairbrowse", one under another profile's id
   removed (its seed never becomes the default's); a session whose file can't be read or written
   is listed in `notRestored` and the others go on; then `browser-profiles/` and `engine-profiles/`
   removed, unless a session wasn't put back (both kept so it still finds its profile; `cli.mjs`
   exits 1 naming it, and a second undo finishes). `paths.mjs`: `profileMigration`, `profileMigrationLock`, `profileExports`,
   `legacyEngine` (`~/.pairbrowse-engine`; inside the home under the test runner). D10 for the
   default (decided at step 38's review, open for the user to reverse): not refused on a new major;
   its launch holds it to the new build itself (`store.repin(..., { by: "config" })`, a history
   entry by "config", a log line), since its settings are config.json's, mapped and refused by the
   same `toLaunch` at every launch, so the person's check would add nothing, and on a desktop the
   sessions page's Check is in the browser that didn't start; still `unverified`, so
   `requireValidatedProfiles` refuses it. A store profile's refusal names `cli.mjs validate` by
   its full path (`validate.mjs` `cliCommand`, from `import.meta.url`), as the migration note does. `scripts/profiles/validate.mjs`
   `validateProfile(store, ref, { build, pack, configSettings })`: `toLaunch` for the native build
   (a refusal names the field), then `store.repin(id, { engine, build, entry })` (new in `store.mjs`:
   the engine replaced, `validation[build]` the check's `unverified` entry unless measured evidence is
   there, a history entry `change: ["engine"]` at the same revision, no new revision); the status
   stays `unverified` (E6), so `requireValidatedProfiles` still refuses; `installedBuild(config)` reads
   the build the launch would pick. `pairbrowse_session`: action `profiles` (names, kinds, retired;
   never a setting) and `profile` with `new` (`createSession(target, profile, ...)`; with any other
   action refused); `refuse.mjs` lets `profiles` through while others use the browser, as `list`.
   `scripts/profiles/cli.mjs` `runProfilesCli`: `list`, `show`, `create --settings <json>`, `edit
   --settings --name --revision`, `retire`, `restore`, `assign` (refused for a clean session or one a
   browser has open), `import [--dry-run] [--source] [--license] [--terms] [--name]`, `export [<file>]
   [--with-history] [--include-identity] [--overwrite]` (default file under `profile-exports/`),
   `validate [<profile>]` (every active one), `migrate [--report | --undo | --dismiss]`. Owner routes
   in `scripts/liveview/routes/profiles.mjs` (not `routes/sessions.mjs`; the "session" right):
   `GET profiles.json`, `POST profiles` (`assign`, `validate`), `POST profile-import` (the file's bytes
   as the body through `http.mjs` `readBytesCapped`, 413 past `BODY_MAX.profileFile` = 1 MiB by
   Content-Length or as it grows; source, license, name and dryRun in the query), `GET profile-export`
   (JSON `{ fileName, text, sha256, warnings }`, saved by the page); handled by
   `scripts/daemon/sessions/profile-owner.mjs` (`context.profileOps`, through `sessionOps.profiles`):
   the open session, a clean one or one another browser has open is never reassigned. `ui/sessions/`:
   a Browser profiles section (Check, Export, Use for this session, Import a profile file), hidden on
   a helper without the route. Tests: `test/profile-lock.test.mjs`, `test/profile-migrate.test.mjs`,
   `test/profile-cli.test.mjs`, `test/session-profiles.test.mjs`, `test/context-switch.test.mjs`,
   `test/session-route.test.mjs`, `test/ui-sessions.test.mjs`, `test/structure.test.mjs`; live:
   `test/integration/profiles-persistence.test.mjs`, `profiles-migration.test.mjs` ("the previous
   layout" is the session's folder opened directly by the driver after the undo, as a PairBrowse
   from before profiles opens it), `profiles-isolation.test.mjs`, `profiles-instances.test.mjs`
   (two instances under a test account folder, one browser at a time; "one session can't open in two
   browsers": a second helper on the instance leaves, and reassigning the open session is refused);
   opt-in `test/optin/profiles-native.test.mjs`, which also holds "the same pinned seed is refused in
   the second" (the open build can't apply a seed, so only the native build reaches the identity lock).
39. Spike E-S1: `SystemInfo`, software switches, Linux WebGPU, fixtures; lands the A13 container
    harness `test/optin/server/container.mjs`, its first user. -> 8
    Landed as: `test/optin/server/container.mjs` (`dockerfile`, `imageTag`, `seccompProfile`,
    `runArgs`, `startContainer`): an image built once per recipe from `node:22-bookworm` (Xvfb,
    xauth, fontconfig and Latin, CJK and emoji fonts, Mesa GL, EGL and Vulkan drivers, the build's
    libraries, user `pb` uid 1001), run `--platform linux/amd64` (the Linux build is x64 only; on
    Apple Silicon under emulation) with its own test seccomp profile (a deny list: every call allowed
    but a fixed list no browser needs: `mount`, `ptrace`, `setns`, `bpf`, `io_uring_*`, kernel
    modules, keys, clocks, reboot; looser than Docker's default allow list for unlisted calls, so
    `docs/configuration.md` recommends Docker's default with only its namespace rules relaxed), every
    capability dropped, `no-new-privileges`, the label-based removal, the watcher and the two-hour
    `--rm` lifetime of `two-machines`. `test/optin/server/graphics-measure.mjs` runs on the measured
    machine: the pinned build installed by `native/install.mjs` `ensureNative` (SHA-256, manifest,
    self-check, in server mode), then for each candidate and both persona modes (today's; the E2
    Linux plan) a `launchEngine` launch as the helper's, `SystemInfo.getInfo` on
    `newBrowserCDPSession()` (answered on both platforms), a page probe in bounded parts (WebGL,
    WebGL2, WebGPU adapter, a device with the reported limits, one compute round trip, navigator)
    and the engine's sandbox page, scrubbed by `scrub.mjs` (no command line beyond its graphics
    switches, no paths, no `modelVersion`). `test/optin/graphics-spike.test.mjs` (gates `DOCKER`,
    `EXECUTABLE`, `ENGINE`, `FIXTURES`) writes `test/fixtures/systeminfo-{macos-metal,
    linux-xvfb-llvmpipe, linux-xvfb-swiftshader, linux-xvfb-lavapipe, linux-disable-gpu}.json` and
    `probe-{macos-metal, linux-llvmpipe-persona, linux-llvmpipe-real, linux-swiftshader-real,
    linux-webgpu-fallback-real, linux-disable-gpu}.json`; unit tests `test/server-container.test.mjs`,
    `test/graphics-fixtures.test.mjs`. Findings: software switches as in E2. SystemInfo fields
    for E3: `gpu.devices[]` (vendor and device IDs and strings, driver), `auxAttributes`
    (`glRenderer`, `glImplementationParts`, `displayType`, `sandboxed`, `inProcessGpu`),
    `featureStatus` (`webgl`, `webgpu`, `vulkan`, `rasterization`, ... with `disabled_off` under
    `--disable-gpu`), `videoDecoding`, `videoEncoding`. WebGPU on Linux: no adapter without
    `--enable-unsafe-webgpu`; with it a SwiftShader fallback adapter (`isFallbackAdapter: true`,
    compute works); on both platforms `requestDevice` with the reported limits fails (Linux
    `maxComputeInvocationsPerWorkgroup` 1024 reported, 256 supported; macOS
    `maxStorageBuffersPerShaderStage` 16 reported, 10 supported), the persona limits table of E10, so the `webgpu.device` error is
    real until 961. Sandbox: on in every launch, no `--no-sandbox`; the engine's page shows the
    namespace layer (user, PID and network namespaces) under the container's profile, and
    seccomp-BPF "No" on this Mac only because x64 emulation refuses every seccomp filter (Docker's
    default profile too; a native arm64 container installs one under the same profile), so the
    test requires the page for every Linux launch whose page answered (a missing or timed-out page
    fails it), seccomp-BPF on it only on an x64 host (not yet run there, so seccomp-BPF under this
    setup is unconfirmed), and E6's `sandbox.on` rule reads that page on Linux, not only the
    launch's choice. The macOS build has no such page: the macOS half skips it (`"not on macOS"`).
    The `--use-angle=vulkan` rejection is pinned: both `linux-mesa-vulkan-*` launches report
    `angle=vulkan` with WebGL and WebGL2 unanswered. `auxAttributes.sandboxed` (the GPU process) is
    true on macOS and false on every Linux path measured here, to recheck on an x64 host before E6
    counts it.
39b. The Docker half of C12: `test/optin/proxy-docker.test.mjs` on the A13 container (its only route
    out the proxy; a stub DNS server logs no page names, a STUN responder on the direct network sees
    nothing, a planted direct route fails the check). -> 29, 39
40. `native/properties.mjs`, `validate.mjs`, validation shape in the store (E5, E6, E8). -> 34
    Landed as: `scripts/native/properties.mjs` (pure): `PROPERTIES`, section 9's rows as data (field
    in validation items' form, source, mechanism as switch names, engine keys and prefs, class per
    runtime `macos`, `linux-software`, `linux-gpu`, `measuredToo`, `later` with its patch, the rules
    that check it), with "Graphics requirements" and "Canvas bridge" rows added and the media row split
    into `media.capabilities` and `memory`; `classOf`, `runtimeOf` (Linux not measured as hardware
    counts as software). `scripts/native/validate.mjs` (pure): `measuredRecord(raw)`, the probe's record
    in the one stored shape (bounded: strings cut and control characters dropped, at most 40 WebGPU
    features, 48 limits, 16 sandbox page lines and media answers, 12 font names per list, nothing
    outside it, so its largest stays within the schema's 20000 characters as JSON; null without a
    time, runtime key or runtime); `RULES` (section 8's list and
    severities; `webgl.limits-vs-backend` reads WebGL and WebGL2 against each other and as powers
    of two, since SystemInfo carries no GL limits; `webgl.context` accepts no WebGL under
    `--disable-gpu`; `locale` gives one item per set field); `validate({ requested, derived,
    measured, live })` (requested: the profile's graphics, screen and locale, the launch's final
    switches and `toLaunch`'s items, kept first; derived: build, pack, runtime key, platform,
    `virtualScreen`; live: this launch's E3 read for `backend.stable`) answering the
    `validation[build]` entry: `validated` only with a measurement of this pack and runtime key and
    every error rule matched (no pack: `unverified`, the measurement kept as evidence), `failed` on an error mismatch (a part the page didn't answer for a
    switch the launch passed, by each rule's `switches`, is one), else `unverified`; `entryStatus`
    (a measured entry counts only for its own pack and runtime key, and never without a pack on
    either side). `profiles/schema.mjs`:
    `validation[build].graphics` typed (`MEASURED_BACKENDS`, `MEASURED_PARTS`, every key required),
    and a `validated` or `failed` entry refused without a measurement of its own runtime key and
    pack, or with a null pack. `store.recordValidation(id, { build, entry })`: a measured entry replaces the build's, no
    revision, no history, refused without a measurement or on an older record. `daemon/sessions/
    profiles.mjs` `forLaunch` reads the status through `entryStatus` with the launch's pack (the
    runtime key waits for step 44). Tests: `test/native-validate.test.mjs` (over spike E-S1's
    fixtures; the Linux persona of 13.1 fails `webgl.strings-vs-backend` and `screen.display`, and
    `webgpu.device` fails on both platforms until 961), `test/profile-schema.test.mjs`,
    `test/profile-store.test.mjs`, `test/session-profiles.test.mjs` (`test/helpers/measured.mjs`).
41. `native/graphics.mjs`, `backend.mjs`, `pairbrowse.graphics` (E2, E3, E9). -> 39
    Landed as: `scripts/native/graphics.mjs` (pure): `GRAPHICS_BACKENDS` (the one list; the profile
    schema and `config-schema.mjs` `pairbrowse.graphics` import it), `SOFTWARE_SWITCH`
    (`--use-angle=swiftshader`), `LINUX_REAL`, `SCREEN_KEYS`, `LEGACY_GPU_KEYS`, `normalizeWebgpu`,
    `GRAPHICS` (requested, plan switches and engine keys, kind, renderer, status; reset to
    `unverified` by each native launch until step 44 files the read), `backendSwitches`,
    `graphicsPlan({ requested, platform, browserKind, measured, userArgs, display, screenSet, name })`
    answering `{ switches, engineKeys, refusals }` (a refusal `{ field, message }`, one sentence; any
    refusal empties both: never a partial apply), `compatErrors(...)` (the plan's refusals plus
    `graphics.require`, the legacy identity, `canvasBridge`, `screen` vs the virtual screen, the
    open build; measured checks only with a measurement, "could not confirm" for an unverified read
    with `gpu` or a requirement), `runtimeKey({ build, pack, platform, arch, display, backend,
    switches })` (SHA-256; null without build, platform, arch or display kind; only backend switches
    count). `scripts/native/backend.mjs`: pure `parseSystemInfo` (`software` for `gl=disabled`,
    named "software rasterizer (GPU rendering off)", and the same for a GPU the engine's blocklist
    refused, which the answer still names (`featureStatus`: compositing in software and no WebGL,
    not even the software fallback; found at the Phase A and E gate: the open build 153 under
    Xvfb names Mesa's llvmpipe while it rasterizes on the CPU and gives pages no WebGL), and for a software name in the renderer, the
    device or `angle=swiftshader`; `hardware` for any other named renderer; else `unverified` with a
    reason; strings cut and cleaned, IDs whole numbers only) and `readBackend(ctx, { ms })` (a
    browser-level session over the pipe, each step bounded by `within`, the session detached).
    The Linux fix of 13.1 is in `native-engine.mjs` `applyGraphicsPlan`, run after the persona is
    saved so none of its keys is ever kept: on Linux `disableGpuFingerprint: true`,
    `fingerprintNoise: false` and, on the helper's Xvfb (`config.virtualDisplay`, passed by
    `daemon/browser/launch.mjs` and `native/check.mjs` from the screen's geometry), the screen keys
    unless config.json or the profile sets `screenWidth`/`screenHeight`; a layer's other value for
    those keys (screen keys too, where the virtual screen's apply) and the legacy `gpuVendor`,
    `gpuRenderer`, `gpuStringSpoof` are left out on Linux with a log line, and the legacy identity
    is logged deprecated (U6) on every platform. The legacy keys apply only while `config.json`
    or a saved profile sets them: `resolveFingerprint` drops one only the kept persona carries, so
    removing it from `config.json` ends both it and its log line. So E9's
    legacy-identity error applies off Linux only (on Linux nothing of it is applied). E7 sets
    `devicePixelRatio` too: 1 (Xvfb's) or the launch's `--force-device-scale-factor`. Profiles:
    `map.mjs` `toLaunch` takes the backend through `graphicsPlan` (software: `--use-angle=swiftshader`
    on Linux, refused on macOS, Windows and the open build; `SWITCHES` has `use-angle` in place of
    `disable-gpu`), and `gpu` and `graphics.require` still refuse until step 44 checks the read at
    launch. `readConfig` reads the default's backend from `pairbrowse.graphics` (native build only),
    no longer from `--disable-gpu` in `browserArgs` (named, kept as written: on macOS it would have
    become a refused software request). `forLaunch` passes `config.json`'s `browserArgs`, screened
    as the launch passes them, to `toLaunch` (`userArgs`), so the plan refuses a renderer switch
    the backend contradicts; its engine layer carries `graphics` (the backend asked for).
    `readBackend` never throws: a driver that throws at once is unverified, and a session that
    opens after its bound is detached. Tests: `test/native-graphics.test.mjs` (over spike E-S1's SystemInfo fixtures),
    `test/native-engine.test.mjs` ("the graphics plan reaches the engine and never the persona"),
    `test/profile-map.test.mjs`, `test/session-profiles.test.mjs`, `test/fuzz/graphics-compat.test.js`,
    `test/fuzz/profile-schema.test.js`.
42. `native/probe.mjs`, `probeLaunch`, self-check step (E4). -> 39, 40
    Landed as: `scripts/native/probe.mjs`: the bounded steps it shares with `captureMacHost`
    (`boundedStep`, `launchWithin`: a start that answers after its bound is closed; `localSite`, a
    page on 127.0.0.1 also reached as localhost); `probeOptions` (headless on macOS, headed on
    Linux); `runsEmulated` (an x64 process on a kernel whose `/proc/cpuinfo` is ARM's; anything
    unread counts as not emulated, keeping `sandbox.on`'s seccomp-BPF rule); the probe page
    (`PROBE_PARTS`: webgl, webgl2, webgpu, canvas, fonts, screen, media, locale, navigator, one
    bounded `evaluate` each, every await inside bounded; a part that answers nothing leaves the
    later ones unasked) and `runProbe(page)`; `readSandboxPage` (Linux: its lines, `"timeout"` or
    `"not shown"`); `probeRecord` (canvas `stable`: one scene the same twice in a page on each
    origin; `repeat`: the same on the second start; `noise`: the scene differs between the
    origins; `webgl.sameOrigins`; a part not answered is null, so the rules say so); and
    `probeLaunch({ launch, directory, build, pack, platform, arch, display, emulated, sandbox })`:
    `launch(folder)` is the caller's start with the resolved options, called twice on one
    temporary folder inside `directory` (the persona's seed stays, so `repeat` compares like with
    like); it reads the E3 backend and the launch's backend switches (`GRAPHICS.switches`), runs the
    page on both origins and the sandbox page, and answers `measuredRecord`'s shape under
    `runtimeKey({ build, pack, platform: "macos" | "linux", arch, display, backend, switches })`,
    then closes the browser, removes the folder and puts `SANDBOX` and `GRAPHICS` back. The font
    lists (`PROBE_FONTS`) are the families every persona shows on the platform: on macOS the
    native build's persona hides some this Mac has (Menlo, Monaco, Geneva, Avenir, Futura were
    measured missing), so the list keeps the seven it shows; the Linux list is not yet measured on
    the native build (`fonts.available` is a warning). `graphicsStep(measured)`: the self-check's
    line, "graphics: <kind>, WebGL <1|2> (or no WebGL), WebGPU <adapter|fallback adapter|unavailable>",
    never the GPU. `native/check.mjs` runs it after the other checks, on the check's own screen
    (the private Xvfb on a server, the desktop otherwise), started as the check's browser
    (launchOptions, the same sandbox rule), its own bound around it sized for the helper's launch
    path, which waits for it after an update: `GRAPHICS_TIMEOUT_MS` (one probe start of 60 s and two
    page steps, 120 s); a probe past it is stopped (`probeLaunch`'s `signal`: its browser closed,
    no further start or step) and waited for, `GRAPHICS_STOP_MS` (105 s) at most, so its folder,
    the SANDBOX and GRAPHICS state it puts back and its browser are settled before the person's
    browser starts; the worst case past the check's own 180 s is under four minutes. Off macOS and
    Linux the step is "graphics: not measured on <platform>" with no probe. A probe that fails gives
    "graphics: unverified (not measured: <why>)" and never fails the install; `selfCheck`'s `onGraphics(measured)` hands the measurement out. Measured live on this
    Mac's native build: hardware (Metal), WebGL 2, a WebGPU adapter whose reported limits fail
    `requestDevice` (E10), canvas stable and repeatable. Left for step 44: filing a measurement into
    a profile's `validation[build]` (the self-check's included) and the other two E4 triggers (the
    first launch per runtime key, logged "measuring graphics once for this browser version", and
    `cli.mjs validate`). Tests: `test/native-probe.test.mjs` (over spike E-S1's fixtures),
    `test/native-check.test.mjs`, `test/native-engine.test.mjs` (the capture's bounded steps),
    integration `test/integration/graphics-probe.test.mjs` (the page side in a real open-build
    browser).
43. `rules/coherence.mjs` and `tzcountry.mjs` (the locale rules and the table landed with 32b, `screen.believable` with 35); wired into D validation, C verdicts and the B report;
    `test/compat-vs-verification.test.mjs` (E13, C13, D16, B14). -> 29, 37, 21
    Landed as: `scripts/rules/coherence.mjs` gains `COHERENCE_RULES` (id to severity, the one list),
    `rendererFamily` and `softwareRenderer` (moved from `native/validate.mjs`, which imports them),
    `platformOf` (navigator.platform or a runtime name to `macos`, `linux`, `windows`; a phone's or
    tablet's, iPhone, iPad or Android, is not judged), `gpuVsPlatform({ platform, renderer })`
    (`gpu.vs-platform`, error: Apple's GPUs only on macOS; a Mac's are Apple, Intel or AMD),
    `gpuSoftwareAsHardware({ backend, renderer, adapter })` (`gpu.software-as-hardware`, error: a
    hardware WebGL renderer or a non-fallback hardware WebGPU adapter over a `software` backend),
    `screenBelievable(screen, { window })` now also warning on an available area larger than the
    screen and a window larger than it, each item's `field` (`window` or `screen`, which the
    validator, the launch's evidence and an import file it under), short `words` on the locale
    items, and `setupLines({ verification, items })` (B14's two lists; `profiles/import.mjs` passes
    the file's window too). `screen.display` stays a validator rule (`native/validate.mjs` RULES):
    it needs the launch's virtual screen. D validation: `native/validate.mjs` `COHERENCE` runs after
    `RULES` (gpu rules over the measurement, `gpu.vs-platform` matched when the backend is hardware
    of the page renderer's own family, the real GPU, as an Apple GPU under Linux through Mesa's
    asahi driver; `screen.believable` over the requested screen and the new `requested.window`;
    matched where a rule could tell, a mismatch per problem; errors fail the entry).
    `daemon/sessions/profiles.mjs` `forLaunch` keeps `screen.believable` items in the launch's
    evidence and its `results`, answers `locale` (what pages read: the profile's on the native
    build, the first language only and this computer's zone on the open build, else Intl; `geoip: {
    timezone, languages }` says which of the two geoip supplies, since a profile's own win over it,
    `native-engine.mjs` dropping only the geoip fields left unset) and `coherence()` (the screen
    items and, with a measured entry of this pack, its coherence mismatches);
    `requireValidatedProfiles` already refuses those errors through the stored entry. C verdicts:
    `daemon/network.mjs` `forLaunch(..., { locale })` (passed by `browser/launch.mjs` from the
    profile), `localeVsEgress` on each check's and recheck's exit country (a value geoip supplies
    isn't judged, one the profile sets is): kept with the check (`network.json` keeps the ids), a
    `warning:` (time zone) or `note:` (languages) status part, `compatibility(session)` (those items
    and a `network.verdict` item for a recheck that failed or moved the exit and was acted on); with
    `requireCoherent()` (`config.requireValidatedProfiles`, daemon.mjs) a time zone error fails the
    launch's check closed like any failure, with its own refusal and notice naming the profile's
    `locale.timezone` (or a proxy in the zone's country) as the fix, and no hold: the profile store
    isn't in the hold's stamp, so the next start checks again at once. Settings' Test
    (`liveview/network.mjs` `localeOf`) reads geoip per value the same way. B report:
    `context.compatibility()` (profile then network items) reaches `createYourTurn({ compatibility
    })`; when a hand-off goes to the channels (decision 8: a desktop without Away is unchanged, no
    report) the agent's status result gets "Site verification (yours to do): CAPTCHA on <host>." and
    "PairBrowse setup problems (PairBrowse's to fix, not the user's to work around): time zone
    Europe/Berlin vs egress US; ..." after the hand-off line; PairBrowse's own check gets the same
    lists in a host note (it has no status result), ending "Don't retry the check or work around
    it.", and so does a fast-mode run's `handoff` step (`onRunStatus`), ending "Don't retry the step
    or work around it.". Nothing here mints a grant or sends a message; a reader that throws is
    ignored. Tests: `test/coherence.test.mjs`, `test/native-validate.test.mjs`,
    `test/session-profiles.test.mjs`, `test/net-refuse.test.mjs`, `test/net-recheck.test.mjs`,
    `test/net-launch.test.mjs`, `test/compat-vs-verification.test.mjs`,
    `test/liveview-network-routes.test.mjs`.
44. Launch steps 4 and 7, status part, diagnostics (E7, E9); the other two graphics probe triggers
    (E4): the first launch per runtime key ("measuring graphics once for this browser version") and
    `cli.mjs validate`; filing a measurement into a profile's `validation[build]`. -> 41, 42, 37
    Landed as: `scripts/daemon/browser/graphics.mjs` `createGraphics(st, deps, api)` (made by
    `launch.mjs`, same folder, so no new `ALLOWED` edge; test seams `probeGraphics`,
    `readBackendOf`, `platform`, `arch`, `scratch` in `PART_SEAMS`). `before(...)` (step 4, after
    the profile's `forLaunch` and the network's `forLaunch` (step 3, so a network refusal never
    waits for a probe; inside the try whose finally drops the auth file), before `prepareProfile`,
    key files and `launchEngine`, so a refusal writes nothing): the measurement `forLaunch` now hands over (`measured`: `validation[build].graphics`
    of this engine pack) counts when its runtime's platform, arch and display kind are this
    launch's; else the first start per runtime measures now (logged `MEASURING_GRAPHICS`, "launch:
    measuring graphics once for this browser version", and the live view's status line until it
    ends) with `native/check.mjs` `graphicsCheck` over `probeLauncher` (new, shared with the
    self-check and the CLI: launchOptions with the profile's switches, the engine config with the
    profile's engine layer, the launch's screen and env, the server sandbox rule, `probeOptions`,
    no live view, proxy or key file, and never geoip: `probeEngine` turns it off in config.json's
    block and the engine layer, since without the proxy its region lookup would send this
    computer's own address out; the probe's time zone and languages are the profile's, else this
    computer's), its bound and stop as the self-check's; a probe that fails is not retried for that
    profile, build, pack and display until the helper restarts. While it runs (`st.probing`) a
    call waiting on the start, or one that comes in, is refused at once with "PairBrowse is
    measuring this browser's graphics once (a minute or two). Tell the user, then retry", as during
    an install, never held silently. The runtime
    key itself needs the browser's read (the GPU's IDs and the launch's final backend switches), so
    step 4 matches on build, pack, platform, arch and display and step 7 compares the key: a
    measurement of another key is dropped (`store.recordLaunch(..., { replaceMeasured })`, new; a
    launch's own entry otherwise never replaces one holding a measurement) and the next start
    measures again; never over a read that failed (an unverified backend proves nothing changed),
    and a probe of this helper run that isn't kept (its key isn't the browser's, or the read
    failed) isn't repeated for that runtime until the helper restarts, so a probe and a browser
    that never agree don't measure at every start. Then `compatErrors` over the request (`forLaunch`'s new `request`:
    `profiles/validate.mjs` `requestOf`), the measurement (or, with `gpu` or a requirement and none,
    an unverified read: "could not confirm"), config.json's `browserArgs` and `pairbrowse` block
    (the legacy identity) and the virtual screen; any error refuses the start naming all of them.
    `after(ctx, plan, ...)` (step 7, after `checkAtLaunch`, before `net.started()`, the close
    handler and any tab): `readBackend`, `GRAPHICS` kind and renderer, `runtimeKey` from the read and
    `GRAPHICS.switches`, `compatErrors`' backend and requirement errors over the read, then
    `profiles/validate.mjs` `measuredEntry` (new: `validate` over the request, the launch's switches
    and mapping items, build, pack, the key, the virtual screen) filed by `sessions/profiles.mjs`
    `fileValidation` (`recordValidation` with a measurement, else `recordLaunch`; the running
    profile's status and coherence items follow); a `backend.requested` or `backend.stable`
    mismatch, or with `requireValidatedProfiles` anything but `validated` (the runtime key now
    compared at launch, step 40's open point), refuses and the launch closes the browser (bounded)
    before the close handler, so no crash for the guard. The open build gets the read only
    (`Graphics: <kind> (<renderer>), requested auto, unverified on the open build`). Status part:
    `native/graphics.mjs` `graphicsStatusPart`, after the profile's in `context.statusParts({
    remote })`; `pairbrowse_status` passes `remote` for a joiner's agent, which gets no renderer.
    Diagnostics: `diagnostics.mjs` `graphicsSummary` (kind and status only) as `browser.graphics`
    in `diagnostics.json` and a "Graphics: <kind>, <status>" report line (row E-3, new); the Tools
    tab shows it in the Browser fact. `profiles/map.mjs` `toLaunch` now applies `gpu` and
    `graphics.require` on the native build (checked at steps 4 and 7) and refuses both on the open
    build. Self-check filing: `installNative`/`ensureNative` hand the check's measurement out
    (`onGraphics`); `launch.mjs` `chooseEngine` files it with the config-backed default
    (`fileSelfCheck`: the default's request, mapping, `browserArgs` and its mapped switches after
    them, `screenGeometry(config)` on Xvfb), since the self-check starts config.json's settings and
    its probe the default's mapped switches (`selfCheckArgs`, through `ensureNative`'s
    `profileArgs`), as the launch does; the by-hand `native-install.mjs`
    keeps only its line. `cli.mjs validate`: after `validateProfile` (mapping and repin), each
    profile is measured by `check.mjs` `measureGraphics` (driver, a private virtual screen where
    needed, the profile's engine layer with geoip off and its switches) and its verdict kept with
    `recordValidation`; the line names the status and the failing error checks; a probe that
    can't measure exits 1 and leaves it unverified. The sessions page's Check still only maps and
    repins (the next start measures). Tests: `test/launch-graphics.test.mjs` (new),
    `test/profile-map.test.mjs`, `test/profile-cli.test.mjs`, `test/diagnostics.test.mjs`,
    `test/tools-routes.test.mjs`, `test/native-check.test.mjs`, `test/native-install.test.mjs`,
    `test/supervise.test.mjs`, `test/structure.test.mjs`.
45. Saved card: profile field, key-store check, prefs, owner "Add a saved card", "Fill saved card",
    agent refusals and masking (B-AP4, B12). -> 37, 21
   Landed as: key store (U3): `browser/safe-storage.mjs` `keyStoreOf(storage, platform)` reads
   `safeStorageFor`'s answer as `"keychain"` (macOS, mock off, no file), `"key-file"` (macOS or
   Linux, the checked key file) or `""` (the mock keychain's fixed password, Linux's fixed key,
   Windows); `savedCardFor({ asked, native, storage, platform })` answers `{ asked, on, store, line }`
   (the open build always refused; `line` "saved card refused: this browser has no key store for
   it (<why>); payment autofill stays off", or "Saved card: on (encrypted with ...)").
   `ensureSafeStorageKey` now makes the file atomically (a fresh `.tmp` name written 0600, then
   `linkSync` to its name, which fails on anything there, so nothing is written over and no reader
   sees half a password); its type, owner, mode and link checks run before every launch as before.
   Mapping: `profiles/map.mjs` `toLaunch` no longer refuses `payments.savedCard`: on the native
   build it is `applied` with `prefs: { savedCard: true }`, on the open build `not-applied` (warning),
   never an error (differs from D11: off is the safe side, and only the launch knows the key store).
   `sessions/profiles.mjs`: `forLaunch` answers `savedCard`; `setSavedCard(card)` keeps the launch's
   answer on `st.profile` (logged as `launch: <line>`), `savedCard()` reads it (null with none
   asked or none running), and `statusParts()` adds the line (a refusal as `warning: ...`).
   `launch.mjs` reads `safeStorageFor` once before `prepareProfile`, decides, passes `savedCard` to
   `prepareProfile` (`profilePreferences`: `credit_card_enabled` is `savedCard === true`, written at
   every launch, so it goes off again) and the same `storage` to `launchOptions` (new option), so the
   browser gets the key store the preference counted on. `context.savedCard()`.
   Masking and refusals: `yourturn.mjs` gains the `savedCard()` dep (`daemon.mjs`: `context.savedCard()?.on`);
   `masked(page)` is true for every page while it is on (serve/result.mjs, `reply` and
   `pairbrowse_click_at` follow), and `yourTurn.savedCard()` feeds the key rule: `rules/cards.mjs`
   `AUTOFILL_TOKENS` (the card tokens plus `cc-name`, `cc-given-name`, `cc-additional-name`,
   `cc-family-name`, `cc-type`: the autofill list opens on the name on the card too, so B12's "card
   field" here is wider than B13's) and `SIGNALS.savedCardKey`; `runner/cards.mjs` `cardFieldOf` and
   `focusedCardField` take `tokens`; `refuse.mjs` `cardProblem` refuses any `browser_press_key` into such a
   focused field (or a card or payment frame) in a saved-card session, and `listKey` (ArrowDown, ArrowUp,
   PageDown, PageUp, Enter, whatever is held) into any text field of a document one of whose fields
   names a card without a token (`CARD_NAME`: name, id, placeholder, aria-label or label, as
   `name="cardnumber"`; `runner/cards.mjs` `focusedCardForm`, `SIGNALS.cardForm`), since the engine's
   autofill knows card fields by those too; fast mode's `press` step the same through
   `hooks.savedCard` (`serve/tools/run.mjs`). Not detected (added to `rules/cards.mjs`'s list): a card
   field named only by nearby text or in words `CARD_NAME` doesn't know (the engine's recognition is
   wider). Typing, filling and choosing keep B13's rule
   (the name on the card stays typeable: no key picks the card without an arrow).
   Owner "Add a saved card": `liveview/routes/tools.mjs` `GET saved-card.json` (`{ asked, on, store,
   line }`) and `POST saved-card`, right `profile` (the owner's key or the pages' key); refused (409,
   with the reason) when the card isn't on and while a recording runs (it records whatever is in
   front); otherwise `tools.openTab(PAYMENT_SETTINGS)` (`ui/urls.js`: `chrome://settings/payments`,
   `isPaymentSettings`) opens it as the person's own tab (`openForPerson`; no agent, guest or hand-off
   reaches it, and `isBrowserPage` keeps it the browser's own page for agents), a second tap brings
   the same tab forward, and the live view shows it: `cast.mjs` `showNow` lets through a hidden page
   only when it is a person's own tab at the payment methods page, whose frames reach owner streams
   only (guest frames and turn streams skip a person's tab). UI: `ui/panels.js` `savedCardPanel` (the
   live view's Profile panel, a "Saved card" section shown only when the profile asks; its line, and
   the button while it is on). Not added: a sessions page toggle (the CLI's `edit --settings` sets it).
   "Fill saved card": the `turn` event gains `savedCard`; `liveview/grants.mjs` `fillCard(res, guest)`
   (gate deps `savedCard`, `humanPost`, `focused`, `now`) behind `POST turn-fill-card` (right `turn`)
   refuses with a sentence (`FILL_CARD_WORDS`) when no card is on, a repeat within 4 s (its Enter could
   send the form), no scope tab on screen (audited `input-refused` `out-of-scope`), or `fillProblem`
   rejects the focused field (`runner/cards.mjs` `focusedFillField`, bounded): Enter is sent only from
   an empty card number field, autocomplete `cc-number` or, in a card or payment frame with no
   `cc-number` field, the frame's first text field. A field holding a value (the list doesn't open
   there), any other field of the form (a frame's postal code) or a page that doesn't answer is
   refused, since the helper can't see whether the list opened and the Enter would reach the page;
   else sends `ArrowDown`, `Enter` through
   `humanPost` as the person's own input and logs "hand-off <id>: Fill saved card". The viewer
   (`liveview-turn.js`) shows the button in its keys row only with `savedCard`, the button waiting for
   the input queue to empty first. Differs from B12 as written: the button shows for the whole
   hand-off and the helper checks the focus at the tap (no focus events reach the viewer), with the
   sentence "Tap the card number field in the picture first". Matrix row: U3 accepted the key file,
   so "Saved card" is C on Linux too. Tests: `test/safe-storage.test.mjs`, `test/browser.test.mjs`,
   `test/profile-map.test.mjs`, `test/session-profiles.test.mjs`, `test/refusals.test.mjs`,
   `test/yourturn.test.mjs`, `test/tools-routes.test.mjs`, `test/policy.test.mjs`,
   `test/liveview-grants.test.mjs` (the turn event's keys; `cast.mjs` shows the payment methods page
   only as a person's own tab, its frames to owner streams only), `test/supervise.test.mjs` (the
   launch reads the Safe Storage once: `credit_card_enabled` is `savedCardFor`'s answer, the key-file
   switch from the same storage, `setSavedCard` before the start). Security row
   B-6 ("Saved payment cards") lands; the key-store row and the Tools routes row name it. Not here:
   T-B18's measurement of the autofill list in screencast frames (step 49's opt-in runs) and a live
   check that the engine's list opens on `ArrowDown` from `Input.dispatchKeyEvent`.
46. Phase A integration file, CI `xauth`, Phase A opt-in tests on the harness (A13). -> 8, 39
    Landed as: `test/integration/server-display.test.mjs`, the seven cases of section 4 on the
    driver's browser (Linux with Xvfb and xauth, `PAIRBROWSE_TEST_RUNTIME`; skipped elsewhere), its
    parts in `test/helpers/server.mjs` (`serverHome`, `startServerHelper` without `DISPLAY`,
    `WAYLAND_DISPLAY` or `XAUTHORITY`, `screenRecord`, the browser's processes from `/proc`, and
    `sandboxOf`: no `--no-sandbox` and every process the sandboxed zygote started (renderers keep
    the zygote's command line) in a PID namespace of its own, `NSpid`, with `Seccomp: 2` required
    on x64 hosts; measured in the container, emulated on Apple Silicon, all on). The switches `CRASH_WINDOW_MS` (the guard's window and hold)
    and `RELAUNCH_MS` (one pause for every keep-alive start) are read as `supervise.mjs` loads; the
    keep-alive case kills each browser only after its start completed ("browser started"), since a
    kill during a launch fails the launch and is no close for the guard. CI: `xauth` beside `xvfb`,
    and the runner's AppArmor rule against unprivileged user namespaces lifted for the live job
    (`kernel.apparmor_restrict_unprivileged_userns=0`), the host setting U1 names, since server mode
    never starts the browser without its sandbox. Opt-in: `test/optin/server/server-docker.test.mjs`
    (its three cases, run inside by `test/optin/server/server-run.mjs`, the driver's Linux browser
    installed once into a kept folder; `container.mjs` `startContainer` gains `seccomp: "default"`
    (no profile of ours: Docker's own) and `root`, and every run gets `--init`, since a killed
    helper's Xvfb is otherwise left a zombie under the container's `sleep` and still counts as
    running for `reapOwn`), and `test/optin/server-native.test.mjs` on a
    Linux host (the native build is checked in the container by step 39's spike). `npm run
    test:optin` takes `test/optin/server/*.test.mjs` too. Found while writing "browser killed":
    after a crash an agent's tab never came back as its own (places were noted only before a
    switch, from the browser's open tabs, which a crashed browser no longer lists; a crash cleared
    the agent's spark before its connection's departure was held; a resumed connection dropped a
    closed tab). Now the tab tracker keeps its last save's pages (`scripts/tabs.mjs` `pages()`, set
    by the crash-time write too, which `notePlaces` makes first with `flush()` whichever close
    handler runs first, and seated with each tab back while a restore holds the file, so a second
    crash then loses none), `notePlaces` reads them and the browser in use's close handler calls it
    on every close but a switch, the departure holds `conn.mine` when the spark is gone, the resumed
    connection keeps its closed tab, and `turns.mjs` `myTab` waits for the saved tabs before it
    looks for that tab's successor (`test/tab-successors.test.mjs`, `test/tabs.test.mjs`). Also
    found ("Xvfb killed"): the crash-time write named the first tab active, since the active page
    is asked of a browser whose pages are gone; `trackTabs` gains `activeUrl` (the helper's
    `st.lastCurrentUrl`) for that write. All seven integration cases and the three Docker cases
    passed in the A13 container (emulated x64, 2026-10-21); `server-native` waits for a Linux host. Rows A-1
    and the sandbox row name the new tests.
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
| B-2 | New | "A hand-off viewer's input does more than a person's hands": checked input set; `char` never carries Ctrl or Meta; type box keeps nothing | `test/input.test.mjs`, `test/fuzz/joiner-input.test.js`, `test/liveview-mobile.test.mjs` |
| B-3 | New | "Hand-off notifications send more than meant", with per-channel exposure: webhook (your endpoint gets kind, host, expiry, link); ntfy (the server and anyone subscribed to the topic; on public ntfy.sh without a token no link); Telegram (Telegram's servers and the chat's members; bot messages are not end-to-end encrypted); Discord (Discord and the channel's members); Slack (Slack, the workspace's retention and the channel's members). Never the agent's text, codes, passwords, card data or page content; credentials are reserved secrets | `test/notify-channels.test.mjs`, `test/redaction.test.mjs` |
| B-4 | New | "An agent finishes a step meant for a person": hands, run, navigation and closing refused in a handed-off or held tab; in every session agents never type into card fields or type a card number (B13); the Pay click rule unchanged | `test/refusals.test.mjs`, `test/shared-rules.test.mjs` |
| B-5 | New | "What the person types during a hand-off reaches agents, joiners or logs": agent results from scope tabs masked as a joiner's, pictures covered; field names only in notes; nothing typed in the activity log, journal, audit or messages; the turn viewer itself sees card fields uncovered | `test/yourturn.test.mjs` |
| B-6 | New | "Saved payment cards": off by default, per profile; only with a real key store (U3), else refused; only the person fills, during a hand-off; agents masked in every tab of that session and refused in card fields; never in snapshots, logs, notifications or summaries | `test/browser.test.mjs`, `test/refusals.test.mjs`, `test/yourturn.test.mjs` (landed with `test/safe-storage.test.mjs`, `test/tools-routes.test.mjs`, `test/session-profiles.test.mjs`, `test/profile-map.test.mjs`, `test/policy.test.mjs` too) |
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

8. **Where hand-off happens (user, 2026-10-20).** On a computer the person sits at, the hand-off stays
   as it is today: the step is done in the PairBrowse window itself (bar, side panel, the tab), with
   no link or message needed. The phone link and the Telegram, Discord, Slack, webhook and ntfy
   messages are for when the browser runs on a server, or when the person has set up a channel
   because they may be away. A desktop with no channel configured behaves exactly as now; a
   configured channel adds the message and link without taking the step away from the window
   (whichever the person uses first completes it).
   The person can also turn it on at home: an "Away" switch (side panel and Settings, owner only, also
   reachable from the live view owner page) sends hand-offs from this desktop to their phone through
   the configured channel while they are out; turning it off returns to the window-only behavior.
   Away is off by default, remembered across restarts, and needs at least one channel set up (the
   switch says so if none is). In server mode, sending is always on.

Implementation conditions (from the user):
- Keep the five phases and every agreed requirement: profile import and export, per-profile isolation,
  proxy separation, graphics validation, mobile interactive hand-off.
- Fix PairBrowse's own avoidable compatibility problems and report them apart from website-required
  verification. Never bypass CAPTCHA, bot checks, authentication or payment authorization.
- Verify that Linux today reports a hardware-like persona over software rendering, and correct it so
  measured diagnostics are accurate.
- Start with dependency-ready work; never skip prerequisite investigations or security tests to reach
  Phase B sooner.
- Small, reviewable commits; run the relevant tests after each; a phase is complete only when its
  acceptance criteria pass.
- Update this spec and `docs/security.md` whenever implementation findings differ from the plan.

### 13.1 Milestone 1 findings (2026-10-20)

**Linux persona (condition 3): confirmed live** by spike E-S1 (step 39, the pinned Linux build in
the A13 container): SystemInfo names llvmpipe while the page's WebGL says `ANGLE (Intel, Mesa
Intel(R) UHD Graphics 770 (RPL-S), ...)`, WebGPU's adapter says intel/gen-12-lp over SwiftShader,
and the screen is the seed's (2560x1440, 1920x1080) over a 1366x900 Xvfb. With
`disableGpuFingerprint` and `fingerprintNoise: false` the page's WebGL strings become llvmpipe's or
SwiftShader's and WebGPU's google/swiftshader; the screen stays the seed's until E7. First read from
code:
- Pages on Linux see a made-up hardware persona: every seed persona is Intel UHD 770 (pn
  `002-persona-profile.patch:120-135, 567-570`), rewritten on Linux to `ANGLE (Intel, Mesa Intel(R)
  UHD Graphics 770 ...)` with WebGPU vendor intel, architecture gen-12-lp (`002:483-491, 671-673,
  755-780`), a desktop WebGPU limits table (`002:587-623`) and hardware video decode claims
  (`002:625-637`). The NVIDIA strings in pn `070` and `001` are reached only with an empty persona
  string, which a seed persona never has, so the earlier "NVIDIA" wording was wrong.
- The screen is not fixed at 1920x1080: the seed picks it from a weighted pool (`002:72-82,
  559-565`), and it wins over the real screen whenever `--fingerprint` is set (`140:221-290`). The
  real screen is the Xvfb size (`virtualScreen`, default 1366x900).
- Helper path: `native-engine.mjs` `resolveFingerprint` keeps the bare `sha256(directory)` seed on
  Linux; host capture is macOS only.
- Fix (decision D-AP2, E2; spec steps 41 and 44, helper only; the launch part landed with step 41): on Linux launch with
  `disableGpuFingerprint: true` and `fingerprintNoise: false` so WebGL strings, limits, extensions
  and WebGPU vendor and architecture report the real backend (pn `002:740-748`, `955:155-165`), and
  pass the real Xvfb geometry as the screen overrides. Remaining after that: WebGPU limits stay the
  persona table until patch 961; media codecs, CPU cores, memory and voices stay seed-derived and
  are reported as derived, never measured. Legacy `gpuVendor`/`gpuRenderer` get the U6 warning.

**Card protections (U7): traced before B13 lands.**
- Today nothing stops the host's own agent from typing a card number: `browser_type`,
  `browser_fill_form`, `browser_press_key` digit by digit, `browser_drop` with text data, a secret
  holding a card, or a fast-mode fill into a main-frame card field all go through. The only payment
  protection is at the click: the Pay class (`rules/clicks.mjs` `paySignal`, `clickRule`; form scan
  in `daemon/page.mjs:133-188`), the Enter/Space check (`refuse.mjs` `browserToolProblem`) and the
  dialog OK rule. Masking (`policy.mjs` `maskCards`, `maskForAgent`) changes only what is shown, and
  for agents only joiners' agents. Fast mode skips child frames holding `cc-*` inputs
  (`runner/locate.mjs` `formRoots`) but fills the main frame. `facts remember` and fast mode's
  `seenInForm` can store a card number under a neutral label.
- Compatibility impact of B13 (every session, every app, every permission mode): a developer can no
  longer have the agent fill test cards on their own checkout (localhost, Stripe/Adyen/Braintree
  test mode, the `pairbrowse-test-site` checkout scope); the person types them or the step is handed
  over. Every field inside an embedded card frame becomes person-only (Link email, billing address
  inside the provider's frame). Cards from chat, facts or secrets are refused. A joiner's agent can
  no longer fill a card (`skills/pairbrowse/SKILL.md:119-124` changes). Four of our tests that set up
  pay cases by typing a card through an agent tool move to `page.fill`
  (`test/integration/click-flows.test.mjs:167`, `shared-rules.test.mjs:143`, `join.test.mjs:275`,
  `fastmode-forms.test.mjs:145`). Unchanged: the Pay click rule, masking, covers, reading card pages,
  name-on-card fields, and the person typing in their own window or a hand-off. No test-card
  exception (U7).
- Corrections to B13 and step 22: the check lives in `browserToolProblem` (`refuse.mjs`, beside the
  secret-frame check, before `rewrite.mjs` so both drivers and the native humanized fill are covered)
  and in `runner/steps/fill.mjs`, not in the pure `tabRefusal`. It also covers `browser_drop` data,
  `browser_press_key` digits and pastes (Cmd/Ctrl+V, with Shift or Alt too) into a focused card field, secrets resolved by name,
  `pairbrowse_facts remember` and `seenInForm`, and `browser_select_option` on `cc-exp-*`.
- Detection: refuse `cc-number`, `cc-csc`, `cc-exp`, `cc-exp-month`, `cc-exp-year`; allow
  `cc-name`, `cc-given-name`, `cc-family-name`, `cc-additional-name`, `cc-type` (as `sensitiveHints`).
  Frame rule: a frame holding those inputs, or an `allow="payment"` frame cross-origin to the page.
  Value rule only on card-shaped runs (as `maskRun`) with a Luhn and card-network prefix and length
  check, to spare IMEIs, EAN/ISBN codes and order or tracking numbers (Luhn alone passes about 10% of
  random digit strings). The refusal names the signal that fired. Gift cards count as payment
  credentials. Not detected, documented: contenteditable, closed shadow roots, canvas widgets, a card
  split over unlabeled boxes.
- Docs on landing: a new `docs/security.md` row ("Card details are entered by a person, never by an
  agent, in every session and app"), rows on the Pay click and masking updated, a plain-language
  CHANGELOG entry, SKILL.md and the test-site skill updated.

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

Phase C: a person adds, tests and assigns proxies in Settings (also from a phone), password write-only
(C14); each session uses its own HTTP, HTTPS or SOCKS5 proxy, independent of its profile;
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
