# Running PairBrowse on a server

PairBrowse can run on a Linux server nobody sits at: the helper is kept running by the system's
service manager, the browser runs headed on a private virtual screen, agents reach it over SSH,
and the steps only a person can do (a sign-in, a CAPTCHA, a code, a payment) come to your phone.
This page is the setup and its limits. The keys it names are in [Configuration](configuration.md).

## Which computer

**First choice: a computer with a real graphics card.** A Linux mini PC with Intel graphics, or a
Mac mini, whose own graphics the browser then reports as they are. Websites judge a browser by
what it draws as much as by what it says, and a computer that renders in software (a cloud
virtual machine, a container with no GPU) gets a session blocked before a CAPTCHA is ever shown.
On a computer with a graphics card PairBrowse measures its graphics once and pages read the real
renderer, with no fingerprint noise over its real pixels; the measurement is kept with the
browser profile and the status says `Graphics: hardware (...), validated`.

**Second: a residential or office exit for the proxy.** If the server's own network is a data
center's, give each session a proxy whose exit is a home or office connection in the country the
browser's time zone and languages say (`network` in [Configuration](configuration.md), or Settings'
Network section). PairBrowse checks the exit before any tab loads, keeps checking it, and tells
you when the time zone or languages don't fit the exit's country.

**The fallback: a computer without a graphics card.** PairBrowse runs there too, with these limits
stated plainly. The browser renders in software, which a page can see in how fast it draws and in
the exact pixels, even though what pages read is one ordinary desktop the browser carries: a
Windows 11 desktop with an NVIDIA GeForce RTX 3060 (the engine's own Windows persona, so pages
read Windows in the user agent and client hints, that card in WebGL on Direct3D 11, the same card
in WebGPU on a software adapter the browser offers there, Windows speech voices and keyboard
layout, and the virtual screen less a Windows taskbar), the same choice the best published
browser of this kind makes on a Linux server; no canvas noise unless `pairbrowse.graphicsNoise`
is `true`, so sessions on one such computer share its canvas reading. What it still lacks is
Windows' own fonts (see [Fonts](#fonts)). PairBrowse never pretends otherwise to you: the helper log,
`pairbrowse_status`, the install check and a diagnostics report say "software rendering, shown
as Windows 11 with NVIDIA GeForce RTX 3060", and a browser profile checked there reads
"consistent" rather than "validated". Expect more verification steps handed to you than on a
computer with a graphics card. Asking for a GPU (`pairbrowse.graphics` `"gpu"`) on such a computer
refuses the start by name rather than pretending. (An older PairBrowse browser build, before the
one that carries the Windows persona's GPU choice, shows the engine's Linux persona with an Intel
UHD Graphics 770 instead; the status names whichever it is.)

## What to install

- Node.js 20 or newer, and the plugin (see [Install](install.md)).
- `xvfb` and `xauth` (Debian and Ubuntu: `sudo apt-get install -y xvfb xauth`): the private
  virtual screen the browser runs on when the server has no screen.
- The font set, with the setup's own command (below): pages render as on a desktop, and font
  checks find the fonts a Windows browser has wherever a free font can provide them.
- The time zone of the place your traffic leaves from. A server's clock is usually UTC, which few
  everyday computers use, and pages compare the browser's time zone with the region of the address
  they see. Set it for each profile (`locale.timezone`, see [Browser profiles](profiles.md)) or for
  the helper as a whole (`Environment=TZ=...` in the unit below, with your exit's zone);
  the helper log says so at each start on a UTC clock that nothing overrides.
- Mesa's software renderers (`libgl1-mesa-dri`, `mesa-vulkan-drivers`) on a computer without a
  graphics card; the drivers of your graphics card on one with it.
- The native PairBrowse browser: server mode runs only that one (`"browser": "pairbrowse"` in
  `~/.pairbrowse/config.json`; the plugin downloads and checks it on first use). PairBrowse as an
  extension never runs in server mode.

Run PairBrowse as a normal user, never as root: the browser's sandbox is always on in server mode
and refuses to start as root.

## Fonts

A computer without a graphics card presents as Windows 11, and sites check fonts as part of that:
they draw an emoji and CJK text on a hidden canvas and compare the picture with real desktops',
and they measure text in a font's name to see whether that font is there. PairBrowse installs only
free fonts, never downloads a font from a third-party mirror site, and never ships, renames or
modifies one. Run the setup as the user PairBrowse runs as (it asks `sudo` for the packages):

```sh
node <plugin copy>/scripts/native/fontsetup.mjs install   # installs the set, then checks
node <plugin copy>/scripts/native/fontsetup.mjs check     # what the browser finds now
```

On Debian and Ubuntu it installs:

1. **Microsoft's core fonts for the web** (Arial, Courier New, Times New Roman, Verdana, Georgia,
   Trebuchet MS, Comic Sans MS, Impact, Andale Mono, Webdings), only through the distribution's own
   package, `ttf-mscorefonts-installer`, which downloads Microsoft's original installers and checks
   each against the checksums the package carries. They come with Microsoft's licence (EULA), which
   you accept once and nobody accepts for you: on Debian the setup shows the licence in full and
   installs the package only when you type `yes` (Debian's package asks nothing itself); on Ubuntu
   the package shows it and asks you. Your answer is recorded with the licence text's SHA-256, so a
   later run doesn't ask again. Without a terminal to answer in, or without a `yes`, the core fonts
   are skipped and the rest is installed. A server you set up without a terminal (a provisioning
   script, a container image): read the licence (`scripts/native/corefonts-eula.txt`) and record
   your acceptance yourself, either as `"server": { "acceptMsCoreFontsEula": true }` in
   `~/.pairbrowse/config.json` or with `install --accept-ms-corefonts-eula`; the setup then names
   where it found your acceptance, installs without asking (on Ubuntu it gives the package's own
   question your answer first, through `debconf-set-selections`, the distribution's way for an
   unattended install) and records it as before. Nothing else ever answers for you. The package is in Debian's `contrib` section (Ubuntu's
   `multiverse`): if your package sources don't include it, the setup says how to add it and leaves
   your sources as they are (Debian: add `contrib` to the `Components:` of the Debian entries in
   `/etc/apt/sources.list.d/debian.sources`, or to the lines in `/etc/apt/sources.list`, then
   `sudo apt-get update`; Ubuntu: `sudo add-apt-repository multiverse`).
2. **Colour emoji and CJK**: `fonts-noto-color-emoji` and `fonts-noto-cjk` (with `fontconfig`). Not
   optional on a computer without a graphics card: the install check (`fonts.emoji` in a profile's
   checks) warns when emoji draw in black and white.
3. **The open stand-ins** for Windows names, one distinct open family per Windows family, so no
   two Windows names answer with the same font and a width check (Verdana's width against
   Arial's) finds them apart as it would on Windows. Each comes from its publisher only, every font
   file and its licence pinned by SHA-256 in the setup (`scripts/native/standins.mjs`, Selawik in
   `fontsetup.mjs`), kept under its published name in its own folder of `~/.pairbrowse/fonts/` with
   its licence file beside it, never renamed or modified; a file that doesn't match its pin is not
   written, and `install` exits 1 until every family is in place:

   | Windows name | Stand-in | Licence | Source | Measured against the Windows font |
   | --- | --- | --- | --- | --- |
   | Arial, Helvetica | Arimo | SIL OFL 1.1 (Apache-2.0 in the Croscore release) | Google Fonts | same advance width for every ASCII glyph |
   | Times New Roman, Times | Tinos | SIL OFL 1.1 (Apache-2.0 in the Croscore release) | Google Fonts (licence from googlefonts/tinos) | same for every ASCII glyph |
   | Courier New, Courier | Cousine | SIL OFL 1.1 (Apache-2.0 in the Croscore release) | Google Fonts | same for every ASCII glyph |
   | Georgia | Gelasio | SIL OFL 1.1 | Google Fonts | same for every ASCII glyph |
   | Calibri | Carlito | SIL OFL 1.1 | Google Fonts | metric-compatible by design (no Calibri measured here) |
   | Cambria | Caladea | SIL OFL 1.1 | Google Fonts | metric-compatible by design (no Cambria measured here) |
   | Segoe UI (Light, Semilight, Semibold) | Selawik (its styles) | SIL OFL 1.1 | Microsoft's release | close, not the same: its kerning differs |
   | Verdana | DejaVu Sans | DejaVu Fonts licence | DejaVu's release 2.37 | probe strings within 3%, glyphs 5% apart on average |
   | Tahoma | DejaVu Sans Condensed | DejaVu Fonts licence | DejaVu's release 2.37 | probe strings within 5%, glyphs 6.5% apart on average |
   | Trebuchet MS | Fira Sans | SIL OFL 1.1 | Google Fonts | probe strings within 3% |
   | Comic Sans MS | Comic Relief | SIL OFL 1.1 | Google Fonts | same for every ASCII glyph (regular and bold) |
   | Impact | Anton | SIL OFL 1.1 | Google Fonts | probe strings within 4% |
   | Consolas | Inconsolata | SIL OFL 1.1 | Google Fonts | monospace 0.5 em a character, narrower than Consolas (see below) |

   Google Fonts here is its own repository (`github.com/google/fonts`) at one pinned commit;
   DejaVu's release is the one dejavu-fonts.github.io links (its GitHub release 2.37, the archive
   pinned, DejaVu Sans and DejaVu Sans Condensed and the `LICENSE` taken from it); Selawik is
   Microsoft's own release on GitHub (1.01). How the choices were made: each candidate's advance
   widths (the font's `hmtx`, at its default instance) against the Windows font's, on the probe
   string width checks use (`mmmmmmmmmmlli`), a pangram and all printable ASCII. For Trebuchet MS,
   Fira Sans came closest (+2.9%, +0.2%, -1.0%) of the open sans families measured: PT Sans
   (-2 to -5%), Noto Sans (+4 to +10%), Lato, Cabin, Open Sans, Source Sans 3, Mulish, Work Sans
   and Comic Neue all further. For Comic Sans MS, Comic Relief matches glyph for glyph, where Comic
   Neue (+4% to -12%) and Noto Sans (+18% to -5%) don't. For Consolas no metric-compatible open
   monospace exists: Cousine (0.6 em) is Courier New's already, so Inconsolata at 0.5 em, its
   default width unchanged, is the nearest distinct one; a width check finds a monospace there, as on
   Windows, but narrower than Consolas (which wasn't on the measuring computer; its own width is
   for the live check to compare). The probe widths of all sixteen stand-ins differ pairwise (the
   closest pair, Comic Relief and Tinos, is as close as Comic Sans MS and Times New Roman are on
   Windows). Microsoft's own font of a name always wins over its stand-in: the alias file accepts the
   stand-in only after the name itself, so with the core fonts installed (step 1) Arial is Arial,
   and Helvetica answers with Arial before Arimo.
4. **The browser's font configuration** (`~/.pairbrowse/fonts.conf`, written again at each browser
   start): the browser then reads this computer's fonts (everything above) rather than only the
   fonts the Linux build carries; with the stand-ins on, the build's own font folder stays in reach
   too, so the Windows names the build's engine answers with its own open faces (Cambria Math,
   Bahnschrift, Gadugi, Lucida Console and others) still resolve. Whether the Windows names point at the stand-ins is
   `pairbrowse.fontStandIns` in `config.json` (see [Configuration](configuration.md)), `true` by
   default (the ordinary-browser measurement found the Windows names with it and lost no check's
   verdict): on, those names find their stand-in; off, the stand-ins are kept from the browser
   altogether, so a width check finds no Segoe UI, Calibri, Cambria or the other Windows names
   there (DejaVu Sans stays, the system's own text face, as does Liberation where its package is
   installed: fontconfig's own aliases use it for Arial, Times New Roman and Courier New, as on any
   Linux desktop). Only the browser's font matching changes,
   nothing else on the computer. Until the setup has run, the browser keeps the Linux build's own
   font configuration, which reads only the fonts the build carries (its own clones always stand
   in there, and none of the computer's fonts, its colour emoji among them, reach it).

On Fedora (`sudo dnf install fontconfig google-noto-color-emoji-fonts google-noto-sans-cjk-fonts`)
and Arch (`sudo pacman -S fontconfig noto-fonts-emoji noto-fonts-cjk`) the setup names these packages for you to install, then
does steps 3 and 4 itself, and `install` exits 1 until this computer's fontconfig lists their fonts; Microsoft's core fonts aren't in those distributions' own repositories,
and PairBrowse never takes them from elsewhere. On another distribution install the equivalent
packages (fontconfig, a colour emoji font, Noto CJK) and run the setup for the stand-ins and the
configuration (it checks for the same fonts). The stand-ins come from their publishers, pinned, on
every distribution.

What stays absent: Segoe UI, Calibri, Cambria, Consolas, Tahoma, Marlett, MS UI Gothic, Franklin Gothic and
the other fonts only Windows carries are Microsoft's, licensed with Windows, and no free package
has them. The setup's check, the install self-check ("Windows fonts: ..."), a diagnostics report
and Settings (About and diagnostics) list each Windows font as present, standing in (and by which
open font) or absent, so you know what a strict font check will see. The open build
(`"browser": "pairbrowse-open"`) is never given PairBrowse's font configuration: it reads this
computer's own, whose metric aliases stand Carlito and Caladea (where the distribution's packages
are installed) in for Calibri and Cambria whatever `pairbrowse.fontStandIns` says, and the report lists its fonts that way.

## The helper as a service

Set `"server": { "keepAlive": true }` in `~/.pairbrowse/config.json`: the browser starts as soon
as the helper does and its saved tabs come back; a browser that crashes or is closed comes back by
itself (after 2 s, then 10 s, then 30 s; three crashes within five minutes stop the restarts for
five minutes); only stopping the helper keeps it closed; and a newer plugin version never stops
this helper (`pairbrowse_status` says to restart the service to move to it).

A systemd user unit for it (`~/.config/systemd/user/pairbrowse.service`; `<plugin copy>` is the
installed plugin's folder, for example `~/.claude/plugins/cache/pairbrowse/pairbrowse/<version>`;
`TZ` is the zone of your exit):

```ini
[Unit]
Description=PairBrowse helper
After=network-online.target

[Service]
ExecStart=/usr/bin/node <plugin copy>/scripts/daemon.mjs
Restart=on-failure
RestartSec=5
Environment=PAIRBROWSE_HOME=%h/.pairbrowse
Environment=TZ=Europe/Amsterdam

[Install]
WantedBy=default.target
```

Then `systemctl --user daemon-reload`, `systemctl --user enable --now pairbrowse`, and
`loginctl enable-linger $USER` so the user's services run without a login session. A helper
killed and started again (as `Restart=on-failure` does) brings the browser back with its session
and tabs; an open hand-off gets one new link with the same deadline.

Agents reach the helper the way they do on a desktop: run Claude Code or Codex on the server
itself, over SSH, with the plugin installed there. Your own live view link (the browser's window
in a page) works through an SSH tunnel to the server, or under a name in `liveViewHosts` on a
tailnet; the join-code port is the only one a public tunnel ever reaches.

## The virtual screen and the sandbox

On a server without a screen the browser runs headed on PairBrowse's own Xvfb (`display`
`"auto"`), at `virtualScreen`'s size (1366x900 by default): the window fills it, pages read that
screen, and a screen that ends by itself is started again on the next action with the tabs back.
There is no headless mode ([ADR 9](adr/0009-always-headed.md)).

The browser's sandbox is always on in server mode, with no opt-out: a container must allow user
namespaces for the normal user it runs as (with Docker, Docker's default seccomp profile with only
its namespace rules relaxed, beside `--cap-drop ALL` and `no-new-privileges`; never
`seccomp=unconfined` or `--privileged`), and a system that can't run the sandbox refuses the launch
with the fix named rather than starting the browser without it. The details are under
`browserSandbox` in [Configuration](configuration.md); the measured state of the sandbox is part
of every graphics measurement (`sandbox.on`).

## Hand-offs to your phone

In server mode every step handed to you goes to the channels in `handoff` (Telegram, Discord,
Slack, a webhook or ntfy): one message naming the kind of step, the site and the expiry, with a
link. Opening the link shows the step and a "Take over" button; the tap takes the handed-over tab
over on your phone (tap, scroll, hold, zoom, and a type box for the field you tapped), and Done
hands it back; one reminder comes, and the agent stops safely if nobody finishes in time.

The link reaches the live view over a private route by default: a name in `liveViewHosts` with
`inviteBaseUrl` (a tailnet works on a phone with its app) or an SSH tunnel. Only when you may be
on another network with neither, turn on the public link (`handoff.publicLink`, or the line under
the Away switch): while a hand-off is open its link then goes through a tunnel of its own (a free
Cloudflare Quick Tunnel, or your own `sharing.tunnel`) that serves that hand-off's page and
viewer and nothing else, and stops a few seconds after the last hand-off ends. What that exposes:
anyone who has the link while the hand-off is open can open it, and the first to tap Take over
gets that one tab until the hand-off ends; never your own live view, invite links or the rest of
this computer. [Working together](sharing.md) has the routes, and the
[Security](security.md) table the rows "A hand-off link reaches the wrong person or does more than
meant" and "A public hand-off link exposes more of this computer than the hand-off".

## Profiles and proxies per session

Each session runs on a browser profile (its languages, time zone, screen, graphics request, seed)
and, if you set one, its own proxy, independent of each other: see
[Browser profiles](profiles.md) and `network` in [Configuration](configuration.md). With
`requireValidatedProfiles` `true` a session starts only on a profile whose measurement on this
computer passed every check (`validated`, or `consistent` on a computer without a graphics card).

## What the status says

`pairbrowse_status` on a server names the virtual screen, keep-alive, the session's profile and
its status on this build, its network and the exit's last check, and its graphics: `Graphics:
hardware (<renderer>), requested auto, validated on <build>` on a computer with a graphics card;
`Graphics: software (<renderer>), shown as Windows 11 with NVIDIA GeForce RTX 3060, requested
auto, consistent on <build>` on one without. The helper log (`~/.pairbrowse/daemon.log`) says the
same at each start (and, once the font setup has run, whether the stand-ins are on), and the
install check's lines say which Windows fonts are found, standing in or missing.
