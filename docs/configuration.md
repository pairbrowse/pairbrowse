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
- `browserDriver`: `"patchright"` (default, needs Node.js 20+) or `"playwright"`.
- `chromeArgs`: extra Chromium flags.
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
