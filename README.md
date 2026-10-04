# PairBrowse

**A browser you and your AI agent share.** Claude Code or Codex works through sign-ups, app
listings and settings pages; you step in only for the CAPTCHA, the 2FA code and the final Submit,
and a teammate can watch or take the wheel from their own computer.

[pairbrowse.com](https://pairbrowse.com)

<!-- Demo GIF goes here: Claude fills a form, "Your turn" for 2FA, Claude continues. -->

- **One browser, several people and agents.** Send a watch or drive code. Your teammate's own
  Claude or Codex can work in another tab of the same session, and you can pause every agent at
  once.
- **Your turn only when it matters.** Typing, Next and cookie banners just run. Pay, delete,
  publish and send stop and wait for you. Step into any tab at any time; the agent waits and
  then takes a fresh look.
- **Separate from your everyday Chrome, but it remembers.** Logins persist in their own profile,
  one per client if you like. Passwords are filled only on the sites you allow and never shown to
  the model. Half-finished jobs resume tomorrow.

## Install

```bash
claude plugin marketplace add pairbrowse/pairbrowse
claude plugin install pairbrowse@pairbrowse
```

Restart Claude Code. Needs Node.js 20+ and Claude Code running on your computer (not a cloud
session). Codex: see [docs/codex.md](docs/codex.md). Update, uninstall and a local checkout:
[docs/install.md](docs/install.md).

## Try it

> Register a Shopify Partner account for our company and start an app listing for our app.

The first run downloads the browser (about 150 MB) and opens it. Sign into the sites you need
once; they stay signed in.

## Compared with the built-in browsers

| | Claude Code + Chrome | Codex browser | PairBrowse |
|---|---|---|---|
| Browser it drives | Your everyday Chrome | Codex's own browser | Its own browser and profile |
| Resume a half-finished job another day | No saved runs | Sometimes; often the state is lost | Yes: saved runs, tabs and logins |
| Share a live session with a teammate and their agent | No | No | Yes |
| Works from both Claude Code and Codex | No | No | Yes |

**Use the built-ins** for a quick task in a site you're already signed into.
**Use PairBrowse** for long form work, client accounts kept apart, or doing it together.

## Safety

- No debugging port: the browser is driven over a private pipe, reachable only by your user.
- Pay, publish, delete, send and submit-for-review clicks ask you first; "Submit for review" and
  "Publish" also need a passing check against the platform's current rules.
- Passwords work only on the domains you list for them and are masked in everything the model reads.
- Join codes share tabs and form values, never your cookies, logins or passwords, and only after you click Allow.
- PairBrowse never solves CAPTCHAs or bot checks.

Full threat model and limits: [docs/security.md](docs/security.md). Report issues privately:
[SECURITY.md](SECURITY.md).

## Intended use

Quick sign-ups, registrations and listings that come up while you build a product (developer
accounts, app store listings, API keys, store settings), with you in the loop. Not for creating
accounts in bulk, getting around a site's bot checks, or anything else a site doesn't allow. You
use it on your own accounts and accept each site's terms.

## Open source, honestly

The plugin and helper are MIT ([LICENSE](LICENSE)). On macOS and Linux x64 the default
`"browserEngine": "auto"` downloads the native PairBrowse browser, a closed Chromium build that's
free for personal, non-commercial use ([BINARY-LICENSE.md](BINARY-LICENSE.md)). For commercial
use, either get a PairBrowse Pro license or set `"browserEngine": "chromium"` in
`~/.pairbrowse/config.json` for a fully open setup (ungoogled-chromium on macOS, Playwright's
Chromium elsewhere). See [docs/browser.md](docs/browser.md#the-native-pairbrowse-browser).

## Docs

- [What it does](docs/features.md): features, how a run goes, design principles
- [Install](docs/install.md) and [Codex](docs/codex.md)
- [The browser](docs/browser.md): where you see it, the desktop app pane, the native build
- [Using PairBrowse](docs/using.md): remembered details, passwords, sessions, fast mode, popups, uploads
- [Working together](docs/sharing.md): invites, join codes, several agents on one browser
- [Servers and cloud sessions](docs/server.md)
- [Skills](docs/skills.md)
- [Configuration](docs/configuration.md)
- [Security](docs/security.md)
- [Development](docs/development.md) and [Contributing](CONTRIBUTING.md)

## Status

Early development. Expect breaking changes while the helper, collaboration model and agent
integrations evolve, and treat the security model as still maturing.
