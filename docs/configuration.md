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
- `chromeArgs`: extra Chromium flags.
- `chromeSandbox`: `false` turns off Chromium's own sandbox (default `true`). PairBrowse turns it off
  by itself only where it can't run: as root on Linux, and where the system has no user namespaces
  (Docker's default seccomp profile or Ubuntu's AppArmor rule blocks them); the helper log says so once. In a container, run
  as a regular user to keep it.
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
- `settleMs`: the browser server's fixed pause after each action before it answers (default 200;
  Playwright MCP's own default is 500, and twice that when the action made requests). PairBrowse
  waits for the page itself after that (until its document is quiet, popups closed) before the
  picture, so a longer pause only slows things down; raise it for a page whose scripts react late
  without any request.
- `sessionPicker`: `false` turns off the session picker the browser shows when it starts (Claude
  asks in the chat instead). Default `true`.
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

The browser's own Settings page reads and changes `browser`, `timeline` with `timelineCap`, and
`layout` (nothing else) through the live view's owner-only `config.json` route; a change to the
timeline or the layout applies at once, a change of browser at its next start.

Passwords go in `~/.pairbrowse/secrets.env` (kept at `chmod 600`; PairBrowse refuses to use it otherwise):

```
SHOPIFY_PASSWORD=...
SHOPIFY_PASSWORD_DOMAINS=accounts.shopify.com
```

Set `PAIRBROWSE_HOME` (in your shell or user settings; a project's own settings can't set it) to keep everything somewhere other than `~/.pairbrowse`, or run several
browsers side by side as named instances (`PAIRBROWSE_INSTANCE`, or a project's `.pairbrowse.json`:
[Several browsers: instances](using.md#several-browsers-instances)).
