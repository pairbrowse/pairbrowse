# Install

## Requirements

- Claude Code running **on your computer** (CLI, desktop app local session, or IDE extension),
  or Codex CLI 0.160 or newer (see [Codex](codex.md)). Cloud sessions can't show you a browser
  window (see [Servers and cloud sessions](server.md)).
- Node.js 20+ (on Node.js 18, set `"browserDriver": "playwright"`). Check with `node -v`;
  otherwise install the LTS version from [nodejs.org](https://nodejs.org).
- Nothing else: PairBrowse downloads its own browser on first use (see [The PairBrowse browser](browser.md)).

## Claude Code

```bash
claude plugin marketplace add pairbrowse/pairbrowse
claude plugin install pairbrowse@pairbrowse
```

Then restart Claude Code. (Inside a Claude Code chat you can type the same thing as
`/plugin marketplace add pairbrowse/pairbrowse` and `/plugin install pairbrowse@pairbrowse`.)

For Codex, see [Codex](codex.md). Both apps can use PairBrowse at the same time; they share one
browser and your logins.

### From a local copy

To run your own checkout instead (for development, or without GitHub access from the CLI):

```bash
git clone https://github.com/pairbrowse/pairbrowse.git ~/pairbrowse
claude plugin marketplace add ~/pairbrowse
claude plugin install pairbrowse@pairbrowse
```

Update it with `cd ~/pairbrowse && git pull` before the update commands below.

## First run

Ask for something, for example:

> Register a Shopify Partner account for our company and start an app listing for our app.

The first time, PairBrowse sets itself up (a minute or two): it installs its browser runtime into
`~/.pairbrowse`, downloads its browser once (about 150 MB), and opens the **PairBrowse browser**,
a separate window with its own profile (your everyday Chrome isn't touched). Sign into the sites
you'll need (your mail, Shopify Partners and so on); they stay signed in next time. Add your
company details and passwords in the Profile panel: the PairBrowse button in the browser's
toolbar, or Cmd+Shift+Y (Ctrl+Shift+Y on Windows and Linux).

## Update

```bash
claude plugin marketplace update pairbrowse && claude plugin update pairbrowse@pairbrowse
```

Restart Claude Code afterwards.

## Uninstall

```bash
claude plugin uninstall pairbrowse@pairbrowse
```

Your browser profile, logins and saved details stay in `~/.pairbrowse`. Delete that folder to
remove them too.
