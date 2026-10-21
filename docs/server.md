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
the exact pixels, even though what pages read is one ordinary desktop graphics identity the
browser carries (an Intel UHD Graphics 770 in WebGL, and the same identity in WebGPU wherever an
adapter is available; on a server without a graphics card there is usually none, which pages can
see too; no canvas noise unless `pairbrowse.graphicsNoise` is `true`, so sessions on one such
computer share its canvas reading). PairBrowse never pretends otherwise to you: the
helper log, `pairbrowse_status`, the install check and a diagnostics report say "software
rendering, shown as Intel UHD Graphics 770", and a browser profile checked there reads
"consistent" rather than "validated". Expect more verification steps handed to you than on a
computer with a graphics card. Asking for a GPU (`pairbrowse.graphics` `"gpu"`) on such a computer
refuses the start by name rather than pretending.

## What to install

- Node.js 20 or newer, and the plugin (see [Install](install.md)).
- `xvfb` and `xauth` (Debian and Ubuntu: `sudo apt-get install -y xvfb xauth`): the private
  virtual screen the browser runs on when the server has no screen.
- A normal desktop font set, so pages render as they do on a desktop and font checks resolve:
  on Debian and Ubuntu `fonts-liberation fonts-dejavu-core fonts-noto-core fonts-noto-cjk
  fonts-noto-color-emoji` (the Linux build also brings its own metric-compatible clones of the
  common desktop fonts).
- Mesa's software renderers (`libgl1-mesa-dri`, `mesa-vulkan-drivers`) on a computer without a
  graphics card; the drivers of your graphics card on one with it.
- The native PairBrowse browser: server mode runs only that one (`"browser": "pairbrowse"` in
  `~/.pairbrowse/config.json`; the plugin downloads and checks it on first use). PairBrowse as an
  extension never runs in server mode.

Run PairBrowse as a normal user, never as root: the browser's sandbox is always on in server mode
and refuses to start as root.

## The helper as a service

Set `"server": { "keepAlive": true }` in `~/.pairbrowse/config.json`: the browser starts as soon
as the helper does and its saved tabs come back; a browser that crashes or is closed comes back by
itself (after 2 s, then 10 s, then 30 s; three crashes within five minutes stop the restarts for
five minutes); only stopping the helper keeps it closed; and a newer plugin version never stops
this helper (`pairbrowse_status` says to restart the service to move to it).

A systemd user unit for it (`~/.config/systemd/user/pairbrowse.service`; `<plugin copy>` is the
installed plugin's folder, for example `~/.claude/plugins/cache/pairbrowse/pairbrowse/<version>`):

```ini
[Unit]
Description=PairBrowse helper
After=network-online.target

[Service]
ExecStart=/usr/bin/node <plugin copy>/scripts/daemon.mjs
Restart=on-failure
RestartSec=5
Environment=PAIRBROWSE_HOME=%h/.pairbrowse

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
`Graphics: software (<renderer>), shown as Intel UHD Graphics 770, requested auto, consistent on
<build>` on one without. The helper log (`~/.pairbrowse/daemon.log`) says the same at each start.
