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
  - `--headless` (`=new` or `=old`), for test runs ([ADR 0009](adr/0009-always-headed.md));
  - `--no-sandbox`, on Linux only, which works as `"browserSandbox": false` in any spelling (refused on
    macOS and Windows, where the sandbox always stays on).

  Everything else is dropped: a debugging port, address or pipe, `--remote-allow-origins`,
  switches that run another program in place of a browser process (`--renderer-cmd-prefix`,
  `--gpu-launcher`, `--browser-subprocess-path`), certificate or web security checks off, a proxy,
  `--disable-features` (it is how site isolation is turned off), another profile or extension, and
  any switch not listed above. So is every item that isn't a switch (the browser would open it as a
  page or file), and everything after a bare `--`. A switch written `-x`, or `/x` on Windows, is
  read like `--x`. A browser the test suite starts also takes `--use-mock-keychain`,
  `--password-store=basic` and `--disable-features=LocalNetworkAccessChecks`; an installed helper
  never does.
- `browserSandbox`: on Linux, `false` turns off the browser's own sandbox (default `true`; the
  older name `chromeSandbox` is still read while `browserSandbox` is unset); on macOS and
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
- `phishingProtection`: `true` (default) stops a top-level page on a site from Phishing.Database's list of active phishing domains (MIT licence; fetched every 6 hours, checked on this computer by host name, nothing about your browsing sent anywhere) and shows a warning with Go back and Continue anyway. `false` turns it off.
- `adBlocker`: `true` (default) turns on uBlock Origin Lite (`ddkjiahejlhfcafbddmgiahcphecmpfh`), which the PairBrowse browser app ships (builds whose manifest declares `adBlocker`, macOS): PairBrowse names the app's copy in the session profile's `External Extensions` folder and the browser checks and installs it, enabled. You can turn it off or remove it in the browser's extensions page; a removal sticks. It can read and change the pages it filters, as any ad blocker, and updates from the Chrome Web Store (each check tells the store its id and version). `false` removes PairBrowse's entry, and the browser removes the extension at its next start.
- `safeStorage`: `"file"` (default) has a PairBrowse browser build that can (patch 594) keep its Safe Storage password (the key to its cookies and saved data) in the owner-only file `~/.pairbrowse/safe-storage-key`, copied once from the Keychain, so macOS doesn't ask for "PairBrowse Safe Storage" at every new build. `"keychain"` keeps it in the Keychain only (each new build signed without an Apple Team ID asks once); a file already written stays, holding the same password, until you delete it.
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
