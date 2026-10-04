# The PairBrowse browser

## Where you see the browser

PairBrowse checks where Claude Code runs and shows the browser in the matching way:

| Claude Code | The browser |
|---|---|
| Terminal (CLI) or IDE | The **PairBrowse browser**: a Chromium window of its own (on macOS named PairBrowse, with its icon in the Dock). Pages render natively, so scrolling and clicking feel like Chrome. See [The PairBrowse browser](#the-pairbrowse-browser). |
| Desktop app (macOS), the Claude workspace | A pane on the right of the Claude window (`pairbrowse_dock`), styled like Claude's own UI and moving, resizing and hiding with it. It attaches beside the window when the screen has room, or inside its right edge when it doesn't. No permission needed; set `"dockMakeRoom": true` to let it narrow the Claude window once (needs Accessibility). Works with the local and the server browser. |
| Desktop app, Browser pane | The live view link also opens in the app's own Browser pane (Local sessions). |
| Cloud session | Runs in the cloud container, which you can't see into. Fine for jobs without logins; use a local session for signups. |

## The PairBrowse browser

PairBrowse runs its own browser: a normal, headed Chromium, so pages render natively and sites
treat it like a regular browser. Claude drives it over the private pipe, with no debugging port.
There's no headless mode.

- **macOS:** a pinned build of [ungoogled-chromium](https://github.com/ungoogled-software/ungoogled-chromium-macos)
  (notarized by that project), downloaded once (about 150 MB), checked against the SHA-256 in
  `scripts/browser.mjs` and its notarization, and copied into `~/.pairbrowse/browser/PairBrowse.app`
  (`PairBrowse Chromium.app` when the native build below is installed there) as PairBrowse everywhere you can see it: name, icon, notifications, menus and Chromium's own
  interface text in every language (internal framework file names stay, Chromium needs them). It runs with
  `--show-avatar-button=never`, so the toolbar has no profile button. Energy Saver is off. A new version is a deliberate change of the pinned version and checksum.
- **Windows and Linux:** Playwright's own Chromium, downloaded once (about 100 MB).
- **The PairBrowse side panel**: click the pinned PairBrowse button in the toolbar, or press
  **Cmd+Shift+Y** (Ctrl+Shift+Y on Windows and Linux). It shows what Claude is doing, "Your turn" when Claude
  needs you, the activity list, and the Profile (remembered details and passwords).
- **New tabs** open the PairBrowse new tab page: the logo, a search field, the PairBrowse icon.
- **Claude's tab** carries the orange spark as its tab icon, and the spark moves with Claude.
- **Claude's cursor**: a white pointer glides to where Claude clicks, types or chooses, with a
  ring on clicks. It never takes clicks and is hidden from Claude's view.
- **PairBrowse, not Chrome**: the browser's own pages, its name and its logo there say PairBrowse
  (Chromium keeps its copyright credit on the About page). Chrome's own sign-in and sync, guest and extra profiles,
  the default-browser check, translate prompts, and its password manager and autofill popups are
  off: PairBrowse has its own sessions, fills forms itself and keeps passwords in its own file.
  Signing into Google or any other site works as usual.
- **The bottom bar** in each page shows who's driving and Claude's last actions. It never takes
  clicks, fades out when your pointer nears the bottom of the page, and is hidden from Claude's view.
- It loads one extension of its own and no others: `scripts/browser/panel` (the side panel,
  which talks only to the key-protected live view on 127.0.0.1). Its navy colors are Chromium's
  built-in color theme, set in the profile (no theme extension, no "Installed theme" bar); pick
  another in Settings > Appearance and PairBrowse keeps it.
- Set `"executablePath"` in `~/.pairbrowse/config.json` to use Brave, Arc, Vivaldi or another
  Chromium build instead.

## See it inside the Claude desktop app

The desktop app's Browser pane is available in **Local** sessions (not cloud sessions).

1. In the desktop app: **Code** tab, choose **Local**, **Select folder**, pick your project.
2. Ask Claude to start something with PairBrowse. Claude calls `pairbrowse_liveview` and opens
   the live view in the Browser pane (or gives you the link to open there).
3. The pane shows the PairBrowse browser live, as a normal browser window: tabs with their
   icons, back, forward and reload, the address bar, then the page. An orange spark marks the tab
   Claude is working in.
   - **Tabs** along the top. Click a tab to look at it.
   - **The address bar** shows the real site, domain in bold, with a lock for HTTPS. Check it before you sign in.
   - **Who's driving**: Claude, or you for a few seconds after you click or type.
   - **Your turn**: when Claude needs you (CAPTCHA, login, 2FA), a white bar under the toolbar says
     what to do. Claude carries on by itself once the page moves on.
   - **Activity** along the bottom: what Claude just filled and clicked.
   - **Fit to pane** renders the page at the pane's size, so it stays readable in a narrow pane.
     It switches off when you close the live view.
   Click and type in it as you would in Chrome; paste works too.

The live view is a private page on `127.0.0.1` with a random key in its address. Don't share
the link: whoever has it can use the browser while it's running. To let someone else in, make
them an invite link instead (see [Working together](sharing.md)).

## The native PairBrowse browser

On a Mac (Apple Silicon or Intel) and on Linux x64, `"browserEngine": "auto"` (the default) uses
the native PairBrowse browser: a hardened Chromium build made for PairBrowse that looks like an
everyday browser to sites, so you see fewer CAPTCHAs. A Windows x64 build follows;
until then PairBrowse uses Playwright's Chromium on Windows (and on Linux on other chips).

PairBrowse picks the build for your platform and chip, downloads it once from its
[GitHub release](https://github.com/pairbrowse/pairbrowse/releases), checks it (the SHA-256 pinned in
`scripts/native-pack.mjs`, the build manifest, on macOS the signature, then a launch test) and keeps
the previous version for rollback. With it comes the small engine pack the native browser launches
with (fingerprint switches and humanized input), checked the same way. It installs at
`~/.pairbrowse/browser/PairBrowse.app` on macOS and `~/.pairbrowse/browser/PairBrowse` on Linux and
Windows. To install a file by hand:

```bash
node scripts/native-install.mjs /path/to/pairbrowse-<version>-macos-arm64.zip   # or -macos-x86_64.zip, -linux-x64.tar.xz, pairbrowse-engine-<version>.tgz
```

On Linux the build brings its own metric-compatible font clones (for fonts such as Arial and
Segoe UI), so pages render the same on a bare server. On a server without a screen, the launch
test runs on a private virtual screen (Xvfb, as the browser itself does; see server mode), so
install `xvfb` and `xauth` first. On Linux the browser runs with a fingerprint seed kept per
profile (the capture from your own computer is macOS only).

The native browser keeps its logins in its own profile, so after switching to it you sign in to
your sites once more.

The PairBrowse browser binary is licensed under [`BINARY-LICENSE.md`](../BINARY-LICENSE.md): free for personal,
non-commercial use; commercial use, redistribution and reverse engineering of PairBrowse's own
additions need written permission. A PairBrowse Pro license adds commercial use, ready-made builds and
updates, and access to the native build's source and pipeline (patches, build, packaging, smoke
test and updater live in the private PairBrowse Pro repository), where Pro members can contribute.
See [`CONTRIBUTING.md`](../CONTRIBUTING.md). The plugin and helper source stay MIT ([`LICENSE`](../LICENSE)), and third-party
components inside the binary (Chromium and the projects in its notices) keep their own licenses
and the rights they give.

**Browser compatibility hardening.** Automated browsers often differ from everyday ones in ways
sites notice. The native browser keeps those differences out: it launches without the automation
flag and with Chromium's AutomationControlled feature off, through the Patchright driver (the
default `browserDriver`); on a Mac its fingerprint is captured from your own Mac, so it stays coherent with
the real machine and is saved per profile (the capture runs once per Mac in a hidden browser on
the real GPU, and is kept in a private `~/.pairbrowse/mac-host-profile.json` until the browser
version or hardware changes); time zone and language follow your system; and WebRTC
doesn't reveal your local addresses by default. The goal is that sites see a normal browser, not
to get around a site's security (see [Intended use](../README.md#intended-use)).

**Human-like input (optional, native browser).** Off by default, so actions stay deterministic
for testing. Turn it on and moving, clicking, dragging, scrolling and typing follow one human
input style: eased, slightly curved mouse paths and key-by-key typing with human timing, all as
native trusted input:

```json
{ "pairbrowse": { "humanize": true } }
```

For a fully open-source setup, set `"browserEngine": "chromium"` in `~/.pairbrowse/config.json`:
ungoogled-chromium on macOS, Playwright's Chromium elsewhere, both under their own open licenses.
With it, PairBrowse removes Playwright's automation flag and disables
Chromium's AutomationControlled feature. That stops basic `navigator.webdriver` checks, nothing
more.
