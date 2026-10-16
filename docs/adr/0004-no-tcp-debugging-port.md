# 4. No TCP debugging port: the browser is driven over a pipe

- Status: Accepted
- Date: by v0.13.1 (2026-10-04), the first release in this repository's history ([CHANGELOG](../../CHANGELOG.md) 0.13.1)

## Context

The browser holds the user's logins. A DevTools Protocol (CDP) port on localhost
(`--remote-debugging-port`) lets any local program, or any other user on the machine, attach and
drive that logged-in browser with no key. Browser automation tools commonly open such a port.

## Decision

- The helper launches the browser itself with Playwright's persistent context, which talks to it
  over a private pipe (Playwright's default). PairBrowse never adds a debugging port.
- The only way into the helper is a socket file in `~/.pairbrowse/run`, a folder only the user's
  account can open. Agents reach the browser only through that socket and the helper's checks.
- The helper drives only a browser it launched, over that launch's pipe; a browser opened by hand
  hands its start to the helper instead of becoming drivable.
- The project rules forbid adding a TCP debugging port ([../../.claude/CLAUDE.md](../../.claude/CLAUDE.md), Rules).

## Consequences

- Other local programs and users can't take over the browser
  ([security.md](../security.md), "Another program or user on your computer takes over the
  logged-in browser"; [architecture.md](../architecture.md#trust-boundaries), boundary 3).
- The helper must own the browser's lifetime; it can't attach to an already running browser, so a
  hand-opened PairBrowse window goes through the opener (`scripts/open.mjs`).
- Tools that expect a CDP endpoint can't be pointed at the PairBrowse browser.
- `browserArgs` (older name `chromeArgs`) in the user's own `config.json` can't add one either: they are screened against an
  allowlist before launch (language, window, scale, colors and fonts, GPU and display backend,
  sound, notifications, and a few more, each with a value of the shape it takes). A remote
  debugging switch (port, address, pipe), `--remote-allow-origins` and every other switch not on
  the list (programs run in place of browser processes, certificate checks or site isolation off,
  a proxy) are dropped, as is every argument that isn't a switch, with a log line and a
  `pairbrowse_status` warning naming them (`scripts/browser-args.mjs`). Before this, those args
  were passed through as given and the guarantee was only that PairBrowse adds no port; a denylist
  came next and missed switches. The driver's own pipe comes from its launch options, not from
  these args, and is unaffected.

## In code

- `scripts/daemon.mjs` (header: the security model; the socket server)
- `scripts/engine.mjs`: `launchEngine` (`launchPersistentContext`)
- `scripts/browser.mjs`: `launchOptions`, `launchArgs` (no debugging switch)
- `scripts/browser-args.mjs`: `ALLOWED`, `screenBrowserArgs` (the user's browserArgs screened; `paths.mjs` `loadConfig` warns)
- `scripts/daemon/browser/launch.mjs` (the helper's launch)
- `scripts/opener.mjs`, `scripts/open.mjs` (a hand-opened browser reaches the helper's socket)
