# Configuration

`~/.pairbrowse/config.json` (all optional):

```json
{
  "executablePath": null,
  "chromeArgs": ["--lang=en-US"]
}
```

- `executablePath`: use Brave, Arc, Vivaldi or another Chromium build instead of the PairBrowse browser.
- `browserEngine`: `"auto"` (default: the native PairBrowse browser where a build is pinned for your computer (macOS, Linux x64, Windows x64), else `"chromium"`), `"pairbrowse"` or `"chromium"`.
- `browserDriver`: `"patchright"` (default and recommended, needs Node.js 20+) or `"playwright"`
  (optional opt-in: plain Playwright, easier for sites to detect). On a Node.js too old for
  Patchright, PairBrowse uses Playwright by itself and says so once (see [Install](install.md)); the
  pinned Playwright also requires Node.js 20+, so Node.js 20 or newer is effectively required either way.
- `chromeArgs`: extra Chromium flags.
- `chromeSandbox`: `false` turns off Chromium's own sandbox (default `true`). PairBrowse turns it off
  by itself only where it can't run: as root on Linux, and where the system has no user namespaces
  (Docker's default seccomp profile blocks them); the helper log says so once. In a container, run
  as a regular user to keep it.
- `maxTabs`: most tabs open at once (default 20). When another opens, the tab used longest ago
  closes, never the one Claude is working in nor one anyone used in the last 10 minutes (then more
  stay open), and Claude is told.
- `screenshots`: `false` sends Claude text only, no screenshots.
- `sessionPicker`: `false` turns off the session picker the browser shows when it starts (Claude
  asks in the chat instead). Default `true`.
- `downloadsDir`: where site downloads are saved (default: your Downloads folder).
- `liveViewPort`: a fixed live view port (default: a random one each start).
- `liveViewHosts`: extra host names the live view answers to, for invite links only, such as
  your Tailscale name. Plain host names only. It still listens on `127.0.0.1` only.
- `inviteBaseUrl`: where invite links point, such as `https://myhost.tail1234.ts.net`. Its host
  must be in `liveViewHosts`. See [Invite someone to watch or co-drive](sharing.md#invite-someone-to-watch-or-co-drive).

Passwords go in `~/.pairbrowse/secrets.env` (kept at `chmod 600`; PairBrowse refuses to use it otherwise):

```
SHOPIFY_PASSWORD=...
SHOPIFY_PASSWORD_DOMAINS=accounts.shopify.com
```

Set `PAIRBROWSE_HOME` to keep everything somewhere other than `~/.pairbrowse`.
