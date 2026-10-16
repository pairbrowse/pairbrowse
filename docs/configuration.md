# Configuration

`~/.pairbrowse/config.json` (all optional):

```json
{
  "browser": "pairbrowse",
  "chromeArgs": ["--lang=en-US"]
}
```

- `browser`: which browser PairBrowse runs. `"pairbrowse"`: the native PairBrowse browser;
  `"chromium"`: ungoogled-chromium on macOS, Playwright's Chromium elsewhere, with the PairBrowse
  side panel; or an absolute path to Brave, Arc, Vivaldi or another Chromium-based browser of your
  own, launched like `"chromium"`. Unset: `"pairbrowse"` where a build is pinned for your computer,
  else `"chromium"`; the helper uses that default without writing it, and says so once in its log.
  A path must be an existing, executable file: otherwise the helper logs
  `browser: <path> isn't an executable file; using Chromium instead` and starts Chromium. With
  `"chromium"` or a path, nothing is downloaded or installed for the native browser. You're asked
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
- `chromeArgs`: extra Chromium flags, from a fixed list; anything else is dropped before launch and
  named once in the helper log and as a warning in `pairbrowse_status`. The list, each with the
  value it takes after `=` (Chromium never reads a switch's value from the next item, so write
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
  - `--headless` (`=new` or `=old`), for test runs ([ADR 0009](adr/0009-always-headed.md));
  - `--no-sandbox`, on Linux only, which works as `"chromeSandbox": false` in any spelling (refused on
    macOS and Windows, where the sandbox always stays on).

  Everything else is dropped: a debugging port, address or pipe, `--remote-allow-origins`,
  switches that run another program in place of a browser process (`--renderer-cmd-prefix`,
  `--gpu-launcher`, `--browser-subprocess-path`), certificate or web security checks off, a proxy,
  `--disable-features` (it is how site isolation is turned off), another profile or extension, and
  any switch not listed above. So is every item that isn't a switch (Chromium would open it as a
  page or file), and everything after a bare `--`. A switch written `-x`, or `/x` on Windows, is
  read like `--x`. A browser the test suite starts also takes `--use-mock-keychain`,
  `--password-store=basic` and `--disable-features=LocalNetworkAccessChecks`; an installed helper
  never does.
- `chromeSandbox`: on Linux, `false` turns off Chromium's own sandbox (default `true`); on macOS and
  Windows it always stays on and `false` is refused (a warning in `pairbrowse_status`). PairBrowse
  turns it off by itself only on Linux, where it can't run: as root, and where the system has no
  user namespaces (Docker's default seccomp profile or Ubuntu's AppArmor rule blocks them). While
  it's off, the helper log, `pairbrowse_status` and the bar at the bottom of the browser's pages say
  "The browser's sandbox is off: websites are less isolated from this computer". In a container,
  run as a regular user to keep it.
- `maxTabs`: most tabs open at once (default 20). When another opens, the tab used longest ago
  closes, never the one Claude is working in nor one anyone used in the last 10 minutes (then more
  stay open), and Claude is told.
- `screenshots`: `false` sends Claude text only, no screenshots. A result whose picture would be
  byte for byte the last one says so in a line instead of carrying the image again.
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
  launch): the browser loads no extension but PairBrowse's own side panel.
- `downloadsDir`: where site downloads and recordings are saved (default: your Downloads folder): an ordinary folder inside your home folder, checked as Settings checks it when the file is read and again at every save; one that fails is not used.
- `liveViewPort`: a fixed live view port (default: a random one each start).
- `liveViewHosts`: extra host names the live view answers to, for invite links only, such as
  your Tailscale name. Plain host names only. It still listens on `127.0.0.1` only.
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

Passwords go in `~/.pairbrowse/secrets.env` (kept at `chmod 600`; PairBrowse refuses to use it otherwise):

```
SHOPIFY_PASSWORD=...
SHOPIFY_PASSWORD_DOMAINS=accounts.shopify.com
```

Set `PAIRBROWSE_HOME` (in your shell or user settings; a project's own settings can't set it) to keep everything somewhere other than `~/.pairbrowse`, or run several
browsers side by side as named instances (`PAIRBROWSE_INSTANCE`, or a project's `.pairbrowse.json`:
[Several browsers: instances](using.md#several-browsers-instances)).
