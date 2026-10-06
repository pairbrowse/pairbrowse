import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";

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
  // "auto": on a Mac, the native PairBrowse build when there's one for this chip (installed, or
  // downloadable from its pinned release), otherwise "chromium" (ungoogled-chromium on macOS,
  // Playwright's Chromium elsewhere). Set "chromium" or "pairbrowse" to choose.
  browserEngine: "auto",
  // Browser automation driver. Patchright is the default and recommended one; "playwright" is an
  // optional opt-in. On a Node.js too old for Patchright the helper falls back to Playwright
  // and says so once (scripts/driver.mjs).
  browserDriver: "patchright",
  // Path to another Chromium-based browser (Brave, Arc, Vivaldi) instead of the PairBrowse browser.
  executablePath: null,
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
  let file = {};
  try { file = JSON.parse(readFileSync(paths.config, "utf8")); } catch {}
  mkdirSync(paths.home, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ ...file, participantName: name }, null, 2) + "\n");
}

export function ensureDirs() {
  for (const dir of [paths.home, paths.profile, paths.runs, paths.reviews, paths.log, paths.files, paths.uploads, join(HOME, "run")]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Tighten folders created by older versions or another umask.
  if (process.platform !== "win32") for (const dir of [paths.home, paths.profile, join(HOME, "run")]) chmodSync(dir, 0o700);
}
