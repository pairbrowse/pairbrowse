import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, chmodSync } from "node:fs";
import { writeJsonAtomic } from "./util.mjs";

// Everything PairBrowse writes is private to your user account.
process.umask(0o077);

export const HOME = process.env.PAIRBROWSE_HOME || join(homedir(), ".pairbrowse");

export const paths = {
  home: HOME,
  profile: join(HOME, "profile"),
  secrets: join(HOME, "secrets.env"),
  facts: join(HOME, "facts.md"),
  config: join(HOME, "config.json"),
  runs: join(HOME, "runs"),
  reviews: join(HOME, "reviews"),
  log: join(HOME, "log"),
  runtime: join(HOME, "runtime"),
  daemonLog: join(HOME, "daemon.log"),
  // Playwright may read files only inside this folder (and the project).
  files: join(HOME, "files"),
  uploads: join(HOME, "files", "uploads"),
  // The only way into the browser: a socket file only you can open (a named pipe on Windows).
  socket: process.platform === "win32"
    ? `\\\\.\\pipe\\pairbrowse-${createHash("sha256").update(`${userInfo().username}:${HOME}`).digest("hex").slice(0, 16)}`
    : join(HOME, "run", "browser.sock"),
};

export const DEFAULT_CONFIG = {
  // Which browser PairBrowse runs: "pairbrowse" (the native PairBrowse build), "chromium"
  // (ungoogled-chromium on macOS, Playwright's Chromium elsewhere, with the PairBrowse side panel),
  // or an absolute path to your own Chromium-based browser (Brave, Arc, Vivaldi). Unset:
  // "pairbrowse" where a build is pinned for this computer, else "chromium" (browserChoice in
  // browser.mjs). The older names browserEngine and executablePath are still read while this is
  // unset, and never written.
  browser: null,
  // Browser automation driver. Patchright is the default and recommended one; "playwright" is an
  // optional opt-in. On a Node.js too old for Patchright the helper falls back to Playwright
  // and says so once (scripts/driver.mjs).
  browserDriver: "patchright",
  // Label this Claude connection in a shared browser (or set PAIRBROWSE_PARTICIPANT).
  participantName: null,
  // Origins ("https://intranet.example.com") where a plain form submit goes without asking (your
  // call, your browser). Payments, deletions and publishing still ask there.
  // Most tabs open at once; the one used longest ago closes when another opens.
  maxTabs: 20,
  // A small screenshot of the page with each result that changes it (false: text only).
  screenshots: true,
  // Where files a site hands over are saved (default: your Downloads folder).
  downloadsDir: null,
  // Extra Chrome flags, e.g. ["--lang=en-US"].
  chromeArgs: [],
  // Chromium's own sandbox. On by default; false turns it off (off by itself as root on Linux,
  // and where the system can't run it).
  chromeSandbox: true,
  // On a Linux machine without a screen, PairBrowse runs the browser headed on a private virtual
  // screen (Xvfb) and you watch through the live view. "auto": use one when there's no screen;
  // "xvfb": always; "none": never.
  display: "auto",
  // Fixed live view port, so an SSH tunnel command stays the same. 0 picks a random port.
  liveViewPort: 0,
  // Extra host names the live view answers to, for invite links only (say, this computer's
  // Tailscale name, myhost.example.ts.net). The live view still listens on 127.0.0.1 only.
  liveViewHosts: [],
  // Where invite links point, e.g. "https://myhost.example.ts.net"; its host must be in
  // liveViewHosts. Without it, invite links are local addresses reached through an SSH tunnel.
  inviteBaseUrl: null,
  // Joining: besides Cloudflare Quick Tunnel addresses (*.trycloudflare.com), the https host
  // names you trust in join codes (say, a teammate's own tunnel name).
  joinHosts: [],
  // Sharing's public address. tunnel: { "kind": "quick" } (default: a Cloudflare Quick Tunnel, no
  // account), or your own: { "kind": "cloudflare", "token", "hostname" }, { "kind": "ngrok",
  // "authtoken", "domain" }, { "kind": "tailscale" }, { "kind": "command", "run", "url", "env" }
  // (docs/sharing.md, "Using your own tunnel"). guestPort pins the port join codes are served
  // on (0: random), for a tunnel whose target is set on the provider's side.
  sharing: { tunnel: { kind: "quick" }, guestPort: 0 },
  // The session's timeline: the pictures the helper already sent to agents, kept per browser
  // session under ~/.pairbrowse (at most 200, pinned ones past that). false keeps none.
  timeline: true,
  // How many unpinned pictures the timeline keeps per session (1 to 200).
  timelineCap: 200,
  // Where the browser's own pages start: each dock "open", "rail" or "hidden", and the tab
  // strip's height in pixels (44 to 176).
  layout: { left: "open", right: "open", strip: 88 },
};

export function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(paths.config, "utf8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// The name people in a shared session see for this person: set in config (participantName) or
// PAIRBROWSE_PARTICIPANT, else none yet (then it's asked once, and saved with saveParticipantName).
export const savedName = (config) => String(config?.participantName || process.env.PAIRBROWSE_PARTICIPANT || "").trim();
export function saveParticipantName(config, name) {
  config.participantName = name;
  saveConfig({ participantName: name });
}

// Merges fields into config.json (the file's own keys, not the defaults), keeping everything else
// it holds; undefined values are skipped. Written through a temp file and a rename, so a write cut
// short leaves the old file. Returns what the file holds now.
export function saveConfig(fields, file = paths.config) {
  let saved = {};
  try { const read = JSON.parse(readFileSync(file, "utf8")); if (read && typeof read === "object" && !Array.isArray(read)) saved = read; } catch {}
  for (const [k, v] of Object.entries(fields || {})) if (v !== undefined) saved[k] = v;
  writeJsonAtomic(file, saved);
  return saved;
}

export function ensureDirs() {
  for (const dir of [paths.home, paths.profile, paths.runs, paths.reviews, paths.log, paths.files, paths.uploads, join(HOME, "run")]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Tighten folders created by older versions or another umask.
  if (process.platform !== "win32") for (const dir of [paths.home, paths.profile, join(HOME, "run")]) chmodSync(dir, 0o700);
}
