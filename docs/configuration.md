# Configuration

`~/.pairbrowse/config.json` (all optional):

```json
{
  "browser": "pairbrowse",
  "browserArgs": ["--lang=en-US"]
}
```

- `browser`: which browser PairBrowse runs. `"pairbrowse"`: the native PairBrowse browser;
  `"pairbrowse-open"`: PairBrowse (open build), a pinned open-source build on macOS and
  Playwright's browser elsewhere, with the PairBrowse side panel (the older value `"chromium"` still
  works and means the same); or an absolute path to Brave, Arc, Vivaldi or another compatible
  browser of your own, launched like `"pairbrowse-open"`. Unset: `"pairbrowse"` where a build is
  pinned for your computer, else `"pairbrowse-open"`; the helper uses that default without writing
  it, and says so once in its log. A path must be an existing, executable file: otherwise the helper
  logs `browser: <path> isn't an executable file; using PairBrowse (open build) instead` and
  starts the open build. With `"pairbrowse-open"` or a path, nothing is downloaded or installed for the native browser. You're asked
  once: in the terminal of the by-hand install step (`node scripts/native-install.mjs <file>`; Enter
  is PairBrowse), and in the browser's Settings page. Switching takes effect when the browser next
  starts on the same session profile: close the PairBrowse window or switch session. Sessions,
  secrets and remembered details are unchanged; the native build keeps its own logins as before.
- `browserEngine` and `executablePath`: older names, still read (as before, unchecked) while
  `browser` is unset, and never written.
- `browserDriver`: `"patchright"` (default and recommended, needs Node.js 20+) or `"playwright"`
  (optional opt-in: plain Playwright, easier for sites to detect). On a Node.js too old for
  Patchright, PairBrowse uses Playwright by itself and says so once (see [Install](install.md)); the
  pinned Playwright also requires Node.js 20+, so Node.js 20 or newer is effectively required either way.
- `browserArgs`: extra browser flags, from a fixed list (the older name `chromeArgs` is still read
  while `browserArgs` is unset, screened the same way); anything else is dropped before launch and
  named once in the helper log and as a warning in `pairbrowse_status`. The list, each with the
  value it takes after `=` (the browser never reads a switch's value from the next item, so write
  `"--lang=de"`, not `"--lang", "de"`):
  - language and window: `--lang=<language tag>`, `--window-size=<w>,<h>`,
    `--window-position=<x>,<y>`, `--start-maximized`, `--force-device-scale-factor=<number>`;
  - colors, fonts and motion: `--force-dark-mode`, `--force-prefers-reduced-motion`,
    `--force-color-profile=<name>`, `--font-render-hinting=none|slight|medium|full`,
    `--disable-font-subpixel-positioning`, `--disable-lcd-text`, `--hide-scrollbars`,
    `--disable-smooth-scrolling`, `--force-renderer-accessibility`;
  - GPU and display: `--disable-gpu`, `--disable-gpu-compositing`, `--use-gl=<name>`,
    `--use-angle=<name>`, `--ozone-platform=wayland|x11`, `--ozone-platform-hint=auto|wayland|x11`,
    `--disable-dev-shm-usage`;
  - sound and notifications: `--mute-audio`,
    `--autoplay-policy=no-user-gesture-required|user-gesture-required|document-user-activation-required`,
    `--disable-notifications`;
  - quieter starts and backgrounding: `--no-first-run`, `--no-default-browser-check`,
    `--hide-crash-restore-bubble`, `--test-type`, `--disable-renderer-backgrounding`,
    `--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows`;
  - `--enable-features=<Name>,<Name>` (feature names only; merged into the helper's own);
  - `--host-resolver-rules=` with rules that keep a name on this computer only:
    `MAP <name> 127.0.0.1[:port]` (or `localhost`, `[::1]`), `MAP <name> ~NOTFOUND`, `EXCLUDE <name>`;
  - `--no-sandbox`, on Linux only, which works as `"browserSandbox": false` in any spelling (refused on
    macOS and Windows, where the sandbox always stays on, and on Linux in server mode or with
    `"browserSandbox": "required"`).

  Everything else is dropped, `--headless` too: it passes only in a helper the test suite started
  ([ADR 0009](adr/0009-always-headed.md)), so your browser always shows its window. Also dropped: a
  debugging port, address or pipe, `--remote-allow-origins`, switches that run another program in
  place of a browser process (`--renderer-cmd-prefix`, `--gpu-launcher`, `--browser-subprocess-path`),
  certificate or web security checks off, a proxy, `--disable-features` (it is how site isolation is
  turned off), another profile or extension, and any switch not listed above. So is every item that
  isn't a switch (the browser would open it as a page or file), and everything after a bare `--`. A
  switch written `-x`, or `/x` on Windows, is read like `--x`. A browser the test suite starts also
  takes `--use-mock-keychain`, `--password-store=basic` and
  `--disable-features=LocalNetworkAccessChecks`; an installed helper never does.
- `browserSandbox`: on Linux, `false` turns off the browser's own sandbox (default `true`; the
  older name `chromeSandbox` is still read while `browserSandbox` is unset); on macOS and
  Windows it always stays on and `false` is refused (a warning in `pairbrowse_status`). PairBrowse
  turns it off by itself only on Linux, where it can't run: as root, and where the system has no
  user namespaces (Docker's default seccomp profile or Ubuntu's AppArmor rule blocks them). While
  it's off, the helper log, `pairbrowse_status` and the bar at the bottom of the browser's pages say
  "The browser's sandbox is off: websites are less isolated from this computer". In a container,
  run as a regular user to keep it.
  `"required"` keeps it on with no way off on Linux too: `false` is not possible beside it, a
  `--no-sandbox` in `browserArgs` is refused (a warning in `pairbrowse_status`), running as root
  refuses the launch ("the browser's sandbox can't run as root; run PairBrowse as a normal user"),
  and a system that can't run it refuses the launch instead of starting the browser without it.
  Server mode (PairBrowse's own virtual screen, or `server.keepAlive`) always works this way,
  whatever `browserSandbox` says; there is no opt-out. A container then needs user namespaces for
  that user: a seccomp profile or host setting that allows them, and a non-root user.
- `maxTabs`: most tabs open at once (default 20). When another opens, the tab used longest ago
  closes, never the one Claude is working in nor one anyone used in the last 10 minutes (then more
  stay open), and Claude is told.
- `screenshots`: `false` sends Claude text only, no screenshots. A result whose picture would be
  byte for byte the last one says so in a line instead of carrying the image again.
- `phishingProtection`: `true` (default) stops a top-level page on a site from Phishing.Database's list of active phishing domains (MIT licence; fetched every 6 hours, checked on this computer by host name, nothing about your browsing sent anywhere) and shows a warning with Go back and Continue anyway. `false` turns it off.
- `adBlocker`: `true` (default) turns on uBlock Origin Lite (`ddkjiahejlhfcafbddmgiahcphecmpfh`), which the PairBrowse browser app ships (builds whose manifest declares `adBlocker`, macOS): PairBrowse names the app's copy in the session profile's `External Extensions` folder and the browser checks and installs it, enabled. You can turn it off or remove it in the browser's extensions page; a removal sticks. It can read and change the pages it filters, as any ad blocker, and updates from the Chrome Web Store (each check tells the store its id and version). `false` removes PairBrowse's entry, and the browser removes the extension at its next start.
- `safeStorage`: on macOS, `"file"` (default) gives the PairBrowse browser (build 150.0.7871.114-3 and later) a random Safe Storage password of this install's own, the key to its cookies and saved data, in the owner-only file `~/.pairbrowse/safe-storage-key`: no Keychain prompt, ever. The first start with it logs every session out of its sites once. `"keychain"` uses the macOS Keychain instead (each new build signed without an Apple Team ID asks once). An older build keeps the driver's mock keychain (a fixed test password). Switching between `"file"` and `"keychain"`, or deleting the file, signs every session out again: the keys differ. On Linux, a native build declaring it uses the same key file (made and checked the same way) on top of `--password-store=basic`, so never a keyring prompt; `"keychain"` changes nothing there. Windows keeps the browser's own default.
- `timeline`: `false` keeps no timeline (default `true`). With it on, the pictures already sent to
  agents are also kept in the browser session's timeline folder under `~/.pairbrowse`, at most 200
  plus the ones you pinned (up to 50), deleted with the session. Nothing is captured for it; see
  the Security table.
- `timelineCap`: how many unpinned pictures the timeline keeps per session, 1 to 200 (default 200).
- `layout`: where the browser's own pages start, `{ "left": "open", "right": "open", "strip": 88 }`
  by default: each dock `"open"`, `"rail"` or `"hidden"`, and the tab strip's height in pixels (44
  to 176). Changes made in the browser last for the session while the helper runs. Written into the
  profile as `pairbrowse.layout` the first time a browser with its own pages starts; the browser
  keeps it after.
- `settleMs`: the browser server's fixed pause after each action before it answers (default 60; 200 in earlier
  versions;
  Playwright MCP's own default is 500, and twice that when the action made requests). PairBrowse
  waits for the page itself after that (until its document is quiet, popups closed) before the
  picture, so a longer pause only slows things down; raise it for a page whose scripts react late
  without any request.
- `sessionPicker`: `false` turns off the session picker the browser shows when it starts (Claude
  asks in the chat instead). Default `true`.
- `cookieChoice`: what agents press on a site's cookie banner: `"accept"` (default) or `"reject"`.
- `participantName`: the name people in a shared session see for you (or `PAIRBROWSE_PARTICIPANT`).
  Unset, you're asked once, and the answer is saved here.
- `display`: on a Linux machine without a screen, the browser runs headed on a private virtual
  screen (Xvfb): `"auto"` (default) uses one when there's no screen, `"xvfb"` always, `"none"` never.
  If that screen ends by itself, the browser on it closes and the next action starts a new screen
  and brings the tabs back.
  On a server (PairBrowse's own virtual screen, or `server.keepAlive`), a browser that closes by
  itself 3 times within 5 minutes, each within a minute of its start, is not started again for 5
  minutes (or until the helper restarts): actions say "the browser keeps crashing on this machine:
  see daemon.log", and so does `pairbrowse_status`.
- `virtualScreen`: that virtual screen's size and color depth: `{ "width": 1366, "height": 900,
  "depth": 24 }` (default). Width 800 to 7680, height 600 to 4320, depth 16 or 24; a field left out
  or out of range takes its default. The browser's window fills that screen from its top-left
  corner; a `--window-size` or `--window-position` in `browserArgs` still wins. Used only when
  PairBrowse runs its own virtual screen (`display` `"auto"` on a machine without a screen, or
  `"xvfb"`); elsewhere the window opens at 1366x900.
- `server`: `{ "keepAlive": false }` (default). `true` puts the helper in server mode (a helper kept
  running on a server, even one with a screen of its own, usually by the system's service manager):
  the browser starts as soon as the helper does and its saved tabs come back; a browser closed with
  nobody connected no longer ends the helper; any close PairBrowse didn't cause (a crash, or closing
  the window or quitting the browser by hand) brings the browser back after 2 s, then 10 s, then
  30 s for each further close (back to 2 s once a browser stayed up for a minute), never past the
  crash-loop limit above, which counts hand closes too; only stopping the helper keeps the browser
  closed; after a failed start the next action tries; a newer plugin version never stops this
  helper (`pairbrowse_status` says to restart the PairBrowse service to move to it); live view links
  say the browser runs on a server; and the crash-loop limit above and the server-mode sandbox rule
  (`browserSandbox`) apply. `pairbrowse_status` says "keep-alive on", or when the browser starts
  again. With `false`, a helper started over SSH keeps today's lifetime.
- `handoff`: hand-off messages to your phone, for when the browser runs on a server or you are away
  from it: `{ "enabled": false, "away": false, "publicLink": false, "grantMinutes": 15,
  "remindMinutes": 10, "channels": [] }` (default). On a computer you sit at, a step handed to you
  stays in the PairBrowse window as before; messages go only with `enabled` `true`, and then always
  in server mode, or on a desktop while `away` is `true`. `away` is the Away switch in the side
  panel's Tools tab (Hand-offs), Settings and the live view's Profile panel: off by default, saved
  here when you flip it (only `away` changes), and it turns on only with `enabled` and a channel
  that can be used; on a server it isn't a switch (messages always go). With a channel the step
  still shows in the window too, and whichever you use first does it. `grantMinutes` (1 to 120) is how long a
  link works; `remindMinutes` (1 or more) when the one reminder comes (at or after `grantMinutes` it falls back
  to two thirds of it, with a warning). `publicLink` (lets a link go through the sharing tunnel) is
  read and kept for the hand-off link that uses it. `channels` lists where messages go, each
  naming its credentials by a `PAIRBROWSE_` name you save in `secrets.env` (below), never the value:
  `{ "type": "webhook", "urlSecret": "PAIRBROWSE_WEBHOOK_URL" }` (a JSON POST of the event, id, step
  kind, site host, link and expiry to your own https address);
  `{ "type": "ntfy", "server": "https://ntfy.sh", "topicSecret": "PAIRBROWSE_NTFY_TOPIC",
  "tokenSecret": "PAIRBROWSE_NTFY_TOKEN", "link": "auto" }` (`server` and `tokenSecret` optional;
  `link` `"auto"` leaves the link out on `https://ntfy.sh` without a token, where anyone who knows
  the topic reads it, `"always"` or `"never"`);
  `{ "type": "telegram", "tokenSecret": "PAIRBROWSE_TELEGRAM_TOKEN", "chatSecret": "PAIRBROWSE_TELEGRAM_CHAT" }`
  (a bot's token and a chat id or `@channel`; optional `server` for a Bot API server of your own);
  `{ "type": "discord", "urlSecret": "PAIRBROWSE_DISCORD_WEBHOOK" }` and
  `{ "type": "slack", "urlSecret": "PAIRBROWSE_SLACK_WEBHOOK" }` (a channel webhook's address).
  Addresses are https (plain http only to this computer's loopback); a channel with an unknown type,
  a missing secret, a name without the `PAIRBROWSE_` prefix or a value that doesn't fit is skipped
  with a warning in `daemon.log` naming it, never its value. A message says only the step ("Sign in
  on example.com"), the site's host, the expiry time (UTC) and the link: never the agent's words,
  codes, passwords, card details or page text. Link previews are turned off where the service
  allows (Telegram, Discord, Slack). Messages go straight from the helper, never through a browser
  session's proxy, never following a redirect, each try bounded to 10 s with one retry after 5 s on
  a server or network error. A hand-off link reaches the live view the way invite links do: through
  a `liveViewHosts` name with `inviteBaseUrl` (a tailnet works on a phone with its app) or an SSH
  tunnel to this computer, never the join-code port. Opening it shows a page with the step, the
  site and the expiry and a "Take over" button; opening it uses nothing up (a chat app's link
  preview is harmless), and only the tap does, once. After the tap the phone shows the handed-over
  tab with a header (the step, the site, the time left, the connection, Done, the hand-off's own
  tabs): tap to click, drag to scroll, hold to press, pinch or + and - to zoom (on the phone only),
  and a "Type here" box that opens the phone's keyboard and passes each character to the field you
  tapped; a dropped connection comes back on its own without losing or repeating what you typed.
  When an agent hands you a step (`pairbrowse_status` kind `you`, with an optional `step`:
  `login`, `captcha`, `2fa`, `payment` or `other`, else read from its words) or PairBrowse sees a
  CAPTCHA, one link is made for that tab and sent; the agent's result says which channels it went
  to, for which tab and until when, never the link. Exactly one reminder comes at `remindMinutes`
  (with the link only if it hasn't been opened yet), and a message when the hand-off ends (the
  agent went on, the check cleared, the tab or browser closed), except when you pressed Done.
  While it is open, agents keep out of that tab and the tabs it opened: clicks, typing, keys,
  uploads, `pairbrowse_run`, navigating and closing it are refused (they may still read it and
  answer its dialogs). The agent waits with `browser_wait_for`, which returns as soon as the
  hand-off ends, and a fast-mode `handoff` step finishes when you press Done; when it ends the
  agent is told what you did there (field and button names only) and to look at the page first.
  If the browser restarts with `server.keepAlive`, the tab that comes back gets one new link with
  the same deadline ("The browser restarted; use this new link"); so does a restarted helper,
  once, before the deadline, from the session's `turn.json` (owner-only: the step, the tab's
  address, the deadline, whether it was reminded and the channels; never a key or link).
  Otherwise the ended message says the step was stopped safely. If
  nobody finishes the step in time, the goal log and the session's tabs are saved, the agent is
  told to stop there, the badge and the Tools tab say "Timed out", and the tab stays held (agents
  keep out) until a new hand-off, your own input in it, or the session ends. While a hand-off is
  open on a tab, and while it is held, agents read that tab masked as a joiner's agent does (card
  numbers and card, code and PIN field values) and its pictures with card fields covered.
  Each hand-off event (made, sent, reminded, opened, refused, ended, a channel that failed) is a
  line in `~/.pairbrowse/audit.jsonl` (owner-only, appended, moved to `audit.jsonl.1` at 1 MB):
  its time, the event, the hand-off's short id, the session, the page's origin and path, and words
  from a fixed list; never a key, link, secret, typed text or page content.
- `network`: per-session proxies, for you (the operator) to set here; no agent tool can set a
  proxy or a credential, and Settings doesn't show this block. `null` (default) or absent: every
  session connects directly. Its shape:
  `{ "proxies": { "us-east": { "server": "http://203.0.113.10:3128", "auth": true, "bypass": [],
  "expectEgress": ["203.0.113.0/24", "country:US"], "onEgressChange": "pause" } }, "default": null,
  "sessions": { "shop-a": "us-east", "shop-b": null }, "strict": true,
  "checkUrl": "https://cloudflare.com/cdn-cgi/trace", "recheckMinutes": 10 }`.
  A proxy's id is 1 to 34 lower-case letters, digits and `-`. `server` is `http://`, `https://`
  or `socks5://` with a host (a name, an IPv4 address or an IPv6 address in brackets) and an
  optional port (80, 443 and 1080 when left out); never a user name or password (an address with
  one is refused: credentials go only in `secrets.env`, below, as
  `PAIRBROWSE_PROXY_<ID>_USERNAME` and `_PASSWORD` with the id upper-cased and `-` as `_`, and
  `auth` `true` says the proxy needs them). SOCKS4, PAC files, `direct://` and an address with a
  path are refused, and so is a SOCKS5 proxy with `auth` (not supported yet). `bypass` lists
  hosts (`*.example.com`), addresses or ranges that go around the proxy; with `strict` `true`
  (the default) only `localhost`, `127.0.0.1`, `[::1]` and `::1` may. `expectEgress` lists the
  addresses, ranges or countries (`country:US`) the proxy's exit should be in (`null`: none), and
  `onEgressChange` is `"pause"` (default), `"notify"` or `"ignore"`. `checkUrl` is the https
  address the exit is checked against (it must answer `ip=` and `loc=` lines, as the default
  does) and `recheckMinutes` (1 to 1440) how often. Which proxy a session uses: its entry in `sessions` (an id, or `null` for direct), else its browser profile's
  network id, else `default`, else direct. This block fails closed: a proxy entry with a wrong
  value keeps the sessions using it from starting, a session naming an id `proxies` doesn't
  define doesn't start, and a block that can't be read (a wrong type or an unknown key at its top,
  or a `config.json` that can't be parsed when a browser starts) keeps every session from
  starting; none of them goes direct instead. Only a wrong `strict` or `recheckMinutes` falls
  back to its default (`true`, 10). Each problem is a warning in `daemon.log` and
  `pairbrowse_status` that names the key and the kind of value, never the value itself, and a save
  of a bad block is refused. PairBrowse never rewrites a `config.json` it can't parse: until it is
  fixed, every save to it (Settings, a name, an allowed join address) is refused. The block is
  read from the file each time a browser starts, and the browser starts with the session's proxy:
  this computer's own addresses (`localhost`, `127.0.0.1`, `[::1]`) always go around it, then
  the `bypass` entries. With `strict` `true`, the browser looks up no name itself except the
  proxy's own and `localhost` (every other one goes to the proxy) and sends no WebRTC traffic
  outside the proxy; a `--host-resolver-rules` of yours in `browserArgs` is dropped for such a
  session (one helper log line says so). A SOCKS5 session gets the same name rule even with
  `strict` `false`. A proxy with `auth` needs both secrets in `secrets.env` (4 characters or
  more each) and a PairBrowse build that reads them from an owner-only file the helper writes for
  that launch and deletes once the browser is up: no build does yet and the open build never will,
  so such a session doesn't start for now, with an error saying why. A session whose network can't
  be used doesn't start (its error says why); it never starts direct instead. Before any saved tab
  loads, at every start (a recovery after a crash included), the proxy's exit is checked: the
  helper reads `checkUrl` through the proxy, the browser reads it too and gathers WebRTC
  candidates, and without `expectEgress` this computer's own exit is read once to compare (never
  kept). The two exits must match and fall inside `expectEgress` (without one, differ from this
  computer's own), and with `strict` `true` WebRTC may show no address but that exit. Anything
  else, a timeout included (10 s), closes the browser before a saved tab opens: the session's
  starts are refused with the reason for a minute (at once again after you change `config.json`
  or `secrets.env`), `pairbrowse_status` says why and you get one notification. Each check is
  kept in the session's `network.json` (owner-only, the last 50; clean sessions: memory only)
  with the proxy's exit and country, never this computer's own address. The repeats every
  `recheckMinutes` and `onEgressChange` come in a later version.
- `reportUrl`: where a problem report you send yourself goes (default
  `https://pairbrowse.com/api/report`): an https address with no user, query or fragment.
  `null`: no report is ever sent, and Settings doesn't offer it.
- `dockWidth`, `dockHost`, `dockTop` and `dockMakeRoom`: the live view docked beside Claude (the
  desktop pane): its width in pixels (`null`: the pane's own), the app it docks to (default
  `"Claude"`), its distance from the screen's top (default 52), and whether that app's window
  makes room for it (default `false`).
- `pairbrowse`: the native PairBrowse build's own settings (`humanize`, `showCursor`, `typingPace`,
  `formMove`, `motion`, `profile`, `profileSelect`, `geoip`): see
  [The native PairBrowse browser](browser.md#the-native-pairbrowse-browser); and the engine's
  fingerprint options (`fingerprint`, `fingerprintProfile`, `timezone`, `acceptLanguage`,
  `platform`, the GPU, screen and hardware values; the full list is `PAIRBROWSE_ENGINE_KEYS` in
  `scripts/config-schema.mjs`). Any other key there, such as `extensions`, a proxy, launch options or
  switches, is named as an unknown key and never reaches the browser (the helper log says so at
  launch): the browser loads no extension but PairBrowse's own side panel. `canvasBridge` (the
  engine's option to send what pages draw to another program) is refused: a launch with it here or
  in a saved profile stops with an error naming it. A proxy in a saved profile (`profile`) or in the
  persona kept with a session (`pairbrowse-persona.json`) stops the launch too, with an error saying
  to move it to `network.proxies` (above): dropping it would turn a proxied session into a direct one.
  `geoip: true` sets the time zone, languages, location and WebRTC address from the region of the
  address sites see (the session's proxy's, else this computer's) at each launch; a value you set
  here or in a saved profile wins. What it finds is never kept in `pairbrowse-persona.json`, so it
  follows the proxy, and the lookup writes no address to the helper log; when it fails the launch
  stops with an error saying so. The engine's region database is still fetched once directly.
- `downloadsDir`: where site downloads and recordings are saved (default: your Downloads folder): an ordinary folder inside your home folder, checked as Settings checks it when the file is read and again at every save; one that fails is not used.
- `liveViewPort`: a fixed live view port (default: a random one each start).
- `liveViewHosts`: extra host names the live view answers to, for invite and hand-off links only,
  such as your Tailscale name. Plain host names only. It still listens on `127.0.0.1` only.
- `inviteBaseUrl`: where invite links point, such as `https://myhost.tail1234.ts.net`. Its host
  must be in `liveViewHosts`. See [Invite someone to watch or co-drive](sharing.md#invite-someone-to-watch-or-co-drive).
- `joinHosts`: https host names, besides `*.trycloudflare.com`, you accept in join codes (a host's
  own tunnel address, say). Exact names. **Always allow** in the side panel's prompt for such a
  code writes one here; **Remove** in its Join addresses section takes it out.
- `sharing.tunnel`: how join codes reach your computer: `{ "kind": "quick" }` (default, a
  Cloudflare Quick Tunnel), or your own `cloudflare` (token, hostname), `ngrok` (authtoken, domain),
  `tailscale` or `command` (run, url, env). `sharing.guestPort` pins the port join codes are served
  on, for a tunnel routed on the provider's side. See [Using your own tunnel](sharing.md#using-your-own-tunnel).

**Checked when read.** Every key above has one declared type and, where it has them, its allowed
values (`scripts/config-schema.mjs`; the `pairbrowse` block's own keys too, while its other keys are
the engine's and checked at launch). When the helper starts, a key it doesn't know (a misspelling,
say) is named in one line of `daemon.log` and in what `pairbrowse_status` answers, and otherwise
ignored. A value of the wrong type or out of range (`"maxTabs": "20"`, `"display": "always"`) is
refused: the helper uses that key's default, and says so the same two ways, naming the key, what it
takes, the value it found and the file to fix, for example
`config.json: maxTabs is a whole number of 1 or more, not "20" (a string); using the default for it until it is fixed in ~/.pairbrowse/config.json`.
The file is never rewritten for it. A file that isn't a JSON object is read as all defaults, with
the same warning. Anything PairBrowse writes into `config.json` (Settings, **Always allow**, your
name) is checked the same way first, and a wrong value is refused with that message: nothing is
written.

The browser's own Settings page reads and changes `browser`, `timeline` with `timelineCap`,
`layout`, `participantName`, `downloadsDir`, `screenshots`, `cookieChoice`, `maxTabs` (2 to 50)
and `sessionPicker` (nothing else) through the live view's owner-only `config.json` route. A
change to the timeline, the layout, the downloads folder, screenshots, the cookie choice or
`maxTabs` applies at once; your name applies to joins at once and to your label in this browser
from the helper's next start; `sessionPicker` from the next start; a change of browser when the
browser next starts.

Passwords go in `~/.pairbrowse/secrets.env` (your own regular file, kept at `chmod 600`; PairBrowse
refuses to use a file others can read, another user's file, or a link to a file elsewhere):

```
SHOPIFY_PASSWORD=...
SHOPIFY_PASSWORD_DOMAINS=accounts.shopify.com
```

The Profile panel writes the file whole (a new file renamed into place). Names starting with
`PAIRBROWSE_` are reserved for PairBrowse's own credentials, such as a proxy's or a hand-off
channel's: PairBrowse sets them itself, never types them into a page (a `_DOMAINS` line for one is
ignored), doesn't list them to Claude, and masks them like every password, in `daemon.log` too.

Set `PAIRBROWSE_HOME` (in your shell or user settings; a project's own settings can't set it) to keep everything somewhere other than `~/.pairbrowse`, or run several
browsers side by side as named instances (`PAIRBROWSE_INSTANCE`, or a project's `.pairbrowse.json`:
[Several browsers: instances](using.md#several-browsers-instances)).
