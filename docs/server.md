# Servers and cloud sessions

## Run the browser on a server

- **Claude Code on your computer, browser on your server:** run `node scripts/setup-server.mjs`
  once on the server, then put `{ "remote": "you@server" }` in `~/.pairbrowse/config.json` on
  your computer. One SSH connection (key login) carries Claude's commands and the live view.
- **Claude Code on the server too** (an SSH session in the desktop app): run the same setup script,
  then keep `ssh -N -L 47290:127.0.0.1:47290 you@server` open on your computer for the live view.

On a Linux server without a screen, PairBrowse runs the browser headed on a private virtual
screen (Xvfb without TCP, behind an X cookie).

## Cloud sessions

A claude.ai cloud session runs in a container you can't connect into, and cloud sessions have
no Browser pane, so there's no way to watch or click the browser live from one. Signups also
need your logins to last, which a cloud container doesn't do. Instead:

- **Remote Control** (recommended): run the session on your own computer, either in the
  desktop app or with `claude remote-control` in a terminal in your project folder, and it shows
  up in the Claude app on any device. The browser and your logins stay on your computer.
- **Your own server** over an SSH session in the desktop app: run `node scripts/setup-server.mjs`
  on it and watch through the live view. Run it as a normal user, not root.
  Whether the desktop Browser pane can open the server's `127.0.0.1` pages isn't documented yet;
  forward the port with `ssh -L` if it can't.
