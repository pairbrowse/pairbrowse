import { userInfo } from "node:os";
import { join, sep } from "node:path";
import { mkdirSync, chmodSync, appendFileSync, writeSync } from "node:fs";
import { writeJsonAtomic, sha256, readJson, onCorruptJson, corruptLine } from "./util.mjs";
import { resolveHome, gateProjectEnv, BAD_INSTANCE } from "./home.mjs";
import { checkDownloads } from "./rules/downloads.mjs";
import { checkConfig, configProblem, configWarnings } from "./config-schema.mjs";
import { screenBrowserArgs, droppedWarning, sandboxOffAllowed, sandboxOffAsked, sandboxRefusal, argsKey, browserArgsOf, browserSandboxOf } from "./browser-args.mjs";

// Everything PairBrowse writes is private to your user account.
process.umask(0o077);

// The home (home.mjs): PAIRBROWSE_HOME, else a named instance (PAIRBROWSE_INSTANCE, or the
// project's .pairbrowse.json), else ~/.pairbrowse. SHARED holds the read-only installs every
// instance uses (the default home; the home itself when PAIRBROWSE_HOME is set).
// A home or name a project's own settings set is dropped first (home.mjs gateProjectEnv), so
// neither this process nor the helper it starts uses it.
const GATED = gateProjectEnv(process.env);
// A malformed PAIRBROWSE_INSTANCE stops every process that would use a home (the hooks, the
// bridge, the helper) with one clear line and exit code 2, never a stack trace: a hook's 2 blocks
// the call (PreToolUse) and tells Claude why, and the bridge doesn't start.
export const SELECTED = (() => {
  try {
    return resolveHome();
  } catch (e) {
    if (e?.code !== BAD_INSTANCE) throw e;
    try { writeSync(2, `PairBrowse is off: ${e.message}. Fix or remove PAIRBROWSE_INSTANCE in your shell or settings, then start a new session.\n`); } catch {}
    process.exit(2);
  }
})();
if (GATED.length) SELECTED.warning = [SELECTED.warning, `${GATED.join(" and ")} set by this project's settings`].filter(Boolean).join("; ");
export const HOME = SELECTED.home;
export const SHARED = SELECTED.shared;
export const INSTANCE = SELECTED.instance;
// Under the test runner (node --test sets NODE_TEST_CONTEXT, which the processes a test starts
// inherit) the person's own home is never used: a test without a home of its own stops here.
// The account's own home (userInfo reads the system's record; a test may point $HOME elsewhere).
const REAL = join(userInfo().homedir, ".pairbrowse");
if (process.env.NODE_TEST_CONTEXT && [HOME, SHARED].some((h) => h === REAL || h.startsWith(REAL + sep))) {
  throw new Error("A test reached the real ~/.pairbrowse: set PAIRBROWSE_HOME to a folder under the temp folder first (test/helpers/home.mjs).");
}

export const paths = {
  home: HOME,
  // The read-only installs' home (runtime, browser apps, engine pack, tools, downloads), shared
  // by instances, and the lock one install at a time takes there (install-lock.mjs).
  shared: SHARED,
  installLock: join(SHARED, "install.lock"),
  profile: join(HOME, "profile"),
  secrets: join(HOME, "secrets.env"),
  facts: join(HOME, "facts.md"),
  config: join(HOME, "config.json"),
  runs: join(HOME, "runs"),
  reviews: join(HOME, "reviews"),
  log: join(HOME, "log"),
  runtime: join(SHARED, "runtime"),
  daemonLog: join(HOME, "daemon.log"),
  // Diagnostics bundles (scripts/diagnostics-bundle.mjs), when no other folder is given.
  diagnostics: join(HOME, "diagnostics"),
  // Playwright may read files only inside this folder (and the project).
  files: join(HOME, "files"),
  uploads: join(HOME, "files", "uploads"),
  // Private runtime files: the socket, the helper key file, the heartbeat, the opener record.
  run: join(HOME, "run"),
  // The one helper's lock (its pid; its time is when the helper started).
  daemonLock: join(HOME, "daemon.lock"),
  // The helper's heartbeat (touched every few seconds): tunnel keepers stop without it.
  helperAlive: join(HOME, "run", "helper-alive"),
  // A clean session's marker: the next start opens a clean session again.
  cleanSession: join(HOME, "run", "clean-session"),
  // Pinned downloads (browser builds, the engine pack) before they're installed.
  downloads: join(SHARED, "downloads"),
  // Installed browsers: the native build (PairBrowse.app on macOS), the open build's macOS app.
  browser: join(SHARED, "browser"),
  nativeApp: join(SHARED, "browser", "PairBrowse.app"),
  buildStamp: join(SHARED, "browser", "build.sha256"),
  // The engine pack, installed and checked.
  engine: join(SHARED, "engine"),
  // Pinned tools (cloudflared, shared) and the Quick Tunnels' logs (this home's).
  tools: join(SHARED, "tools"),
  tunnels: join(HOME, "tunnels"),
  // This Mac's captured host profile (native builds).
  hostProfile: join(SHARED, "mac-host-profile.json"),
  // Saved fast-mode playbooks; browser sessions (the default session's files sit in the home).
  playbooks: join(HOME, "playbooks"),
  sessions: join(HOME, "sessions"),
  currentSession: join(HOME, "session"),
  // Facts Claude may fill in (facts.md above is the older format, imported once).
  factsJson: join(HOME, "facts.json"),
  // Sharing's saved state (tunnels, invites), previews of downloaded files, recordings.
  sharing: join(HOME, "sharing.json"),
  previews: join(HOME, "previews"),
  recordings: join(HOME, "recordings.json"),
  // The only way into the browser: a socket file only you can open (a named pipe on Windows).
  socket: process.platform === "win32"
    ? `\\\\.\\pipe\\pairbrowse-${sha256(`${userInfo().username}:${HOME}`).slice(0, 16)}`
    : join(HOME, "run", "browser.sock"),
};

// A state file that isn't valid JSON is copied aside before anything starts it afresh (util.mjs
// readJson); whichever process found it (the helper, the runs server, a hook) says so in daemon.log.
onCorruptJson((file, copy) => { try { appendFileSync(paths.daemonLog, `${new Date().toISOString()} ${corruptLine(file, copy)}\n`); } catch {} });

// A browser session's profile and its own files: the default session's are the originals in the
// home; a named one's sit in sessions/ (file: "people.json", "tabs.json", "timeline", "activity.json").
export const sessionProfile = (name) => (name === "default" ? paths.profile : join(paths.sessions, name));
export const sessionFile = (name, file) => (name === "default" ? join(HOME, file) : join(paths.sessions, `${name}.${file}`));

export const DEFAULT_CONFIG = {
  // Which browser PairBrowse runs: "pairbrowse" (the native PairBrowse build), "pairbrowse-open"
  // (the open build with the PairBrowse side panel; older name "chromium"), or an absolute path to
  // a browser of your own on the same engine (Brave, Arc, Vivaldi). Unset:
  // "pairbrowse" where a build is pinned for this computer, else "pairbrowse-open" (browserChoice in
  // browser.mjs). The older names browserEngine and executablePath are still read while this is
  // unset, and never written.
  browser: null,
  // Browser automation driver. Patchright is the default and recommended one; "playwright" is an
  // optional opt-in. On a Node.js too old for Patchright the helper falls back to Playwright
  // and says so once (scripts/driver.mjs).
  browserDriver: "patchright",
  // Label this Claude connection in a shared browser (or set PAIRBROWSE_PARTICIPANT).
  participantName: null,
  // Most tabs open at once; the one used longest ago closes when another opens.
  maxTabs: 20,
  // A small screenshot of the page with each result that changes it (false: text only).
  screenshots: true,
  // Where files a site hands over are saved (default: your Downloads folder).
  downloadsDir: null,
  // Extra browser switches, e.g. ["--lang=en-US"] (older name: chromeArgs, read while this is unset).
  browserArgs: [],
  // The browser's own sandbox. On by default; false turns it off on Linux only (off by itself as
  // root there, and where the system can't run it). Older name: chromeSandbox.
  browserSandbox: true,
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
  // Report a problem (Settings, About and diagnostics): the https address a report you send goes
  // to (no user, query or fragment; anything else is ignored): PairBrowse's own, which files it as
  // a Jira bug. null: no report is ever sent, and Settings doesn't offer it. Nothing goes there but
  // what you saw and sent, and only when you press Send.
  reportUrl: "https://pairbrowse.com/api/report",
  // What agents press on a site's cookie banner: "accept" or "reject" (Settings).
  cookieChoice: "accept",
  // Ask which browser session to open when the browser starts (Settings); false opens the last one.
  sessionPicker: true,
  // The browser server's pause after each action, in ms (0 to 5000; null: 200).
  settleMs: null,
  // The live view docked beside Claude (scripts/launch.mjs, the desktop pane): its width in pixels
  // (null: the pane's own), the app it docks to, its distance from the screen's top, and whether
  // that app's window makes room for it.
  dockWidth: null,
  dockHost: "Claude",
  dockTop: 52,
  dockMakeRoom: false,
  // The native PairBrowse build's own settings (scripts/native-engine.mjs: fingerprint, humanize,
  // typingPace, motion, geoip, profile, ...). {}: its defaults.
  pairbrowse: {},
};

// The last loadConfig's warnings (config-schema.mjs): a key it doesn't know, a value of the wrong
// type (refused: the default is used for that key). The helper logs each once and pairbrowse_status
// names them (serve/tools/status.mjs statusLine).
export const CONFIG_WARNINGS = [];

// config.json checked against the one schema (config-schema.mjs) over the defaults. A downloads
// folder written into config.json by hand gets Settings' check (rules/downloads.mjs); one that
// fails it is read as none (your Downloads folder). Every save checks again.
// log(line): each warning, once per load (the helper's log; nothing by default).
export function loadConfig(file = paths.config, log = () => {}) {
  const checked = checkConfig(readJson(file, {}));
  CONFIG_WARNINGS.length = 0;
  CONFIG_WARNINGS.push(...configWarnings(checked, file));
  const config = { ...DEFAULT_CONFIG, ...checked.config };
  // The switches and the sandbox under their new names only, from either name in the file
  // (browser-args.mjs browserArgsOf, browserSandboxOf): everything after this reads one name.
  const key = argsKey(checked.config);
  delete config.chromeArgs;
  delete config.chromeSandbox;
  config.browserArgs = browserArgsOf(checked.config);
  config.browserSandbox = browserSandboxOf(checked.config);
  // A browserArgs switch that would open a debugging surface or weaken security is dropped here
  // (browser-args.mjs), named once in the log and in pairbrowse_status; launchArgs screens again.
  // The sandbox stays on outside Linux: browserSandbox false or a --no-sandbox is refused, and said.
  const asked = sandboxOffAllowed(process.platform) ? null : sandboxOffAsked(checked.config, process.platform);
  if (asked) CONFIG_WARNINGS.push(`config.json: ${sandboxRefusal(asked, process.platform)}`);
  const { kept, dropped, refused } = screenBrowserArgs(config.browserArgs);
  if (dropped.length || refused.length) config.browserArgs = kept;
  if (dropped.length) CONFIG_WARNINGS.push(droppedWarning(dropped, key));
  if (refused.length && asked !== `${key} has --no-sandbox`) CONFIG_WARNINGS.push(`config.json: ${sandboxRefusal(`${key} has --no-sandbox`, process.platform)}`);
  for (const w of CONFIG_WARNINGS) try { log(w); } catch {}
  if (config.downloadsDir != null && (typeof config.downloadsDir !== "string" || (config.downloadsDir && checkDownloads(config.downloadsDir, { home: paths.home }).problem))) config.downloadsDir = null;
  return config;
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
// short leaves the old file. A value of the wrong type (config-schema.mjs) is refused, nothing
// written: it throws that message. Returns what the file holds now.
export function saveConfig(fields, file = paths.config) {
  const problem = configProblem(fields);
  if (problem) throw new Error(problem);
  let saved = {};
  const read = readJson(file);
  if (read && typeof read === "object" && !Array.isArray(read)) saved = read;
  for (const [k, v] of Object.entries(fields || {})) if (v !== undefined) saved[k] = v;
  writeJsonAtomic(file, saved);
  return saved;
}

export function ensureDirs() {
  for (const dir of [paths.home, paths.profile, paths.runs, paths.reviews, paths.log, paths.files, paths.uploads, paths.run]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Tighten folders created by older versions or another umask.
  if (process.platform !== "win32") for (const dir of [paths.home, paths.profile, paths.run]) chmodSync(dir, 0o700);
}
