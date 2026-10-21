# The PairBrowse browser

## Where you see the browser

PairBrowse checks where Claude Code runs and shows the browser in the matching way:

| Claude Code | The browser |
|---|---|
| Terminal (CLI) or IDE | The **PairBrowse browser**: a window of its own (on macOS named PairBrowse, with its icon in the Dock). Pages render natively, so scrolling and clicking feel like any everyday browser. See [The PairBrowse browser](#the-pairbrowse-browser). |
| Desktop app (macOS), the Claude workspace | A pane on the right of the Claude window (`pairbrowse_dock`), styled like Claude's own UI and moving, resizing and hiding with it. It attaches beside the window when the screen has room, or inside its right edge when it doesn't. No permission needed; set `"dockMakeRoom": true` to let it narrow the Claude window once (needs Accessibility). |
| Desktop app, Browser pane | The live view link also opens in the app's own Browser pane (Local sessions). |
| Cloud session | Runs in the cloud container, which you can't see into. Fine for jobs without logins; use a local session for signups. |

## The PairBrowse browser

PairBrowse runs its own browser: a normal, headed browser, so pages render natively and sites
treat it like a regular browser. Claude drives it over the private pipe, with no debugging port.
There's no headless mode. It comes in two forms:

- **The native PairBrowse browser** (`"browser": "pairbrowse"`, the default on a Mac, Apple Silicon
  or Intel, and on Linux x64): a hardened browser made for PairBrowse, with its own tab strip,
  docks, new tab page and Settings built in. It looks like an everyday browser to sites, so you see
  fewer CAPTCHAs, and it is the only browser PairBrowse runs in server mode. See
  [The native PairBrowse browser](#the-native-pairbrowse-browser).
- **PairBrowse as an extension** (`"browser": "pairbrowse-open"`): the fallback, for Windows until
  the native browser arrives there and for people who don't want the native browser. It is the same
  plugin and `ui/` pages, loaded into another browser as an extension with a side panel. Compared
  with the native browser it lacks server mode (a server refuses to start it), the engine's identity
  work (a coherent fingerprint kept per profile), humanized input, and the WebGPU and proxy
  patches (a proxy with a password is refused there), so sites block it more often. Its browser:
  - **macOS:** a pinned, notarized open-source build (its source address, version and
    SHA-256 are in `scripts/browser.mjs`), downloaded once (about 150 MB), checked against that
    SHA-256 and its notarization, and copied into `~/.pairbrowse/browser/PairBrowse.app` (moved to an
    app of its own next to it when the native browser is installed there) as PairBrowse
    everywhere you can see it: name, icon, notifications, menus and the browser's own interface text
    in every language (internal framework file names stay, the engine needs them). It runs with
    `--show-avatar-button=never`, so the toolbar has no profile button. Energy Saver is off. A new
    version is a deliberate change of the pinned version and checksum.
  - **Windows and Linux:** Playwright's own browser build, downloaded once (about 100 MB).
  - **A browser of your own:** set `"browser": "/path/to/browser"` in `~/.pairbrowse/config.json`
    to use Brave, Arc, Vivaldi or another compatible browser instead (an absolute path to its program).

Wherever PairBrowse runs (the native browser, or PairBrowse as an extension in any of its browsers):

- **New tabs** open the PairBrowse new tab page: the logo, a search field, and chips for your other recent sessions (one press switches, the same as the session picker's rows; none are shown when PairBrowse is not running).
- **Claude's tab** carries the orange spark as its tab icon, and the spark moves with Claude.
- **Claude's cursor**: a white pointer glides to where Claude clicks, types or chooses, with a
  ring on clicks. It never takes clicks and is hidden from Claude's view.
- **The bottom bar** in each page shows who's driving and Claude's last actions. It never takes
  clicks, fades out when your pointer nears the bottom of the page, and is hidden from Claude's view.
- **Off in the browser:** the engine's own browser sign-in and sync, guest and extra profiles, the
  default-browser check, translate prompts, and its password manager and autofill popups: PairBrowse has its own sessions,
  fills forms itself and keeps passwords in its own file. Signing into Google or any other site
  works as usual.

In the native browser:

- **Docks** instead of a side panel: what Claude is doing, "Your turn" when Claude needs you, the
  activity list and the Profile sit in the window itself.
- **No extension is loaded** when the build declares its own pages: the helper passes the
  live view's origin in `--pairbrowse-helper` and a key of their own in an owner-only file named
  by `--pairbrowse-helper-key-file` (deleted once used; the key is never on the command line), the
  session picker is `chrome://pairbrowse/picker`, and agents never see or drive `chrome://pairbrowse` pages.
- **PairBrowse everywhere**: the browser's own pages, its name and its logo say PairBrowse
  (the engine's credits stay on the About page).

In PairBrowse as an extension:

- **The PairBrowse side panel**: click the pinned PairBrowse button in the toolbar, or press
  **Cmd+Shift+Y** (Ctrl+Shift+Y on Windows and Linux). It shows what Claude is doing, "Your turn" when Claude
  needs you, the activity list, and the Profile (remembered details and passwords).
- It loads one extension of its own and no others: `ui/` (the side panel, new tab, picker, picture and capture pages,
  which talk only to the key-protected live view on 127.0.0.1).
- Its navy colors are the browser's built-in color theme, set in the profile (no theme extension,
  no "Installed theme" bar); pick another in Settings > Appearance and PairBrowse keeps it.
- On macOS the pinned build is branded PairBrowse as described above; Playwright's build on Windows
  and Linux, and a browser of your own, keep their own name and logo.

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
   Click and type in it as you would in any browser; paste works too.

The live view is a private page on `127.0.0.1` with a random key in its address. Don't share
the link: whoever has it can use the browser while it's running. To let someone else in, make
them an invite link instead (see [Working together](sharing.md)).

## The native PairBrowse browser

Which browser runs is one setting, `"browser"` in `~/.pairbrowse/config.json`: `"pairbrowse"`
(the native PairBrowse browser), `"pairbrowse-open"` (PairBrowse as an extension: the same plugin
in another browser, with the side panel; the older `"chromium"` still works) or an absolute path to a
compatible browser of your own. Unset, it's `"pairbrowse"` where a build is pinned for your computer
(a Mac, Apple Silicon or Intel, and Linux x64), else `"pairbrowse-open"`. You're asked once, in the
terminal of the by-hand install step below and in the browser's Settings page; a change takes effect
when the browser next starts. With `"pairbrowse-open"` or a path, nothing is downloaded or installed for the native browser and it is never launched.

The native PairBrowse browser is a hardened build made for PairBrowse that looks like an
everyday browser to sites, so you see fewer CAPTCHAs. It never switches to another browser on its
own: if the build can't be installed, or there's none for your platform yet (Windows x64 follows),
the browser doesn't start and says why. To use PairBrowse as an extension instead, set `"browser": "pairbrowse-open"`.
While it installs (the first start, or a new version), a
notification says so, and agents answer "installing" right away instead of waiting.

PairBrowse picks the build for your platform and chip, downloads it once from its
[GitHub release](https://github.com/pairbrowse/pairbrowse/releases), checks it (the SHA-256 pinned in
`scripts/native-pack.mjs`, the build manifest, on macOS the signature, then a launch test) and keeps
the previous version for rollback. After the launch test it measures the build's graphics once in a
throwaway browser of its own (hidden on macOS; on Linux on the launch test's own screen, the private
virtual screen on a server, your desktop otherwise, where its window shows briefly as the launch
test's does): the backend the browser renders with, WebGL, WebGPU, canvas, fonts and screen; the
install record keeps one line such as "graphics: software, WebGL 2, WebGPU unavailable" (on Windows
"graphics: not measured on Windows"), and the measurement is kept with the `default` browser
profile as its evidence for that build (the first start of any other profile, or `node
scripts/profiles/cli.mjs validate`, measures it once the same way). A measurement that fails never stops the install. The check
runs before the first start after an update: the launch test has three minutes, the graphics
measurement two more, and one that runs over is stopped and waited for (at most 105 seconds more),
so the worst case is under seven minutes in all, and a slow measurement leaves the line
"unverified". With it comes the small engine pack the native browser launches
with (fingerprint switches and humanized input), checked the same way. It installs at
`~/.pairbrowse/browser/PairBrowse.app` on macOS and `~/.pairbrowse/browser/PairBrowse` on Linux and
Windows. To install a file by hand (it installs nothing while `browser` is `"pairbrowse-open"` or a path,
and asks which browser to use when nobody chose yet):

```bash
node scripts/native-install.mjs /path/to/pairbrowse-<version>-macos-arm64.zip   # or -macos-x86_64.zip, -linux-x64.tar.xz, pairbrowse-engine-<version>.tgz
```

On Linux, once the build passes its checks, the install step also writes its desktop entry
(`$XDG_DATA_HOME/applications/pairbrowse.desktop`, else under `~/.local/share`; `Exec` the installed
program, `StartupWMClass=Pairbrowse`) and copies the icons the build ships into
`icons/hicolor/<size>/apps/`, so the window gets its name and icon (`scripts/native/desktop.mjs`;
an install under another `PAIRBROWSE_HOME` gets an entry of its own). A failure there is logged and
never fails the install.

On Linux the build brings its own metric-compatible font clones (for fonts such as Arial and
Segoe UI), so pages render the same on a bare machine. On a Linux machine without a screen, the launch
test runs on a private virtual screen (Xvfb, as the browser itself does), so
install `xvfb` and `xauth` first. On Linux the browser runs with a fingerprint seed kept per
profile (the capture from your own computer is macOS only), and its graphics are this computer's
own: pages read the real renderer's WebGL and WebGPU strings and limits (on a server's virtual
screen that is a software renderer, named as such), with no fingerprint noise over its pixels, and
on PairBrowse's virtual screen the screen they read is that screen (`pairbrowse.graphics` and
`virtualScreen` in [Configuration](configuration.md)).

The native browser keeps its logins in its own profile, so after switching to it you sign in to
your sites once more.

The PairBrowse browser binary is licensed under [`BINARY-LICENSE.md`](../BINARY-LICENSE.md): free for personal,
non-commercial use; commercial use, redistribution and reverse engineering of PairBrowse's own
additions need written permission. A PairBrowse Pro license adds commercial use, ready-made builds and
updates, and access to the native build's source and pipeline (patches, build, packaging, smoke
test and updater live in the private PairBrowse Pro repository), The plugin and helper source stay MIT ([`LICENSE`](../LICENSE)), and third-party
components inside the binary (the projects in its notices) keep their own licenses and the rights
they give.

**Browser compatibility hardening.** Automated browsers often differ from everyday ones in ways
sites notice. The native browser keeps those differences out: it launches without the automation
flag and with the engine's AutomationControlled feature off, through the Patchright driver (the
default `browserDriver`); on a Mac its fingerprint is captured from your own Mac, so it stays coherent with
the real machine and is saved per profile (the capture runs once per Mac in a hidden browser on
the real GPU, and is kept in a private `~/.pairbrowse/mac-host-profile.json` until the browser
version or hardware changes; that first launch takes up to a minute longer, and the live view's
status line and a notification say "Measuring this Mac once" while it runs); time zone and language follow your system; and WebRTC
doesn't reveal your local addresses (a WebRTC IP policy in `browserArgs` can't loosen that: it is dropped). The goal is that sites see a normal browser, not
to get around a site's security (see [Intended use](../README.md#intended-use)).

**Human-like input (native browser).** On by default: an agent's single clicks, drags and typing
follow one human input style (eased, slightly curved mouse paths and key-by-key typing with human
timing, all as native trusted input), and `pairbrowse_scroll` glides the page with the cursor on
it. Fast mode (`pairbrowse_run`) is just fast: it skips both. To turn it off (deterministic
actions, for testing):

```json
{ "pairbrowse": { "humanize": false } }
```

Typing speed: `typingPace` from 0.2 (fastest) to 1 (slowest, about 60 words a minute). The
default, 0.2 (0.3 in earlier versions), types with a fast typist's rollover: the gaps between keys
and the short pauses scale with it; how long each key is held doesn't. A slower pace (0.3 to 0.5) is
the setting for a more careful, slower hand. A `browser_type` goes the way a
form field does (below): the field focused by the engine's own reach and click (none when it has the
focus already), what it held cleared, the text key by key with a quick typist's rhythm, read back; 41
characters take about 3.5 s (6 s before 0.15.39), 200 characters into a textarea about 10 s (24 s).
`slowly: true` types at about 90 ms a key, at the caret, next to what the field holds, and brings a
snapshot (a list of suggestions shows up); `submit: true` presses Enter once the text is in.

```json
{ "pairbrowse": { "typingPace": 0.35 } }
```

A form (`browser_fill_form`) is filled the way a person fills one, field by field in the order
given: into the first field, then on to the next with the Tab key when it is the next field in the
page's own order (the mouse reaches for it otherwise, and for any field Tab didn't land on), the value
typed key by key at `typingPace` with a quick typist's rhythm (the next key often down before the
last is up, a beat after each word), a closed select picked by typing its option's first letters, a
box ticked with Space, a date or time field set at once in its turn (its exact shape, YYYY-MM-DD).
Every field is read back, and a value that didn't stay is said so in the result. A form never types
quicker than `typingPace` 0.2 allows (lower counts as 0.2 there). An
11-field form takes about 9 s this way (the first fill after the browser starts a little longer),
against 25 s with a mouse reach and a full key hold for every field. `formMove` picks how
PairBrowse goes from field to field:

```json
{ "pairbrowse": { "formMove": "mouse" } }
```

`"tab"` (the default) is described above; `"mouse"` reaches for every field with the mouse, as
single actions do. Fast mode (`pairbrowse_run`) is unchanged: it skips the human-like input altogether.

Mouse movement: `motion` is `"fast"` by default (`"quick"` in 0.15, `"combined"` earlier). Every
motion but `"classic"` shapes each move like a hand's: one quick reach that lands close (now and then
a few pixels past), then homes in without stopping. Every click still lands exactly on its point.
`"fast"` moves at a quick hand's pace: a hop to the next field in about a third of the profile's own
time, a reach across the page in under two thirds, a brief pause before the press and a short press
(a click on the next field takes about 0.25 s, one across the page about 0.65 s).
`"quick"` is the slower, more careful choice: a hop in about half the time, a long reach at the
profile's own speed and a longer press (about 0.4 s and 1.1 s). With `"combined"` the profile keeps
its own speed, tremor and habits throughout. `"classic"` uses the engine's own shape instead:

```json
{ "pairbrowse": { "motion": "quick" } }
```

**PairBrowse as an extension** (`"browser": "pairbrowse-open"`) has none of the above: no
fingerprint capture or persona, no humanized input, no engine pack. PairBrowse removes Playwright's
automation flag and disables the engine's AutomationControlled feature there. That stops basic
`navigator.webdriver` checks, nothing more.
