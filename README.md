# PairBrowse

**Work in one live browser with your AI agent and your team.** Claude Code or Codex drives the
tabs, teammates join from their own computers with their own cursor and their own agent, and you
step in whenever you like. Sites see an everyday browser, not an automated one.

[pairbrowse.com](https://pairbrowse.com)

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/pairbrowse/pairbrowse/badge)](https://scorecard.dev/viewer/?uri=github.com/pairbrowse/pairbrowse)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/15234/badge)](https://www.bestpractices.dev/projects/15234)
[![CodeQL](https://github.com/pairbrowse/pairbrowse/actions/workflows/codeql.yml/badge.svg)](https://github.com/pairbrowse/pairbrowse/actions/workflows/codeql.yml)
[![Release check](https://github.com/pairbrowse/pairbrowse/actions/workflows/release-check.yml/badge.svg)](https://github.com/pairbrowse/pairbrowse/actions/workflows/release-check.yml)
[![Tests](https://github.com/pairbrowse/pairbrowse/actions/workflows/tests.yml/badge.svg)](https://github.com/pairbrowse/pairbrowse/actions/workflows/tests.yml)
[![VirusTotal](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fpairbrowse%2Fpairbrowse%2Fbadges%2Fvirustotal.json)](https://github.com/pairbrowse/pairbrowse/releases/latest)
[![Releases signed with Sigstore](https://img.shields.io/badge/releases-signed%20%28Sigstore%29-blue)](SECURITY.md#checking-a-download)

![PairBrowse: your AI agent fills the form, a teammate joins with their own cursor, you approve the final step](docs/media/pairbrowse-demo.gif)

- **Built for working together.** Send a watch or drive code: a teammate sees the same tabs live,
  clicks and types with their own cursor, and their Claude or Codex can work in another tab of the
  same session. Pause every agent at once with one click.
- **Stealth browser with a real fingerprint.** A hardened Chromium driven through
  [Patchright](https://www.npmjs.com/package/patchright) instead of stock Playwright: no
  automation flag, AutomationControlled off, no debugging port. On a Mac the fingerprint is
  captured from your own machine and kept per profile, so the GPU and WebGL it reports, time zone and
  language match real hardware. Clicks and typing follow human timing and curved mouse paths.
  Fewer CAPTCHAs, fewer "unusual activity" blocks.
- **Fast, accurate forms.** Fast mode fills a whole page (fields, dropdowns, checkboxes, Next) in
  one action from the page's accessibility tree, then checks a screenshot for what the tree
  can't show. Remembered details mean no retyping; Pay, delete, publish and send still wait for you.
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
**Use PairBrowse** for doing it together, long form work, sites that block automated browsers, or
client accounts kept apart.

## Safety

- No debugging port: the browser is driven over a private pipe, reachable only by your user.
- Pay, publish, delete, send and submit-for-review clicks ask you first. Payments, danger buttons
  and deletions are found from the page's structure (card fields, payment frames, danger styling,
  HTTP DELETE), not its words; Claude or Codex names the other final actions from its task.
  Ordinary steps (Continue, Save, Next) don't interrupt you, and nothing is sent to another model
  or service. Publishing also needs a passing check against the platform's current rules.
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
- [Skills](docs/skills.md)
- [Configuration](docs/configuration.md)
- [Security](docs/security.md), the [assurance case](docs/assurance-case.md) and [reporting a vulnerability](SECURITY.md)
- [Architecture](docs/architecture.md)
- [Development](docs/development.md) and [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md), [Roadmap](ROADMAP.md), [Governance](GOVERNANCE.md), [Code of conduct](CODE_OF_CONDUCT.md)

## Status

Early development. Expect breaking changes while the helper, collaboration model and agent
integrations evolve, and treat the security model as still maturing.

## Star History

<a href="https://www.star-history.com/#pairbrowse/pairbrowse&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=pairbrowse/pairbrowse&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=pairbrowse/pairbrowse&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=pairbrowse/pairbrowse&type=Date" />
  </picture>
</a>
