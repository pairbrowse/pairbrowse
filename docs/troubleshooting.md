# Troubleshooting

Each entry gives the symptom, the message as PairBrowse writes it (`<...>` marks a part filled in
at run time), the cause and the fix. The source file and function are named so you can read the
check yourself.

## Where to look first

- **The helper's log**: `~/.pairbrowse/daemon.log` (`paths.daemonLog` in `scripts/paths.mjs`). For a
  named instance it is `~/.pairbrowse/instances/<name>/daemon.log`; with `PAIRBROWSE_HOME` set, it is
  `$PAIRBROWSE_HOME/daemon.log`. The helper's own stdout and stderr go there too
  (`startDaemon` in `scripts/launcher/daemon-connect.mjs`). Each line starts with an ISO time.
- **Sharing tunnels' logs**: `~/.pairbrowse/tunnels/` (`paths.tunnels`).
- **Diagnostics**: the Tools tab in the side panel shows the helper's version, the browser in use
  and the last error lines of `daemon.log`, scrubbed of keys, paths and addresses
  (`scripts/daemon/diagnostics.mjs`).
- **A diagnostics bundle for a bug report**: `node scripts/diagnostics-bundle.mjs [--out <folder>]`
  (from the plugin's folder) writes `pairbrowse-diagnostics-<time>/` (default under
  `~/.pairbrowse/diagnostics`): `summary.json` (the helper's, both plugin manifests' and the pinned
  runtime's versions, Node and the OS, the native build and engine pack installed, `config.json`
  with values scrubbed and secret-sounding settings such as `proxy` hidden, how many passwords are
  saved, the last uncaught exception with its stack) and `daemon-log.txt` (the last 400 lines of
  `daemon.log`). Every line goes through the same scrub as the Tools tab's diagnostics; nothing is
  sent anywhere. Look it over, then attach it yourself.
- **Which helper is running**: `~/.pairbrowse/daemon.lock` holds its process id (`claimHelper` in
  `scripts/daemon.mjs`). `ps -o pid=,command= -p "$(cat ~/.pairbrowse/daemon.lock)"` prints the
  `daemon.mjs` it runs from.

## The helper doesn't start

**Symptom.** Every browser tool fails at once; no PairBrowse window opens.

**Message.** `couldn't reach the PairBrowse daemon; see <home>/daemon.log`
(`connectLocal` in `scripts/launcher/daemon-connect.mjs`).

**Cause.** The bridge started a helper and waited about 15 seconds for its socket, which never
came up. The reason is in `daemon.log`: often `the runtime didn't load: <error>` (the pinned
`runtime/` install is broken; installing it can also fail with `npm ci failed: <npm output>`,
`ensureRuntime` in `scripts/runtime.mjs`) or `uncaught exception: <error>` (`main` in `scripts/daemon.mjs`).
On macOS, `PairBrowse Agent ended (<code>); starting the helper on Node` means the agent app inside
the native build refused to run and the bridge fell back to Node.

**Fix.** Read the last lines of `daemon.log`. For a runtime error, delete `~/.pairbrowse/runtime`
so the next start reinstalls it with `npm ci`. Then call any browser tool again.

## The browser doesn't start

**Symptom.** The helper runs, but the first browser action fails.

**Messages.**

- `The PairBrowse browser couldn't be installed: <reason> To use Chromium instead, set "browser": "chromium" in ~/.pairbrowse/config.json.`
  (`scripts/daemon/browser/launch.mjs`). `<reason>` is one of the install errors below.
- `There's no PairBrowse browser build for <platform> <arch> yet. To use Chromium instead, set "browser": "chromium" in ~/.pairbrowse/config.json.`
  (same file).
- `PairBrowse <version> isn't installed (<reason>). Install it with: node <plugin>/scripts/native-install.mjs <archive>`
  (`ensureNativeBrowser` in `scripts/native/install.mjs`).
- `the PairBrowse browser is open: quit it (or stop the PairBrowse helper) and try again`
  (`scripts/native/install.mjs`): an update can't replace a running app.
- `couldn't download <file> (HTTP <status>)` (`downloadPinned` in `scripts/util.mjs`).
- `Chromium didn't install at <path>. Run: node <runtime>/node_modules/<driver>/cli.js install --with-deps chromium`
  (`ensureBrowser` in `scripts/browser.mjs`, Linux and Windows).
- `PairBrowse macOS host capture failed: <error>` (`scripts/native-engine.mjs`): the first launch
  on a Mac measures it, and that step failed.
- `The PairBrowse browser didn't start: <why>. Open it again.` (a notification; the log says
  `the browser opened by hand didn't start: <why>`, `scripts/daemon/browser/launch.mjs`).

**Cause.** The native build couldn't be downloaded, checked or installed, or Chromium wasn't
downloaded on Linux.

**Fix.** Check your network and free space, quit any open PairBrowse window, and retry. To install
a build by hand, download the archive named in the message from the release and run the
`native-install.mjs` command it prints. To skip the native build, set `"browser": "chromium"` in
`~/.pairbrowse/config.json`.

## macOS: signature or Gatekeeper refusal

**Symptom.** On macOS, the native build or a browser app of your own is refused.

**Messages.**

- `the app's signature doesn't verify: <codesign output>` (`verifySignature` in
  `scripts/native/macos-app.mjs`), shown inside "The PairBrowse browser couldn't be installed".
- `the app's <key> isn't <value>: not a PairBrowse build` (`brandNativeApp`, same file).
- `<App>.app's code signature doesn't verify: PairBrowse only starts a browser app macOS can vouch for.`
  (`browserProblem` in `scripts/liveview/settings.mjs`), for a browser chosen in Settings.

**Cause.** PairBrowse checks the archive's SHA-256, verifies the app's code signature
(`codesign --verify --deep --strict`), then removes the quarantine mark itself from a build it has
checked (`xattr -cr`), so a correct install never shows a Gatekeeper prompt. A failed check means
the archive or app was changed, damaged, or is not a PairBrowse build. On the open setup,
ungoogled-chromium must pass `spctl -a -t install` (notarization) before it is copied out of its
disk image (`ungoogledApp` in `scripts/browser.mjs`).

**Fix.** Don't clear quarantine or re-sign the app by hand. Delete the download in
`~/.pairbrowse/downloads/` and let the next start fetch it again, or install the official archive
with `native-install.mjs`. For a browser of your own, choose an app whose signature verifies.

## Socket path too long

**Symptom.** With `PAIRBROWSE_HOME` set to a deep folder, the helper exits at once and tools say
`couldn't reach the PairBrowse daemon; see <home>/daemon.log`.

**Message.** In `daemon.log`: `uncaught exception: <the socket's listen error>` (`main` in
`scripts/daemon.mjs`). PairBrowse has no message of its own for this case.

**Cause.** The helper listens on `<home>/run/browser.sock` (`paths.socket` in
`scripts/paths.mjs`). A Unix socket path has a hard length limit (104 bytes on macOS, 108 on
Linux), and a long home path passes it. Test helpers under a scratchpad folder hit this, which is
why the test harness uses the system temporary folder, or `/tmp` when even that is too long
(`testBase()` in `test/helpers/live.mjs`).

**Fix.** Point `PAIRBROWSE_HOME` at a short path, or use a named instance (below), whose home
`~/.pairbrowse/instances/<name>` stays short.

## Another helper is already running

**Symptom.** A new helper exits right away; your actions go to a browser that's already open.

**Message.** `another daemon is running; exiting` in `daemon.log` (`claimHelper` and `main` in
`scripts/daemon.mjs`).

**Cause.** One home runs one helper and one browser. Every Claude Code or Codex window starts a
helper when it finds none; the second one finds the lock (`daemon.lock`, held by a live process) or
a socket that answers, and leaves. This is normal, not an error.

Installs are serialized too: `another PairBrowse helper is installing; waiting for it`, and after
15 minutes `another PairBrowse install is still running (process <pid>); try again in a minute`
(`withInstallLock` in `scripts/install-lock.mjs`). The by-hand installer says
`another PairBrowse install is running (process <pid>)` (`scripts/native/install.mjs`).

**Fix.** Nothing, if one shared browser is what you want. To run separate browsers on one
computer, use named instances (`scripts/home.mjs`): set `PAIRBROWSE_INSTANCE=<name>` in your own
shell or user settings, or put `{"instance": "<name>"}` in `.pairbrowse.json` in the project
folder. Each instance has its own profile, sessions, config, secrets, logs and socket under
`~/.pairbrowse/instances/<name>`, and shares the read-only installs. `pairbrowse_status` names the
instance in use. A bad name stops the start:
`PAIRBROWSE_INSTANCE must be 1 to 32 of a-z, 0-9 and - (got "<value>")` (`resolveHome`). A project's
own `.claude/settings.json` or `.codex` settings can't set `PAIRBROWSE_HOME`; `pairbrowse_status`
then reports `ignored: PAIRBROWSE_HOME set by this project's settings`.

## An old helper keeps running after a plugin update

**Symptom.** You updated the plugin, but behaviour is unchanged, or a fix you expect is missing.

**Message.** None. The bridge connects to whatever helper already listens on the socket
(`connectLocal` in `scripts/launcher/daemon-connect.mjs`); it doesn't compare versions.

**Cause.** The helper outlives the Claude Code session that started it. After an update it still
runs `daemon.mjs` from the older copy in `~/.claude/plugins/cache/`.

**Fix.** See which file runs:

```bash
ps -o pid=,command= -p "$(cat ~/.pairbrowse/daemon.lock)"
```

Update the plugin (`claude plugin marketplace update pairbrowse && claude plugin update
pairbrowse@pairbrowse`), then stop the old helper: close the PairBrowse window with no agent
connected, or `kill <pid>` (SIGTERM closes the browser cleanly first, `shutdown` in
`scripts/daemon.mjs`). Restart Claude Code; the next browser action starts the new helper.

## CONNECTION_CLOSED on the browser and runs servers in the PairBrowse repo

**Symptom.** Working inside a clone of this repository, Claude Code reports `browser` and `runs`
MCP servers failing with `CONNECTION_CLOSED`.

**Message.** `CONNECTION_CLOSED` comes from Claude Code, not from PairBrowse.

**Cause.** The repo's `.mcp.json` is the plugin's server list. Claude Code also loads it as a
project-scope config, where `${CLAUDE_PLUGIN_ROOT}` isn't set, so that duplicate copy can't start.

**Fix.** Ignore it: the plugin's own `browser` and `runs` servers load as well and their tools work.
You can decline the project's servers when Claude Code asks to approve them.

## Join code refused or expired

**Symptom.** Pasting a join code fails, or a joiner drops out.

**Messages** (`parseJoinCode` in `scripts/sharing/join.mjs`, checked before anything is sent):

- `A join code starts with pb-join:`
- `That join code is damaged. Ask for it again.`
- `That join code is from another PairBrowse version.`
- `That join code has no valid address.`
- `A join code's address must start with https://.`
- `That join code's address has extra parts. Ask for it again.`
- `That join code's key is damaged. Ask for it again.`
- `That join code points to <host>, which isn't a Cloudflare Quick Tunnel address (*.trycloudflare.com) or an address you allowed.`

**Messages** from the host's answer (`understand` in `scripts/sharing/join-client.mjs`):

- `This join code doesn't work any more (revoked, expired, or the host closed their browser). Ask for a new one.`
- `Waiting for <host> to approve. They see your request now.`
- `<Host> didn't let you in.` or `<Host> took you out of the session.`

**Cause.** The code was cut or changed in transit, made by a different PairBrowse version, revoked,
past its expiry, or the host closed their browser (sharing ends with the window). A code through
the host's own tunnel (ngrok, Tailscale, a command) points to an address you haven't allowed yet.

**Fix.** Ask the host for a fresh code and paste it whole. Update both sides to the same
PairBrowse version. For a host's own tunnel, choose Allow once or Always allow when PairBrowse asks
about the address. The host can list live codes with `pairbrowse_invite` `list`.

## Sharing tunnel down

**Symptom.** Making a join code fails on the host, or joiners can't reach the session.

**Messages** on the host (`scripts/daemon/sharing.mjs`, `scripts/tunnels/quick.mjs`):

- `Sharing couldn't start: <reason>. Nothing was shared.` with reasons such as
  `the sharing connection didn't come up in time`,
  `the sharing connection ended (exit <code>): <cloudflared error>`,
  `too many fresh sharing connections were opened from this computer in a short time; sharing works again in a few minutes`
  (`tunnelExitReason`), or
  `sharing needs cloudflared, which has no build for <platform>-<arch>`.
- `Sharing couldn't start: port <port> (sharing.guestPort in config.json) is in use by another program. Free it or pin another port, and point your tunnel at it. Nothing was shared.`
- A bad `sharing.tunnel` setting:
  `sharing.tunnel.kind "<kind>" isn't one of cloudflare, ngrok, tailscale or command`, or
  `<program> gave <scheme>, not an https address; joiners need https` (`scripts/tunnels/start.mjs`).
- In `daemon.log`: `tunnel <host> isn't answering; replacing it` (`watchTunnel`) and
  `sharing tunnel didn't start: <error>` (`scripts/daemon/tunnel-pool.mjs`).

**Messages** on the joiner (`scripts/sharing/join-client.mjs`):
`Can't reach the host's session right now. Retrying.`, then
`Can't reach the host's session for a while. Still retrying; ask the host for a new code if it doesn't come back.`

**Cause.** The Quick Tunnel's `cloudflared` couldn't connect, was rate limited, or stopped; the
host's helper is gone (Cloudflare's own 502 or 530 page); or the host's own tunnel setting is
wrong. Each tunnel runs under a keeper (`scripts/tunnel-keeper.mjs`) that survives a helper restart
and stops on its own once no helper has been alive for a while.

**Fix.** On the host, check network access to Cloudflare and read the newest file in
`~/.pairbrowse/tunnels/`. After a rate limit, wait a few minutes. Then make a new code. Joiners keep
retrying by themselves while the host's helper restarts.

## Engine pack hash mismatch

**Symptom.** The native browser stops launching after files under the engine folder changed, or a
download is refused.

**Messages** (`scripts/native/pack.mjs` and `scripts/util.mjs`):

- `the engine pack's <file> doesn't match its pinned SHA-256` (`checkEngineFiles`, run at install
  and again before every load in `loadEngine`)
- `the engine pack has no <file>`
- `<archive> doesn't match its SHA-256 (expected <sha256>, got <sha256>)` (`installEngine`; the
  native build's archive gives the same message from `scripts/native/install.mjs`)
- `the <file> download doesn't match its pinned SHA-256` (`downloadPinned`)
- `not a PairBrowse engine pack`
- `the PairBrowse engine isn't installed (<reason>). Install it with: node <plugin>/scripts/native-install.mjs <archive>` (`ensureEngine`)

**Cause.** Each engine pack file is pinned by SHA-256 in `scripts/native-pack.mjs` and checked
before it is loaded. A changed or partly written file, a damaged download, or a plugin version
whose pins differ from the installed pack fails the check, and the browser doesn't launch with it.

**Fix.** Stop the helper, delete `~/.pairbrowse/engine` and any matching file in
`~/.pairbrowse/downloads/`, then start again: the pinned pack downloads and is checked anew. If the
download itself keeps failing the check, something between you and GitHub changes it; install the
archive by hand with the `native-install.mjs` command from the message.
