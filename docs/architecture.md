# Architecture

How PairBrowse is put together: its parts, how they talk, and where the trust boundaries are. For
what each boundary protects against, see [security.md](security.md) and the
[assurance case](assurance-case.md).

## The parts

```
 Claude Code / Codex                          your computer, your user account
 ┌──────────────────────┐
 │ agent                │  tool call   ┌───────────────┐ private socket ┌──────────────────────────┐
 │  PreToolUse hook ────┼─(guard.mjs)─▶│ launch.mjs    │───────────────▶│ helper (daemon.mjs)      │
 │  PostToolUse hook    │   stdio MCP  │ stdio bridge  │  (in a folder  │  serve: refusal checks,  │
 │  runs MCP server     │◀─────────────│               │   only you open│   policy, secrets        │
 └──────────────────────┘              └───────────────┘                │  context: browser, tabs  │
                                                                        │  hud, panel, output mask │
                                                                        │  sharing, live view      │
                                                                        └──────┬───────────┬───────┘
                                                                 pipe (no TCP  │           │ loopback + key
                                                                 debug port)   ▼           ▼
                                                                  ┌─────────────────┐  ┌───────────────┐
                                                                  │ PairBrowse      │  │ live view     │
                                                                  │ browser         │  │ (127.0.0.1)   │
                                                                  │ (Chromium,      │  └──────┬────────┘
                                                                  │  own profile)   │         │ only when you invite
                                                                  └─────────────────┘         ▼
                                                                                     Cloudflare Quick Tunnel
                                                                                     ─▶ joiners (key + your Allow)
```

- **Plugin manifests** (`.claude-plugin/`, `.codex-plugin/`, `.mcp.json`, `.codex-plugin/mcp.json`): register the
  `browser` and `runs` MCP servers and the hooks with Claude Code or Codex.
- **Bridge** (`scripts/launch.mjs`, the entry; the code is `scripts/launcher/bridge.mjs`): the process
  the agent app starts. It installs the pinned runtime (`scripts/runtime.mjs`: `runtime/`, from a
  lockfile, install scripts off) on first use and connects to the helper, starting it if needed
  (`scripts/launcher/daemon-connect.mjs`, which the hand-open path `scripts/open.mjs` shares).
- **Homes and instances** (`scripts/home.mjs`, `scripts/paths.mjs`): which home a process uses
  (`PAIRBROWSE_HOME`, a named instance, or `~/.pairbrowse`) and every path built from it. Instances
  share one set of read-only installs (runtime, browser app, engine pack, cloudflared), filled one at
  a time (`scripts/install-lock.mjs`). A browser opened by hand finds its helper through the opener
  registry (`scripts/openers.mjs`, `scripts/opener.mjs`) and `scripts/open.mjs`.
- **Helper** (`scripts/daemon.mjs` and `scripts/daemon/`): one long-running process per home. It
  owns the browser and serves every tool call. Each part is a `createX(deps)` factory:
  - `serve` (one connection per agent: its state, its tab and turns, refusal checks, its own tools by
    family, then each result; parts in `daemon/serve/`, the tools in `daemon/serve/tools/`);
    `approvals` (hook lines and the approval cards); `pause` (a person pauses every agent);
    `fields` (a field a person is filling stays theirs); `linkwait` (agents wait while a sharing
    connection moves).
  - `context` (browser, sessions, downloads, tabs; parts in `daemon/browser/` and
    `daemon/sessions/`, the session picker and switch); `pick` (session choices from the browser's
    own pages); `taborder` and `tablabels` (the tab strip); `reveal` (finds what a narrow layout
    folded away, by structure only); `preview` (read-only previews of downloads).
  - `presence` (people using the browser), `hud` (badge, bar, cursor), `screenshot`, `drag`,
    `output` (masking what the agent reads), `panel` (side panel), `toolstab` (the Tools tab) with
    `diagnostics` (its scrubbed report), `activitylog` (the session's activity lines, bounded),
    `journal` (the goal log written as a run by itself), `timeline` (the session's pictures already
    sent to agents: local, capped, off by config), `outline` (the last whole-page snapshot an agent
    got per tab, in memory, dropped with the tab).
  - `capture` (where a tab's picture, sound and recordings come from: the extension or the
    browser's own capture page) and `recorder` (`pairbrowse_record`).
  - Sharing: `sharing` (invites, join codes) with `tunnel-pool` (the tunnels); `board` (who does what
    in a shared session, messages); `cobrowse` (shared tabs live: pointers, field changes) and
    `forms` (reading and setting shared form fields); `follow` (joining someone else's session;
    parts in `daemon/join/`) with `joinprompt` (the host's join alert); `screenshare` (shared
    browser mode on the host) with `remote-agents` (a joiner's agent working in the host's browser).
  With a native build that has its own pages, those `chrome://pairbrowse` pages are live view
  clients with a key of their own from an owner-only key file named in the launch switches; the
  picker's pick comes over `POST pick`.
- **Rules** (`scripts/rules/`): `policy.mjs` (which addresses open), `clicks.mjs` (which clicks need
  the user), `secrets.mjs` (where a password may be typed and how it is masked), `network.mjs`
  (loopback and private addresses), `upload.mjs` (which files may go), and `decide.mjs` (the
  guard's rules for every tool call, which the helper applies itself for clients whose hooks can't
  ask). Which tools exist and each tool's rules (blocked, hidden, approval, turn-taking,
  screenshots) are the tool catalog's (`scripts/tools/catalog.mjs`), which the helper, the hooks and
  the skill check all read.
- **Shared truths** (`ui/vocab.js`, `ui/urls.js`, `ui/limits.js`, `ui/events.js`): the words and
  colors, the browser's own addresses, the limits, and the live view's events with who gets each,
  that the helper, the in-page script and the pages share,
  as flat files at the `ui/` root (the live view serves them; the native build ships them).
- **Hooks** (`scripts/guard.mjs`, `scripts/log.mjs`, `scripts/session-start.mjs`): the PreToolUse
  hook asks the user before final actions; the PostToolUse hook writes the run log; session start
  adds the PairBrowse core instructions. Apps that can't ask (Codex) get the same decisions applied
  by the helper itself. The same `guard.mjs` is Claude Code's PermissionRequest hook too: for a
  named final click it sends one line on the private socket (`scripts/hookline.mjs`: it starts with
  `{"pairbrowse":"hook"`, which no MCP client's first message does) and waits for the browser's
  answer while the terminal asks; `scripts/daemon/approvals.mjs` routes that line, shows the
  approval card (the in-page card on the agent's tab in front, or the browser's own pages through
  `approvals.json` and the owner-only `approval` events) and answers the first Allow or Deny. For
  Codex the helper shows the card and waits itself, before the call takes its turn.
- **Runs server** (`scripts/runs.mjs`): saved runs and pre-submit reviews, no network.
- **Fast mode** (`scripts/runner.mjs` and `scripts/runner/`): `pairbrowse_run` and playbooks. Its
  parts find fields (`locate`), run steps (`steps`), choose in dropdowns (`choices`), read a
  click's risk from the page's structure (`risk`) and check the result (`verify`).
- **Browser** (`scripts/browser.mjs`, `scripts/browser/choice.mjs`, `scripts/native/`,
  `scripts/native-pack.mjs`, `scripts/native-engine.mjs`): a browser of its own with its own profile
  under the home, always visible. `browser/choice.mjs` picks the binary and the driver.
  `native-pack.mjs` pins the native builds and the engine pack; `native/pack.mjs` fetches and
  checks them; `native/install.mjs` installs a build (its by-hand entry is
  `scripts/native-install.mjs`) and `native/check.mjs` runs its launch self-check;
  `native/macos-app.mjs` brands the macOS app; `native-engine.mjs` launches it, with
  `native/humanize.mjs` for typing. Builds are pinned by SHA-256 and checked before every install.
- **Live view and sharing** (`scripts/liveview.mjs`, `scripts/liveview/`): a key-protected page on
  loopback. The server's routes are tables in `scripts/liveview/routes/` (each names the right it
  needs and the part of the helper it works with); bodies are read once, capped, in
  `scripts/liveview/http.mjs`. Beside them: `invites.mjs` (links and roles), `input.mjs` (replaying
  a viewer's input), `settings.mjs` (the config fields the browser's pages may change),
  `report.mjs` (Report a problem), `capture.mjs` (the capture page's channel). Only when the user
  invites someone, joiners come in on a separate port (`joiner-server.mjs`) through a tunnel, with a
  key and the user's Allow; `push.mjs` is the host's push channel per joiner (over `scripts/ws.mjs`)
  and `approval-share.mjs` hands approval cards to joiners with the approve role.
- **Joining and tunnels** (`scripts/sharing/`, `scripts/tunnels/`): `sharing/join.mjs` (join codes)
  and `sharing/join-client.mjs` (the joiner's side), `sharing/tabsync.mjs` (what of a shared tab may
  cross), `sharing/devshare.mjs` (sharing a localhost dev server). `tunnels/quick.mjs` runs a
  Cloudflare Quick Tunnel, kept by `tunnels/keeper.mjs` (entry `scripts/tunnel-keeper.mjs`);
  `tunnels/config.mjs` and `tunnels/start.mjs` run the user's own tunnel instead.
- **Side panel and page script** (`ui/`, the extension and the browser's own pages, one folder per
  page; `scripts/browser/` keeps the icon files; `scripts/hud.js`): the extension and in-page bar
  that show people what agents are doing; names and keys are random per run.
- **Test gate** (`scripts/testenv.mjs`, `scripts/test-gate.mjs`): every `PAIRBROWSE_TEST_*` switch
  the helper reads is listed in one place, and `daemon.mjs` imports the gate first, so unless the
  test harness started the helper those switches are gone from its environment.

## Data and state

Everything lives in the home (`~/.pairbrowse`, or an instance's own home), created private to the user: the browser profile, saved
details (facts), passwords (a separate file, readable only by the user), runs, logs, downloads,
and each session's timeline folder (`timeline/`, or `sessions/<name>.timeline/`: the pictures
already sent to agents, deleted with the session).
Nothing is sent to a PairBrowse server except a problem report you send yourself (Report a problem: what you saw and wrote, scrubbed, to `reportUrl`, by default `https://pairbrowse.com/api/report`; `null` turns it off; see docs/security.md). Network traffic is the user's own browsing,
the pinned downloads (GitHub, npm) and, while sharing, the tunnel.

## Trust boundaries

1. **Agent app → helper.** The agent is trusted to ask, not to decide: every call passes the
   hook and the helper's own checks (allowed tools, navigation, click classes, password domains).
2. **Web page → agent.** Page content is untrusted data. What the agent reads is masked
   (passwords, card numbers) and pages can't reach the helper, the socket or the badge's key.
3. **Other local users and programs → helper.** The socket and files are private to the user; the
   browser has no TCP debugging port.
4. **Joiners → helper.** A joiner needs a key and the user's Allow, gets only what their role and
   mode allow, and is rate-limited.
5. **Downloads → install.** Runtime packages, browser builds and the engine pack are checked
   against pins in this repository before use.
