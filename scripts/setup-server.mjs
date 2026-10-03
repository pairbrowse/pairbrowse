#!/usr/bin/env node
// One-time setup for running PairBrowse on a Linux server (for example over an SSH session from
// the Claude desktop app). Run as the normal user that runs Claude Code, not root:
//   node scripts/setup-server.mjs
import { spawnSync } from "node:child_process";
import { writeFileSync, cpSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { paths, ensureDirs, loadConfig } from "./paths.mjs";
import { driverCli } from "./browser.mjs";
import { validateBrowserDriver } from "./driver.mjs";
import { hasCommand } from "./display.mjs";
import { SERVER_LIVE_VIEW_PORT } from "./remote.mjs";
import { ensureRuntime } from "./runtime.mjs";
import { readJson } from "./util.mjs";

const ok = (m) => console.log(`  ok    ${m}`);
const todo = (m) => console.log(`  todo  ${m}`);
let problems = 0;

console.log("pairbrowse server setup\n");
if (process.platform !== "linux") todo("This script is for Linux servers. On your own computer, nothing to set up.");
if (process.getuid?.() === 0) { todo("You're root. Run Claude Code and PairBrowse as a normal user: Chrome's sandbox needs it."); problems++; }

// The browser driver in use sets the Node.js version needed (patchright: 20, Playwright: 18).
let driverOk = true;
try {
  validateBrowserDriver(loadConfig());
  ok(`Node.js ${process.versions.node}`);
} catch (e) {
  todo(e.message);
  problems++;
  driverOk = false;
}

ensureDirs();
ensureRuntime((m) => console.log(`        ${m}`));

// A fixed copy of the plugin, so a Claude Code on another computer can start it over SSH.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginCopy = join(paths.home, "plugin");
if (resolve(pluginCopy) !== root) {
  rmSync(pluginCopy, { recursive: true, force: true });
  cpSync(root, pluginCopy, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) });
}
ok(`plugin copy for remote use: ${pluginCopy}`);
ok("browser runtime installed in ~/.pairbrowse/runtime (pinned, checksummed)");

const config = loadConfig();
const next = readJson(paths.config, {});
if (config.executablePath) ok(`browser: ${config.executablePath}`);
else if (driverOk) {
  console.log("        downloading Chromium for the PairBrowse browser (about 150 MB)...");
  // The driver in use installs its own Chromium build (patchright and Playwright pin different ones).
  const r = spawnSync(process.execPath, [driverCli(), "install", "chromium"], { stdio: "inherit" });
  if (r.status === 0) ok("Chromium installed");
  else { todo("Chromium download failed. Check the network, then run this again."); problems++; }
}

if (hasCommand("Xvfb") && hasCommand("xauth")) ok("Xvfb and xauth found: the browser runs headed on a private virtual screen");
else { todo("Install a virtual screen: sudo apt-get install -y xvfb xauth   (Fedora: sudo dnf install xorg-x11-server-Xvfb xorg-x11-xauth)"); problems++; }
todo("If Chrome fails to start, install its system libraries once: sudo npx playwright install-deps chromium");

next.display = next.display || "auto";
next.liveViewPort = next.liveViewPort || SERVER_LIVE_VIEW_PORT;
writeFileSync(paths.config, JSON.stringify(next, null, 2) + "\n");
ok(`config: ${paths.config} (live view port ${next.liveViewPort})`);

const host = process.env.SSH_CONNECTION?.split(" ")[2] || "<this server>";
console.log(`
Claude Code on your own computer can drive this browser directly. On your computer, put this in
~/.pairbrowse/config.json, then restart Claude Code:

  { "remote": "<you>@${host}" }

Or, with Claude Code running here on the server (an SSH session), keep a tunnel open on your computer:

  ssh -N -L ${next.liveViewPort}:127.0.0.1:${next.liveViewPort} <you>@${host}

Then open the live view link Claude gives you (http://127.0.0.1:${next.liveViewPort}/...) in the
Claude desktop app's Browser pane or any browser on your computer.
${problems ? `\n${problems} thing(s) to fix above.` : "\nAll set."}`);
