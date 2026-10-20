# PairBrowse server-mode and native-engine design

Date: 2026-10-20
Status: draft for review. No implementation until approved.
Scope: four workstreams - Linux server mode, remote human hand-off, proxy/session
networking, native browser environment and graphics.

## 1. Product goal and non-goals

### Goal

A reliable, remotely operated PairBrowse that autonomous agents can run continuously on a
Linux server with no physical monitor. It keeps per-session network configuration and browser
state, reports a well-defined and testable browser environment, and hands control to an
authorized human when a site needs a login, a 2FA code, a CAPTCHA, a bot check, or another
human decision, then resumes.

### Non-goals (product)

- No unattended solving of CAPTCHAs or bot checks. These are always human hand-offs. This keeps
  the existing PairBrowse core rule.
- No remote-debugging port, unrestricted file access, run-code/WebMCP tools, or CAPTCHA-solver
  (the standing repo rules in the project CLAUDE.md and `docs/security.md`).

### Out of scope, with reason (the one carved-out item)

- **Fabricating hardware identity to defeat third-party anti-abuse systems.** Workstream 4
  touches the native engine's persona/fingerprint layer. Designing new work whose purpose is to
  make a server-run browser pass as different physical hardware to a site's bot detection is out
  of scope. This is called out per-component in section 7, with its impact on the architecture
  and the legitimate alternatives, rather than dropping the whole workstream. The engine's
  existing persona behavior is documented as-found (section 6) so the rest of the platform can be
  built against it accurately.

The in-scope part of workstream 4 is: a full profile-management system (per-profile isolation,
versioning, lifecycle, faithful configuration), report the true runtime environment (host-truth
mode), render correctly with and without a GPU, remove or isolate the unsafe canvas-bridge
component, and give environment configuration documented provenance and tests.

Decision (confirmed with product owner, 2026-10-20): the profile system provides **rich profiles
with host-truth identity** - substantial per-profile diversity (isolation, browser version,
locale, timezone, language, viewport, color scheme, graphics backend, per-profile proxy) while
hardware/OS identity always reports the real backend. Fabricating a different per-profile
OS/GPU/canvas/font identity to evade anti-abuse detection is excluded (Tier I, section 6a).
Graphics backend: both software rendering and running on a GPU host are selectable (section 7).

## 2. Verified repository findings

Evidence is cited as `path:line` for the public repo (`~/Projects/pairbrowse`) and
`native/patches/<file>.patch:<line-in-patch>` for the private engine repo
(`~/Projects/pairbrowse-native`). "Confirmed" = read in the source. "Claim" = stated by a
comment or doc, not independently verified. "Hypothesis" = my inference.

### 2.1 Server mode (workstream 1)

- Confirmed: `scripts/display.mjs` already starts a real headed browser on a private Xvfb
  display on Linux. `needsVirtualDisplay(config, env, platform)` returns true on Linux when
  `config.display` is `xvfb`, or `auto` with no `DISPLAY`/`WAYLAND_DISPLAY`
  (`scripts/display.mjs:15-19`). `startVirtualDisplay` runs `Xvfb :N -screen 0 1366x900x24 -auth
  <cookie> -nolisten tcp` behind an X cookie in `~/.pairbrowse/run`
  (`scripts/display.mjs:22-47`). It requires `Xvfb` and `xauth` and throws a clear install
  message otherwise.
- Confirmed: `config.display` is a known config key with values `auto|xvfb|none`
  (`scripts/config-schema.mjs`, `display` spec).
- Confirmed: the browser is always headed; there is no headless mode (project CLAUDE.md, browser
  section). So "server mode" does not require `--headless` and this design does not add it. The
  screen size is currently hard-coded to `1366x900x24` in `display.mjs:35`.
- Hypothesis: lifecycle (health check, cleanup, recovery) for the Xvfb process beyond
  `xvfb.kill()` (`display.mjs:38,42`) is minimal. Needs tracing before building (open item O1).

### 2.2 Human hand-off (workstream 2)

- Confirmed: `pairbrowse_status` already supports `kind: "you"` and routes a hand-off to the goal
  log's `yourTurn` (`scripts/daemon/serve/tools/status.mjs:34-41`). The core instructions tell
  agents to use `kind "you"` for login/2FA/CAPTCHA/payment and `kind "done"` when finished.
- Confirmed: live view is key-protected, 127.0.0.1-only, with per-invite 256-bit keys
  (`docs/security.md` rows; `scripts/liveview.mjs` and `scripts/liveview/`).
- Confirmed: public addresses exist via Cloudflare Quick Tunnels (`scripts/tunnels/quick.mjs`)
  and invites/join codes (`scripts/daemon/sharing.mjs`).
- Confirmed: no webhook/Slack/Telegram/email/ntfy/Pushover notification path exists today
  (no such sender in `scripts/`; hand-off currently surfaces in the side panel/bar and goal log).
  This is the main new build in workstream 2.

### 2.3 Proxy / session networking (workstream 3)

- Confirmed: there is no proxy support today. `config-schema.mjs` has no proxy key, and a grep of
  `scripts/sessions.mjs` and `scripts/daemon/browser/` for `proxy`/`socks` finds nothing.
- Confirmed: the engine's config keys under `"pairbrowse"` include `location`, `timezone`,
  `acceptLanguage`, `webrtcIp`, `webrtcMdns` (`config-schema.mjs`, `PAIRBROWSE_ENGINE_KEYS`).
  These shape the browser-reported environment, not the actual network path. The schema comment
  states none of them names a proxy or another server.
- Hypothesis: per-session proxy + a WebRTC/DNS leak guard is a genuinely new subsystem. The
  engine already has `webrtcIp`/`webrtcMdns` knobs that must be kept separate from the real
  egress (see the "keep network observations separate from environment config" rule in the
  brief).

### 2.4 Native engine (workstream 4)

Engine: a patched browser engine at `150.0.7871.114`, pinned in `native/lock.json` (macOS) and
`native/lock-linuxwin.json` (Linux/Windows); upstream recorded in `native/UPSTREAM.md`. Patch
order in `native/patches/series`. Patches 000-220 are the fingerprint series (per
`UPSTREAM.md:12`); 5xx are PairBrowse's own shell/UI; 951/955 fixes; 997-999 branding and the
macOS persona adaptation.

Confirmed behavior of the graphics/environment patches (read in source):

| Patch | What it does | Key evidence |
|---|---|---|
| 002-persona-profile | Loads a persona (seed-derived or imported profile) into `ungoogled::CurrentPersona()`; the source every other patch reads | `persona_profile.cc/.h`; read partially |
| 040-fonts | On `--fingerprint`/`--fingerprint-profile`, filters the font list to a canonical per-OS set or the profile's list; on a cross-OS persona substitutes metric-compatible open clones (Carlito/Arimo/Tinos/...) | `font_cache.cc`; `040:593-685`; read |
| 060-canvas | Low-bit XOR noise on canvas readback (getImageData/toDataURL), seeded per eTLD+1; measureText noise present but multiplied by 0; also the canvas-bridge readback override | `060:419` (factor 0); read + agent-traced |
| 065-canvas-bridge | Renderer-process client that streams canvas/WebGL draw ops to a remote host over raw TCP+WebSocket and uses the host's returned pixels; `--canvas-bridge-*` switches; header says it needs `--no-sandbox` | `canvas_bridge_client.h:676-685`; read |
| 070/071/075/955 | WebGL getParameter strings/limits/extensions and WebGPU adapter vendor/architecture/limits from the persona; readPixels noise | agent-traced; spot-checked |
| 140-screen | On `--fingerprint` (or `--fingerprint-avail-*`/`-screen-*`/`-device-pixel-ratio`), `screen.*`, `window.outer*`, `screenX/Y`, `devicePixelRatio` report the persona display, not the host | `screen.cc`, `local_dom_window.cc`, `screen_detailed.cc`; read |
| 146-perf-memory | `performance.memory.jsHeapSizeLimit` from the persona instead of V8's host-derived value | `146:13-16`; read |
| 147-media-capabilities | `MediaCapabilities.decodingInfo` smooth/powerEfficient/supported for h264/vp8/vp9/av1/hevc from the persona, not the host GPU | `media_capabilities.cc`; read |
| 999-macos-persona-adaptation | On a macOS persona, reverts Direct3D WebGL strings to real and clears Windows voices/Realtek devices | `999:2-20`; read |

Gating: most overrides are off unless `--fingerprint` (a seed) or `--fingerprint-profile` is set.
Confirmed: PairBrowse's launcher drops `--fingerprint` when a profile is chosen without a seed
(`scripts/native-engine.mjs`, agent-traced), so with neither switch the browser already reports
host-truth for most of these surfaces. `--disable-gpu-fingerprint` (`webgl_real`) reverts WebGL,
but per patch `955` the WebGPU limits table ignores it (section 7, confirmed-doc-inaccuracy).

### 2.5 Confirmed bugs / incomplete functionality

- B1 (security, confirmed): canvas-bridge accepts any upgrade reply containing `" 101 "` without
  checking `Sec-WebSocket-Accept` (`065:277`); allocates a server-controlled 64-bit frame length
  with no cap (`065:594-611`), so a hostile/broken server can OOM the renderer; no TLS; Basic auth
  in cleartext.
- B2 (security, confirmed): WebGL draw ops stream to the bridge host whenever `Connected()`,
  ignoring the origin policy (`070:700-706` pattern); only 2D ops check the policy.
- B3 (confirmed): the only bridge server in the tree is the gitignored upstream
  `native/upstream/.../canvas-bridge-server/server.py`; it never checks auth and never echoes
  `content_version`, so the client prefetch cache never fills (agent-traced).
- B4 (confirmed doc inaccuracy): `955:5` says the WebGPU adapter follows
  `--disable-gpu-fingerprint`; the limits table does not.
- B5 (confirmed doc inaccuracy): `060:418` labels code "measureText perturbation" that is
  multiplied by 0 (`060:419`) - a no-op.
- B6 (confirmed): server mode screen size hard-coded `1366x900x24` (`display.mjs:35`); no
  configurable dimensions/scaling yet.

## 3. End-to-end workflows

### WS1 - Linux server mode
1. Operator sets `display: "xvfb"` (or leaves `auto`) and optional `serverDisplay` dimensions in
   `config.json`.
2. Daemon start detects no monitor, starts Xvfb behind an X cookie, launches the headed browser
   into it (existing `display.mjs` path), runs a window manager if configured.
3. Health check: supervise the Xvfb PID and the browser; on crash, clean the stale
   `/tmp/.X*-lock` and socket, restart, restore session via existing session/tab memory.
4. Agent works normally. On a blocker it hands off (WS2).
5. Cleanup on shutdown: kill Xvfb, remove the cookie and lock.

### WS2 - Remote hand-off
1. Agent calls `pairbrowse_status kind:"you"` with what the human must do (existing).
2. Daemon mints a single-use, 15-minute, session+tab-scoped access grant (new) and builds a live
   view URL over the existing tunnel.
3. Daemon sends one notification over the configured channel(s): webhook / Slack / Telegram /
   email / ntfy / Pushover (new senders, stdlib + HTTPS only).
4. Human opens the link, does the step, the agent resumes (existing wait/resume).
5. If nobody responds within a timeout: save progress (`run_save`), send exactly one reminder,
   then stop safely. No auto-bypass.

### WS3 - Proxy / session networking
1. A session config names a proxy (`http|https|socks5`, optional auth) and optional
   locale/timezone (new session fields).
2. On session start the browser launches with `--proxy-server` for that session; credentials come
   from the secret store, never inline.
3. Egress check: fetch the observed public IP and available geo/network metadata; record it as an
   observation, kept separate from the browser-environment config.
4. Leak guard: verify DNS and WebRTC route through the proxy; fail closed (block navigation,
   hand off) if the privacy guarantee can't be held.
5. Drift detection: if egress IP/geo changes unexpectedly mid-session, pause and notify.

### WS4 - Native environment (in-scope parts)
1. Host-truth mode: a single, documented switch/config that guarantees every page-readable value
   (GPU strings, canvas readback, screen, memory, media caps, fonts) reflects the real machine.
   Built by ensuring no `--fingerprint*` persona override is active and closing the gaps where a
   "real" switch doesn't fully revert (B4).
2. GPU-less Linux: confirm the renderer reports software rendering truthfully (SwiftShader/llvmpipe
   as applicable) and that WebGL/WebGPU either work via software or fail cleanly with a defined,
   truthful "unavailable" result.
3. Canvas-bridge: remove or hard-isolate it (section 7).
4. Environment profiles: a versioned, engine-version-pinned profile format with recorded source,
   provenance and license, usable only as explicit, labeled configuration - never presented as a
   verified runtime property.

## 4. Component boundaries and data flows

- `scripts/display.mjs` (WS1): owns the virtual display lifecycle. New: supervisor + configurable
  geometry.
- `scripts/daemon/serve/tools/status.mjs` + a new `scripts/daemon/notify/` (WS2): hand-off event
  to notification senders. New `scripts/daemon/grants.mjs`: single-use scoped access grants.
- `scripts/sessions.mjs` + a new `scripts/net/` (WS3): per-session proxy launch args, egress
  check, leak guard. Secrets via the existing facts/secret store.
- Native engine (WS4): the host-truth guarantee lives mostly in the public launcher
  (`scripts/native-engine.mjs`) + the native test suite (ensuring no `--fingerprint*` override is
  active). Two exceptions require small *reverting* engine patch changes, not new persona
  behavior: closing B4 (make the WebGPU limits table honor `--disable-gpu-fingerprint`, patch
  955) and removing/guarding the canvas-bridge (patch 065). These go through the normal native
  build/gate cycle. No new identity-override (Tier I) code is added.

Hard separation (brief rule): the **real network observation** (egress IP/geo/DNS) is stored and
reported distinctly from the **browser-environment configuration** (`location`, `timezone`,
`acceptLanguage`, persona). The platform never infers OS/GPU/hardware from an IP.

## 5. Dependencies and implementation order

1. WS1 server mode (builds on existing `display.mjs`; unblocks continuous running).
2. WS2 hand-off notifications + access grants (builds on existing status/tunnel/live view).
3. WS3 proxy + leak guard (new subsystem; needed before trusting server egress).
4. WS4 host-truth mode + canvas-bridge isolation + profile provenance (native build cycle; slowest).

## 6. Native engine: persona/profile infrastructure, as found

- `ungoogled::CurrentPersona()` (from `002`) is the single read source for every environment
  override. A persona is either seed-derived (`--fingerprint <seed>`) or imported from a profile
  (`--fingerprint-profile`). Fields: WebGL strings/limits/extensions, WebGPU, screen geometry,
  DPR, fonts, heap limit, media codecs, voices, media devices, timezone/locale.
- Dependencies: `components/ungoogled/` (persona_profile, ungoogled_switches); every graphics
  patch includes `persona_profile.h`. The engine pack bundles upstream (Clearcote) launch
  helpers (`native/UPSTREAM.md`).
- Limitations (confirmed): seed-derived defaults are Windows-shaped; `999` patches over the worst
  macOS leaks. `--disable-gpu-fingerprint` does not fully revert WebGPU limits (B4). The
  profile import path and the seed path can disagree unless carefully gated.
- Provenance gap (confirmed, to resolve): `040`'s font lists are described as derived from a
  "capture corpus" of ~3,000 real Windows machines and Ubuntu package scans; the comments
  describe methodology but the repo does not, in the files read, record the corpus's source,
  collection consent, or license. This is an open provenance item (O4) for the profile-data
  requirement, independent of the spoofing question.

## 6a. Selectable desktop-environment profiles (WS4 product requirement)

Requirement: an agent on a GPU-less Linux server selects a supported desktop-environment profile
(OS environment, screen size, locale, timezone, graphics capabilities) appropriate to the
workflow, rather than being limited to the server's physical display/hardware, coordinated with
a configured proxy.

### Profile management (in scope, first-class)

A profile is a named, versioned, stored object with a lifecycle independent of any one session:

- **Create / store / select / retire.** Profiles live under `~/.pairbrowse` (owner-only, never
  committed). Each has a stable `id` and an `engineVersion` it is valid for.
- **Per-session assignment and isolation.** A session is assigned exactly one profile. Isolation
  is real browser-profile isolation: separate cookie jar, storage, logins, extensions, history,
  and cache per profile (distinct persistent context directories). Two sessions on different
  profiles cannot see each other's logins or storage. This is the substantive "diversity" axis and
  does not depend on identity spoofing.
- **Faithful configuration per profile** (Tier F below): browser version, locale, timezone,
  language preferences, viewport, DPR, color scheme, graphics backend, and an optional per-profile
  proxy (kept as a separate network dimension, WS3).
- **Metadata:** `source`, `provenance`, `supportedConfigs`, and `validationStatus` (last validator
  result + timestamp). A profile that has not passed validation on the current engine version is
  marked unverified.
- **Migration:** the existing persona/profile infrastructure (`002` imported profiles, the config
  keys under `"pairbrowse"`) maps onto this system - its Tier-F fields become profile Tier-F
  fields; its Tier-I persona fields are carried but validator-gated and default to host-truth.
  Existing config continues to load (open item O7 for the exact mapping).

The governing rule, stated by the product owner: **the browser's reported capabilities must agree
with the actual runtime and rendering backend.** That rule is the design's enforcement mechanism
and it sorts every *configurable-identity* profile field into two tiers:

### Tier F - faithful configuration (in scope)

Fields that can be set to a chosen value and still be *true*, because the browser really is
configured that way:

- Viewport / window size and `devicePixelRatio` (the window genuinely is that size).
- Locale, timezone, `Accept-Language`, color scheme / `prefers-*`.
- Graphics backend *selection*: local GPU (when present), software rendering (SwiftShader/
  llvmpipe). The profile selects it; the browser reports the one actually in use.

These are ordinary browser configuration. A profile that sets only Tier-F fields is reported
truthfully and passes the validator on any host.

### Tier I - identity override (the excluded sub-component)

Fields that assert a machine identity independent of the real one: OS platform string /
`navigator.platform` / UA claiming an OS the server is not running, WebGL `UNMASKED_RENDERER` /
WebGPU adapter claiming a GPU the backend is not, and the canvas/font persona tuned to match that
fake identity. On a GPU-less Linux server these *cannot* agree with the actual backend by
definition. Setting them to pass as different hardware to a site's anti-abuse system is the one
excluded item (section 1, section 7). The engine's persona layer (002/040/070/075/140/146/147)
implements Tier I today; host-truth mode keeps it off and the validator (below) fails any launch
where a Tier-I value diverges from the measured backend.

Impact on the architecture: the profile system, schema, selection workflow, and validator are all
built. What is *not* built is a profile whose purpose is a non-matching Tier-I identity. A profile
may still carry Tier-I fields for legitimate uses (e.g. a developer deliberately testing a site's
macOS code path on a Mac host, where the values are true), but the validator refuses to present
them as a verified property when they contradict the real backend.

### Profile-selection workflow

1. Configure the session proxy (WS3).
2. Verify the actual network connection and available location metadata (WS3 egress check). This
   is an *observation*, stored separately; it never sets identity automatically.
3. Select a supported profile for the workflow. The system may *recommend* compatible Tier-F
   settings from the workflow + observed region (e.g. suggest `Europe/London` / `en-GB` for a UK
   egress), but selection is always explicit.
4. Select an available graphics backend (local GPU / software; remote GPU - see section 7).
5. Initialize the browser with the profile + backend.
6. Validate: measured runtime == reported capabilities (below). Fail closed on divergence.
7. Hold the configuration for the session lifetime; report unexpected changes (drift).

### Profile schema (sketch)

```
profile:
  id: string                 # stable name, e.g. "linux-1440x900-enGB"
  engineVersion: string      # pinned engine version this profile is valid for
  source: string             # where each value came from (measured | operator | corpus)
  provenance: string         # for corpus-derived data: dataset + license (see O4)
  tierF:
    viewport: {width, height, dpr}
    locale: string
    timezone: string
    acceptLanguage: string
    colorScheme: "light"|"dark"
    graphicsBackend: "localGpu"|"software"   # remote: section 7
  tierI:                      # optional; validator-gated, never auto-set from proxy
    osPlatform: string
    webglVendor: string
    webglRenderer: string
    webgpuAdapter: {...}
    personaProfileRef: string
```

Each value records its `source`. Measured values (the real backend) are distinct from operator-set
configuration, which is distinct from corpus-derived profile data (which carries `provenance`).
The proxy's observed region is a fourth, separate category and is never written into identity.

### Validation strategy

A post-launch probe reads the page-visible values (GPU strings, canvas hash behavior, `screen.*`,
`devicePixelRatio`, `performance.memory`, `navigator.mediaCapabilities`, font availability, OS
platform) and compares them to the measured runtime/backend:

- Tier-F field: assert reported == profile value (the browser applied the config).
- Tier-I field: assert reported == *measured actual*; if the profile set a divergent Tier-I value,
  the validator flags it and host-truth mode is the default that prevents it. The session does not
  start in a state where a Tier-I claim contradicts the backend unless the operator explicitly
  overrides, and that override is recorded in the audit log and never reported as "verified".

Acceptance criteria for the profile system are in section 9 (WS4).

## 7. Canvas-bridge and remote GPU: feasibility and decision

Requirement as briefed: optionally render on a real GPU (e.g. the user's Mac) for a GPU-less
server, authenticated and TLS-protected, sandbox-safe.

Findings:
- The existing `065` canvas-bridge is **not** a safe basis. It requires `--no-sandbox`
  (`canvas_bridge_client.h:683-685`), uses raw TCP with no TLS, does not verify the WebSocket
  handshake, has an unbounded frame allocation (B1), and bypasses its own origin policy for WebGL
  (B2). Its stated purpose (`:676-680`) is to keep a spoofed GPU persona coherent with what a
  page hashes - i.e. anti-detection, the out-of-scope use.
- Decision: **do not build on the canvas-bridge, and do not weaken the sandbox.** Remove it or
  hard-gate it off with a test that fails any launch that passes `--no-sandbox` or sets
  `--canvas-bridge-url` (remove-vs-disable is open item O5).
- Decision (confirmed with product owner): the selectable graphics backend offers **both** of:
  1. **Software rendering** on the server (SwiftShader/llvmpipe), reported truthfully. Default on a
     GPU-less server. Correct for most agent web workflows; slower for heavy WebGL/WebGPU.
  2. **Run on a GPU host**: run the browser on a machine that has a real GPU (a GPU VM, or the
     user's Mac via the existing PairBrowse sharing) instead of a GPU-less server. The profile
     selects the backend; the browser reports the one actually in use.
  A GPU-passthrough/vGPU server is a third infra option, not a browser patch. None of these
  require a remote-pixel bridge or an unsandboxed renderer. The excluded canvas-bridge is the
  only approach ruled out.

## 8. Security, privacy, operational risks

- WS2 access grant: single-use, 15-min expiry, scoped to one session+tab, delivered only to the
  configured channel; revoke on use or expiry. Audit every grant (who/when/what). Document in
  `docs/security.md` as a new row with tests (the security table requires named tests).
- WS2 notification channels send a live view URL off the machine. Treat the URL as a secret;
  never put it in a web page/form (existing core rule). Document each channel's data exposure.
- WS3 fail-closed: when DNS/WebRTC can't be confined to the proxy, block and hand off rather than
  leak. WebRTC/mDNS knobs (`webrtcIp`, `webrtcMdns`) configure what the browser reports and must
  not be mistaken for a real leak guarantee.
- WS4: removing the bridge removes an OOM/RCE-adjacent surface. Host-truth mode reduces the risk
  of the browser claiming hardware it lacks.
- Sandbox: never disabled. A test asserts the renderer sandbox stays on
  (`native-engine.mjs` sandbox default, today at the launcher).

## 9. Testing strategy and acceptance criteria

WS1: on a Linux box with no monitor, the daemon starts a headed browser on Xvfb, loads a page,
survives a browser crash with session restored, and cleans up Xvfb/locks on exit. Configurable
geometry honored. Acceptance: integration test in `test/integration/` behind
`PAIRBROWSE_TEST_RUNTIME`.

WS2: hand-off mints a grant that works once, is rejected after use and after 15 min, and only for
its session+tab; each configured channel receives exactly one message and one reminder; no
response -> progress saved and safe stop. Acceptance: unit tests for grant lifecycle + a mock for
each sender; a `docs/security.md` row with named tests.

WS3: with a known proxy, observed egress IP == proxy IP; DNS and WebRTC do not reveal the real
IP; an induced leak fails closed; a mid-session egress change pauses+notifies. Acceptance:
opt-in tests behind a proxy switch; the egress observation is stored separately from
environment config (asserted).

WS4: host-truth mode - page-read GPU strings, canvas hash, `screen.*`, `devicePixelRatio`,
`performance.memory`, `navigator.mediaCapabilities`, and font list all equal the real host's
values on a GPU-less Linux server (software renderer reported truthfully). WebGL/WebGPU either
succeed via software or return a defined truthful "unavailable". Canvas-bridge absent/locked:
a test fails any `--no-sandbox` or `--canvas-bridge-url` launch. Acceptance: native tests
(`test/*_test.py`) + a public-repo launcher test.

WS4 profiles: a profile can be created, stored, selected, and retired; two sessions on different
profiles cannot read each other's cookies/storage/logins (isolation asserted); a profile's Tier-F
values (browser version, locale, timezone, language, viewport, DPR, color scheme, backend) are
reported as set; the validator passes a Tier-F-only profile on any host and fails a profile whose
Tier-I value contradicts the measured backend; existing config loads unchanged (migration).
Acceptance: unit tests for lifecycle + isolation + validator; an integration test asserting
isolation across two live sessions.

## 10. Migration, rollout, recovery

- WS1 changes the "always headed, no headless" wording to "always headed; on a headless Linux
  server, headed on a private virtual display" - a documentation clarification, not a headless
  mode. No behavior regression on desktop.
- WS2/WS3 are additive and opt-in via config; default behavior unchanged.
- WS4 host-truth mode is the default for a server install; persona options remain in config but
  are documented as explicit configuration, never a verified property. Canvas-bridge removal is a
  native patch-series change gated behind the normal build/gate cycle.
- Recovery: WS1 supervisor restarts the display/browser; sessions restore from existing tab/session
  memory.

## 11. Unresolved items

- O1: exact current Xvfb lifecycle/supervision in `display.mjs` and daemon start (trace before WS1).
- O2: which notification channels to ship first (WS2) and their config shape.
- O3: proxy credential storage - reuse the facts/secret store or a new per-session secret
  (WS3).
- O4: font/profile data provenance and license (section 6) - needed for the "documented
  provenance and licensing" requirement regardless of the spoofing question.
- O5: whether to remove the canvas-bridge patch outright or keep it present but hard-disabled with
  a guard test (section 7).
- O6: RESOLVED - both software rendering and GPU-host are selectable backends (section 7).
- O7: exact mapping from the existing persona/config infrastructure onto the new profile schema,
  including which current `"pairbrowse"` config keys become Tier-F vs Tier-I (migration, section 6a).
- O8: profile storage layout and the browser-engine mechanism for true per-profile isolation
  (separate persistent contexts) on the native build - builder-settleable after a trace, but needs
  confirming the native engine supports N isolated profile dirs cleanly.

## 12. Phased plan (complexity estimate)

- Phase A (M): WS1 server mode - supervisor, configurable geometry, crash recovery, doc wording.
- Phase B (M): WS2 hand-off - access grants + one or two notification channels.
- Phase C (L): WS3 proxy + leak guard + egress observation (new subsystem).
- Phase D (M): WS2 remaining channels + audit/security-table row.
- Phase E (L): WS4 profile-management system (storage, lifecycle, per-profile isolation, Tier-F
  config, migration from existing config) + host-truth mode + validator + tests; canvas-bridge
  removal/guard; profile provenance.

Persona hardware-fabrication for anti-detection is not scheduled; its absence is recorded as an
explicit architecture decision (section 7) with alternatives, not a dropped requirement.
