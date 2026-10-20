#!/usr/bin/env node
// The install step for the native PairBrowse browser (built by the private PairBrowse Pro repo;
// pinned in native-pack.mjs). Every build goes through it, by hand
// (node scripts/native-install.mjs <archive>) or on the next start when the pin changes. It checks
// the archive's SHA-256 and build manifest (on macOS also the app's signature, name and icon),
// installs it at ~/.pairbrowse/browser/PairBrowse.app (macOS) or ~/.pairbrowse/browser/PairBrowse
// (the previous one stays as PairBrowse-previous[.app]), sets up the profile, then passes the launch
// self-check (native/check.mjs). If any check fails, the previous build and settings come back.
// The same command installs an engine pack (pairbrowse-engine-<version>.tgz).
// Only while "browser" in config.json is "pairbrowse" (or unset on a computer a build is pinned
// for): with "pairbrowse-open" or a path to a browser of your own, nothing is downloaded or installed.
// Run by hand in a terminal with no choice recorded yet, it asks once which browser to use
// (askBrowserChoice) and records the answer. An install writes nothing else into config.json.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, mkdtempSync, renameSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { paths, loadConfig, saveConfig } from "../paths.mjs";
import { prepareProfile, browserChoice } from "../browser.mjs";
import { engineProfile } from "../engine.mjs";
import { nativeManifest, declaresOwnPages } from "../native-engine.mjs";
import { engineConfig, shellFrom, OPEN_BROWSER } from "../browser/choice.mjs";
import { selfCheck } from "./check.mjs";
import { NATIVE } from "../native-pack.mjs";
import { installHint, pinnedArchive, ensureEngine, installEngine } from "./pack.mjs";
import { withInstallLock } from "../install-lock.mjs";
import { BRANDING, brandNativeApp, registerApp, verifySignature } from "./macos-app.mjs";
import { installDesktop } from "./desktop.mjs";
import { currentSession, profileDir } from "../sessions.mjs";
import { readJson, sha256File, within, writeJsonAtomic, pidAlive } from "../util.mjs";

const run = promisify(execFile);
const UNPACK_TIMEOUT_MS = 600_000;

// What a native build looks like here: the folder it installs as, its program and build manifest
// inside that folder, its archive pin, and the arch its manifest names. null: no native build for
// this platform and chip.
export function nativeLayout(platform = process.platform, arch = process.arch) {
  if (platform === "darwin") {
    return { platform: "macos", folder: "PairBrowse.app", previous: "PairBrowse-previous.app", rollback: ".rollback.app",
      exec: ["Contents", "MacOS", "pairbrowse"], pin: NATIVE[arch === "arm64" ? "arm64" : "x64"], arch: arch === "arm64" ? "arm64" : "x86_64" };
  }
  if (arch !== "x64" || !["linux", "win32"].includes(platform)) return null;
  const linux = platform === "linux";
  return { platform: linux ? "linux" : "windows", folder: "PairBrowse", previous: "PairBrowse-previous", rollback: ".rollback",
    exec: [linux ? "chrome" : "chrome.exe"], pin: NATIVE[linux ? "linux" : "windows"], arch: "x64" };
}

// The pinned archive for this platform and chip, or null while there's no build for it.
export const pinnedAsset = (layout = nativeLayout()) => (layout?.pin?.sha256 ? layout.pin : null);

// With "browser" set to "pairbrowse-open" (or its older name "chromium") or a path of your own: why nothing is downloaded or installed
// (null: the PairBrowse browser is the one in use, or nobody chose and a build is pinned here).
export function notChosen(config, native) {
  const c = browserChoice(config, { native });
  if (!c.set || c.browser === "pairbrowse") return null;
  return `browser is ${c.browser === OPEN_BROWSER ? OPEN_BROWSER : "a browser of your own"} in ~/.pairbrowse/config.json: nothing to download or install`;
}

export const nativeDirs = (layout = nativeLayout() || nativeLayout("darwin")) => {
  const dir = paths.browser;
  return {
    dir,
    app: join(dir, layout.folder),
    previous: join(dir, layout.previous),
    record: join(dir, "native.json"), // what's installed: version, archive SHA-256, self-check, branding
    // During a swap: the build being replaced, and what to put back if the swap is cut short.
    rollback: join(dir, layout.rollback),
    pending: join(dir, ".install-pending.json"),
    exec: join(dir, layout.folder, ...layout.exec),
  };
};

// The SHA-256 an archive must have: given, or from its .sha256 file next to it ("<hex>  <name>").
export function expectedSha256(archive, given) {
  const valid = (hex) => {
    if (!/^[0-9a-f]{64}$/i.test(String(hex))) throw new Error(`not a SHA-256: ${String(hex).slice(0, 80)}`);
    return String(hex).toLowerCase();
  };
  if (given !== undefined) return valid(given);
  const side = `${archive}.sha256`;
  if (!existsSync(side)) throw new Error(`no SHA-256 for ${basename(archive)}: pass --sha256 or keep ${basename(side)} next to it`);
  const [hex, name] = readFileSync(side, "utf8").trim().split(/\s+/);
  if (name && name.replace(/^\*/, "") !== basename(archive)) throw new Error(`${basename(side)} is for ${name}, not ${basename(archive)}`);
  return valid(hex);
}

// Is any browser process running from this build right now (the browser or one of its helpers)?
// Then it can't be swapped: the engine starts its helpers from the browser's path, so they'd come
// from the new build. When the process list can't be read, assume it is.
async function runningFrom(app) {
  if (process.platform === "win32") {
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { $_.ExecutablePath }"], { maxBuffer: 16 << 20, windowsHide: true }).catch(() => null);
    if (!r) return true;
    const inside = (app + "\\").toLowerCase();
    return r.stdout.split(/\r?\n/).some((l) => l.trim().toLowerCase().startsWith(inside));
  }
  const r = await run("/bin/ps", ["-axo", "command="], { maxBuffer: 16 << 20 }).catch(() => null);
  if (!r) return true;
  return openFrom(r.stdout.split("\n"), app);
}

// Whether any of these command lines runs a program inside the app (macOS: its Contents). The
// helper's own PairBrowse Agent (Contents/Helpers/PairBrowse Agent.app, which runs the helper
// itself) doesn't count: otherwise a helper started on it could never update the app it runs from.
// Moving the app aside while the Agent runs is safe: the running program keeps its file.
export function openFrom(lines, app) {
  const inside = (app.endsWith(".app") ? join(app, "Contents") : app) + "/";
  const agent = inside + "Helpers/PairBrowse Agent.app/";
  return lines.some((l) => { const c = l.trimStart(); return c.startsWith(inside) && !c.startsWith(agent); });
}

// One install at a time (the CLI and the helper's start-up check could otherwise swap the same
// app at once). The lock names its process; a lock left by a process that's gone is taken over.
function takeLock(dir) {
  const file = join(dir, ".install.lock");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" });
      return () => rmSync(file, { force: true });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(readFileSync(file, "utf8")) || 0;
      if (pidAlive(pid)) throw new Error(`another PairBrowse install is running (process ${pid})`);
      // Take the dead lock over atomically: only one process can move it aside, and only if it's
      // still the dead one (not a fresh lock another process just took).
      const aside = `${file}.${process.pid}`;
      try { renameSync(file, aside); } catch { continue; }
      if (Number(readFileSync(aside, "utf8")) !== pid) { try { renameSync(aside, file); } catch {} throw new Error("another PairBrowse install just started"); }
      rmSync(aside, { force: true });
    }
  }
  throw new Error("couldn't take the install lock");
}

async function withLock(dir, work) {
  mkdirSync(dir, { recursive: true });
  const unlock = takeLock(dir);
  try { return await work(); } finally { unlock(); }
}

// Puts things back after a swap that was cut short (killed, or a rollback that failed): the
// replaced app returns, the unchecked one goes, and so do the settings it wrote. Call with the
// install lock held.
function recoverInterrupted(log, d = nativeDirs()) {
  const pending = readJson(d.pending);
  if (!pending) return false;
  log("an earlier install didn't finish; putting the previous browser back");
  if (existsSync(d.rollback)) {
    rmSync(d.app, { recursive: true, force: true });
    renameSync(d.rollback, d.app);
  } else if (!pending.hadOld) rmSync(d.app, { recursive: true, force: true });
  // The settings of the home that ran that install (the browser folder is shared by instances).
  const configFile = typeof pending.configFile === "string" && isAbsolute(pending.configFile) && basename(pending.configFile) === "config.json" ? pending.configFile : paths.config;
  if (pending.config === null) rmSync(configFile, { force: true });
  else if (typeof pending.config === "string") writeFileSync(configFile, pending.config);
  rmSync(d.pending, { force: true });
  return true;
}

// Moves a checked app into place: the current one becomes the rollback copy. The pending note is
// written first, so a swap cut short anywhere from here is undone by the next install or start.
async function swapIn(d, app, configBefore) {
  if (await runningFrom(d.app)) throw new Error("the PairBrowse browser is open: quit it (or stop the PairBrowse helper) and try again");
  writeJsonAtomic(d.pending, { hadOld: existsSync(d.app), config: configBefore, configFile: paths.config, startedAt: new Date().toISOString() });
  rmSync(d.rollback, { recursive: true, force: true });
  if (existsSync(d.app)) renameSync(d.app, d.rollback);
  renameSync(app, d.app);
}

const writeRecord = (d, record) => writeJsonAtomic(d.record, record);
const readConfigText = () => (existsSync(paths.config) ? readFileSync(paths.config, "utf8") : null);
// Leftovers of an install or check that was killed half-way (call with the lock held).
function sweepLeftovers(d) {
  for (const name of readdirSync(d.dir)) if (/^\.(install|selfcheck)-/.test(name) && name !== basename(d.pending)) rmSync(join(d.dir, name), { recursive: true, force: true });
}

// The chips a Mach-O program runs on ("arm64", "x86_64"; a universal one names each), or null
// when the file isn't a Mach-O program.
const CPU = { 0x0100000c: "arm64", 0x01000007: "x86_64" };
export function machoArchs(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const b = Buffer.alloc(4096);
    const n = readSync(fd, b, 0, b.length, 0);
    if (n < 8) return null;
    if (b.readUInt32LE(0) === 0xfeedfacf) return [CPU[b.readUInt32LE(4)] || "other"];
    if (b.readUInt32BE(0) === 0xcafebabe || b.readUInt32BE(0) === 0xcafebabf) {
      const count = b.readUInt32BE(4), size = b.readUInt32BE(0) === 0xcafebabf ? 32 : 20;
      if (count < 1 || count > 16 || 8 + count * size > n) return null;
      return Array.from({ length: count }, (_, i) => CPU[b.readUInt32BE(8 + i * size)] || "other");
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// A build fits this computer only when its manifest names this platform and this chip (arch is
// required: a manifest without one is refused). macOS builds' manifests name no platform: there it
// may be absent or "macos", and the program itself must be a Mach-O program for this chip
// (machO: machoArchs of the program). Throws a sentence otherwise.
export function buildFits(manifest, layout, machO = null) {
  const mac = layout.platform === "macos";
  // Named in a refusal only as text: any other value (an object whose toString isn't one) is unknown.
  const named = typeof manifest?.platform === "string" ? manifest.platform.slice(0, 40) : "an unknown platform";
  if (typeof manifest?.arch !== "string" || !manifest.arch) throw new Error(`the build's manifest names no arch; this computer is ${layout.arch}`);
  if (manifest.arch !== layout.arch) throw new Error(`the build is for ${manifest.arch}, this computer is ${layout.arch}`);
  if (mac) {
    if (manifest.platform !== undefined && manifest.platform !== "macos") throw new Error(`the build is for ${named}, not macos`);
    if (!machO) throw new Error("the build's program isn't a macOS program");
    if (!machO.includes(layout.arch)) throw new Error(`the build's program runs on ${machO.join(", ")}, this computer is ${layout.arch}`);
  } else if (manifest.platform !== layout.platform) {
    throw new Error(`the build is for ${named}, not ${layout.platform}`);
  }
}

// Unpacks an archive into staging and checks its manifest (and on macOS its signature, then
// brands it). Returns the app folder and its manifest.
async function unpackChecked(archive, staging, layout, log) {
  const mac = layout.platform === "macos";
  log(`unpacking ${basename(archive)}`);
  // ditto keeps macOS signatures intact; tar (bsdtar on Windows 10+) reads .tar.xz and .zip.
  if (mac) await run("ditto", ["-x", "-k", archive, staging], { timeout: UNPACK_TIMEOUT_MS });
  else await run("tar", ["-xf", archive, "-C", staging], { timeout: UNPACK_TIMEOUT_MS, windowsHide: true });
  const app = join(staging, layout.folder);
  const exec = join(app, ...layout.exec);
  if (!existsSync(exec)) throw new Error(`the archive has no ${layout.folder}`);
  const manifest = nativeManifest(exec);
  buildFits(manifest, layout, mac ? machoArchs(exec) : null);
  if (mac) {
    await verifySignature(app);
    await run("xattr", ["-cr", app]); // no quarantine on a build we checked ourselves
    await brandNativeApp(app, log);
    await verifySignature(app);
  }
  return { app, manifest };
}

// Installs a native build archive (macOS .zip from package.py, Linux .tar.xz or Windows .zip from
// linuxwin.py). Returns the installed executable. check: the launch check (tests pass a stand-in);
// register: tell the desktop about the new app (macOS: Launch Services; Linux: its desktop entry
// and icons, native/desktop.mjs, under dataHome when given); layout: this platform's (tests pass
// another one).
// config: the settings (default: config.json); with "browser" set to "pairbrowse-open" or a path, it
// installs nothing and returns null.
export async function installNative(archive, { sha256, log = () => {}, check = selfCheck, register = true, layout = nativeLayout(), config = loadConfig(), dataHome } = {}) {
  const skip = notChosen(config, !!layout);
  if (skip) { log(skip); return null; }
  archive = resolve(archive);
  const want = expectedSha256(archive, sha256);
  const got = await sha256File(archive);
  if (got !== want) throw new Error(`${basename(archive)} doesn't match its SHA-256 (expected ${want}, got ${got})`);
  if (!layout) throw new Error(`there is no native PairBrowse browser for ${process.platform} ${process.arch}`);
  const d = nativeDirs(layout);
  return withLock(d.dir, async () => {
    let staging = null, swapped = false, committed = false;
    try {
      recoverInterrupted(log, d);
      sweepLeftovers(d);
      staging = mkdtempSync(join(d.dir, ".install-"));
      const configBefore = readConfigText();
      if (await runningFrom(d.app)) throw new Error("the PairBrowse browser is open: quit it (or stop the PairBrowse helper) first");
      const { app, manifest } = await unpackChecked(archive, staging, layout, log);
      await swapIn(d, app, configBefore);
      swapped = true;
      if (register && layout.platform === "macos") await registerApp(d.app);

      // The profile, set up for it (config.json isn't written: "browser" picks the browser).
      const using = engineConfig(config, { binary: "native", executablePath: d.exec });
      try { prepareProfile(engineProfile(using, profileDir(currentSession())), undefined, { browserPages: shellFrom(manifest).ownPages, layout: using.layout }); } catch {}

      log("checking the new browser");
      const passed = await check(d.exec, { config: using, log });
      // Passed: from here on the new app stays, whatever happens to the bookkeeping below.
      writeRecord(d, { version: manifest.version, sha256: got, archive: basename(archive), installedAt: new Date().toISOString(), checks: passed, branding: BRANDING, ownPages: declaresOwnPages(manifest) });
      rmSync(d.pending, { force: true });
      committed = true;
      await keepPrevious(d, layout, log);
      // Linux: the window's name and icon. Never fails the install.
      if (register && layout.platform === "linux") {
        try {
          const entry = installDesktop(d.app, d.exec, { browserDir: d.dir, ...(dataHome ? { home: dataHome } : {}) });
          if (entry) log(`desktop entry: ${entry}`);
        } catch (e) { log(`couldn't install the desktop entry (${e.message})`); }
      }
      log(`installed PairBrowse ${manifest.version}: ${passed.join("; ")}`);
      return d.exec;
    } catch (e) {
      if (swapped && !committed) {
        log(`install failed (${e.message}); putting the previous browser back`);
        try { recoverInterrupted(() => {}, d); } catch (err) { log(`couldn't put it back yet (${err.message}); the next install or start will`); }
      }
      throw e;
    } finally {
      if (staging) rmSync(staging, { recursive: true, force: true });
    }
  });
}

// After a committed install: the replaced build becomes the one previous copy kept.
async function keepPrevious(d, layout, log) {
  if (!existsSync(d.rollback)) return;
  try {
    if (await runningFrom(d.previous)) log(`${layout.previous} is in use; keeping the older copy`);
    else {
      rmSync(d.previous, { recursive: true, force: true });
      renameSync(d.rollback, d.previous);
    }
  } catch (e) { log(`couldn't keep the previous build (${e.message})`); }
}

// Brands an installed macOS build again (when BRANDING changed), on a clone that's checked before
// it replaces the app, so a cut-short run never leaves a broken signature. Skipped while it's open.
async function rebrandInstalled(d, record, log) {
  try {
    await withLock(d.dir, async () => {
      if (await runningFrom(d.app)) return;
      sweepLeftovers(d);
      const staging = mkdtempSync(join(d.dir, ".install-"));
      try {
        const clone = join(staging, basename(d.app));
        await run("cp", ["-Rc", d.app, clone]).catch(() => run("ditto", [d.app, clone], { timeout: UNPACK_TIMEOUT_MS })); // a clone on APFS: instant
        await brandNativeApp(clone, log);
        await verifySignature(clone);
        await swapIn(d, clone, readConfigText());
        writeRecord(d, { ...record, branding: BRANDING });
        rmSync(d.pending, { force: true });
        rmSync(d.rollback, { recursive: true, force: true });
        await registerApp(d.app);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    });
  } catch (e) {
    try { await withLock(d.dir, () => recoverInterrupted(() => {}, d)); } catch {}
    log(`couldn't update the PairBrowse branding (${e.message})`);
  }
}

// The pinned native build for this platform and chip, installed (and checked) when the installed
// one isn't it. Returns its executable, or null when there's no pinned build. Whenever the pinned
// build can't be had or doesn't pass, a working installed app (of any version) is kept.
async function ensureNativeBrowser(log, { pinned, asset, config }) {
  const layout = nativeLayout();
  const d = nativeDirs();
  if (existsSync(d.pending)) {
    // An install was cut short: undo it before using whatever app is there.
    try { await withLock(d.dir, () => recoverInterrupted(log, d)); } catch (e) { log(`couldn't finish undoing an earlier install (${e.message})`); }
  }
  // (Read after that undo: it may have put the settings back.)
  const settings = config ?? loadConfig();
  const skip = notChosen(settings, !!asset);
  if (skip) { log(skip); return null; }
  if (!asset) return null;
  const record = readJson(d.record);
  if (record?.sha256 === asset.sha256 && existsSync(d.exec)) {
    if (layout.platform === "macos" && record.branding !== BRANDING) await rebrandInstalled(d, record, log);
    return d.exec;
  }
  let installed = null;
  try { installed = nativeManifest(d.exec).version; } catch {}
  try {
    const archive = await pinned(asset, log);
    const exec = await installNative(archive, { sha256: asset.sha256, log, config: settings });
    rmSync(archive, { force: true }); // installed and checked: the download isn't needed any more
    return exec;
  } catch (e) {
    if (!installed) throw new Error(`PairBrowse ${NATIVE.version} isn't installed (${e.message}). Install it with: ${installHint(asset)}`);
    log(`couldn't install PairBrowse ${NATIVE.version} (${e.message}); keeping ${installed}`);
    return d.exec;
  }
}

// On start: the native build and its engine pack (the browser can't launch without it). Returns
// the executable to use, or null when this platform and chip have no native build.
// pinned / engine / asset: how the archive and engine pack are fetched, and which build is pinned
// (tests pass stand-ins). config: the settings (default: config.json, read after an earlier
// install cut short is undone); with "browser" set to "pairbrowse-open" or a path, null and nothing done.
export async function ensureNative(log = () => {}, { pinned = pinnedArchive, engine = ensureEngine, asset = pinnedAsset(), config = undefined } = {}) {
  // One install at a time in the shared installs' home: an instance waits for another's install
  // of the same build instead of failing on its lock (install-lock.mjs).
  return withInstallLock(async () => {
    const exec = await ensureNativeBrowser(log, { pinned, asset, config });
    if (exec) await engine(log);
    return exec;
  }, { say: log });
}

export const BROWSER_QUESTION = "Which browser should PairBrowse use?\n" +
  "  1. PairBrowse (recommended): its own browser build; free for personal use (BINARY-LICENSE.md)\n" +
  "  2. PairBrowse (open build): the open-source build with the PairBrowse side panel\n" +
  "Choice [1]: ";

// The first-setup question, in the by-hand install step's terminal (the helper never asks: it has
// no terminal, and uses the default until a person chooses in Settings). Returns the choice:
// the recorded one without asking; "pairbrowse-open" without asking or recording on a computer with no
// pinned build; otherwise asked once (ask(question) in tests; a terminal on input and output by
// default, timeoutMs to answer): "2", "open", "pairbrowse-open" or "chromium" is the open build, anything else (Enter, no answer in
// time, no terminal) is PairBrowse. The answer is recorded in config.json ("browser").
export async function askBrowserChoice({ config = loadConfig(), native = !!pinnedAsset(), input = process.stdin, output = process.stderr, ask = null, timeoutMs = 60_000, log = () => {} } = {}) {
  const recorded = browserChoice(config, { native });
  if (recorded.set) return recorded.browser;
  if (!native) return OPEN_BROWSER;
  let answer = "";
  if (ask) answer = await ask(BROWSER_QUESTION);
  else if (input?.isTTY && output?.isTTY) {
    const { createInterface } = await import("node:readline/promises");
    const ac = new AbortController();
    const rl = createInterface({ input, output });
    try {
      answer = await within(timeoutMs, rl.question(BROWSER_QUESTION, { signal: ac.signal }).catch(() => ""));
      if (answer === null) output.write("\n");
    } finally { ac.abort(); rl.close(); }
  }
  const browser = /^\s*(2|open|pairbrowse-open|chromium)\s*$/i.test(String(answer ?? "")) ? OPEN_BROWSER : "pairbrowse";
  saveConfig({ browser });
  log(`browser: ${browser} (recorded in ~/.pairbrowse/config.json)`);
  return browser;
}

// The by-hand install step's line when it installs nothing: a recorded open build or path names
// config.json; with nothing recorded (no build pinned for this computer) it names the missing pin.
export function skipMessage(config = loadConfig(), native = !!pinnedAsset()) {
  const recorded = browserChoice(config, { native });
  if (!recorded.set) return 'pairbrowse: no PairBrowse build is pinned for this computer; nothing downloaded or installed. Set "browser": "pairbrowse" in ~/.pairbrowse/config.json to install this file by hand.';
  return `pairbrowse: browser is ${recorded.browser} in ~/.pairbrowse/config.json: nothing downloaded or installed. Set it to "pairbrowse" to install the PairBrowse browser.`;
}

// The by-hand install step (node scripts/native-install.mjs <archive> [--sha256 <hex>]): args are
// the command line's arguments. Exits the process when done.
export function runInstallCli(argv) {
  const args = [...argv];
  const i = args.indexOf("--sha256");
  let sha256;
  if (i >= 0) {
    sha256 = args[i + 1];
    if (!sha256 || sha256.startsWith("--")) { console.error("pairbrowse: --sha256 needs a value"); process.exit(2); }
    args.splice(i, 2);
  }
  if (args.length !== 1) {
    console.error("usage: node scripts/native-install.mjs <pairbrowse-<version>-macos-arm64.zip | …-macos-x86_64.zip | …-linux-x64.tar.xz | …-windows-x64.zip | pairbrowse-engine-<version>.tgz> [--sha256 <hex>]");
    process.exit(2);
  }
  const log = (m) => console.log(`pairbrowse: ${m}`);
  const archive = resolve(args[0]);
  const enginePack = /^pairbrowse-engine-.*\.tgz$/.test(basename(archive));
  Promise.resolve()
    .then(async () => {
      const choice = await askBrowserChoice({ log });
      if (choice !== "pairbrowse") { console.log(skipMessage()); return process.exit(0); }
      const installed = enginePack ? await installEngine(archive, { sha256: expectedSha256(archive, sha256), log }) : await installNative(archive, { sha256, log });
      if (installed === null) { console.log(skipMessage()); return process.exit(0); }
      console.log(installed);
      process.exit(0);
    })
    .catch((e) => { console.error(`pairbrowse: ${e.message}`); process.exit(1); });
}
