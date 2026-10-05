#!/usr/bin/env node
// The install step for the native PairBrowse browser (built by the private PairBrowse Pro repo;
// pinned in native-pack.mjs). Every build goes through it, by hand
// (node scripts/native-install.mjs <archive>) or on the next start when the pin changes. It checks
// the archive's SHA-256 and build manifest (on macOS also the app's signature, name and icon),
// installs it at ~/.pairbrowse/browser/PairBrowse.app (macOS) or ~/.pairbrowse/browser/PairBrowse
// (the previous one stays as PairBrowse-previous[.app]), sets up the profile, then passes the launch
// self-check (native-check.mjs). If any check fails, the previous build and settings come back.
// The same command installs an engine pack (pairbrowse-engine-<version>.tgz).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, mkdtempSync, renameSync, readdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { paths, loadConfig } from "./paths.mjs";
import { prepareProfile } from "./browser.mjs";
import { engineProfile } from "./engine.mjs";
import { nativeManifest } from "./native-engine.mjs";
import { selfCheck } from "./native-check.mjs";
import { NATIVE, installHint, pinnedArchive, ensureEngine, installEngine } from "./native-pack.mjs";
import { BRANDING, brandNativeApp, registerApp, verifySignature } from "./macos-app.mjs";
import { currentSession, profileDir } from "./sessions.mjs";
import { readJson, sha256File } from "./util.mjs";

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

export const nativeDirs = (layout = nativeLayout() || nativeLayout("darwin")) => {
  const dir = join(paths.home, "browser");
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
// Then it can't be swapped: Chromium starts its helpers from the browser's path, so they'd come
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
  const inside = (app.endsWith(".app") ? join(app, "Contents") : app) + "/";
  return r.stdout.split("\n").some((l) => l.trimStart().startsWith(inside));
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
      let alive;
      try { process.kill(pid, 0); alive = pid > 0; } catch (err) { alive = err.code === "EPERM"; }
      if (alive) throw new Error(`another PairBrowse install is running (process ${pid})`);
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
  if (pending.config === null) rmSync(paths.config, { force: true });
  else if (typeof pending.config === "string") writeFileSync(paths.config, pending.config);
  rmSync(d.pending, { force: true });
  return true;
}

// Moves a checked app into place: the current one becomes the rollback copy. The pending note is
// written first, so a swap cut short anywhere from here is undone by the next install or start.
async function swapIn(d, app, configBefore) {
  if (await runningFrom(d.app)) throw new Error("the PairBrowse browser is open: quit it (or stop the PairBrowse helper) and try again");
  writeFileSync(d.pending, JSON.stringify({ hadOld: existsSync(d.app), config: configBefore, startedAt: new Date().toISOString() }));
  rmSync(d.rollback, { recursive: true, force: true });
  if (existsSync(d.app)) renameSync(d.app, d.rollback);
  renameSync(app, d.app);
}

const writeRecord = (d, record) => writeFileSync(d.record, JSON.stringify(record, null, 2) + "\n");
const readConfigText = () => (existsSync(paths.config) ? readFileSync(paths.config, "utf8") : null);
// Leftovers of an install or check that was killed half-way (call with the lock held).
function sweepLeftovers(d) {
  for (const name of readdirSync(d.dir)) if (/^\.(install|selfcheck)-/.test(name) && name !== basename(d.pending)) rmSync(join(d.dir, name), { recursive: true, force: true });
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
  if (manifest.arch && manifest.arch !== layout.arch) throw new Error(`the build is for ${manifest.arch}, this computer is ${layout.arch}`);
  if (!mac && manifest.platform !== layout.platform) throw new Error(`the build is for ${manifest.platform}, not ${layout.platform}`);
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
// register: tell macOS about the new app; layout: this platform's (tests pass another one).
export async function installNative(archive, { sha256, log = () => {}, check = selfCheck, register = true, layout = nativeLayout() } = {}) {
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

      // Settings: use it (keeping the driver and everything else), and set up the profile.
      writeFileSync(paths.config, JSON.stringify({ ...readJson(paths.config, {}), browserEngine: "pairbrowse", executablePath: d.exec }, null, 2) + "\n");
      const config = loadConfig();
      try { prepareProfile(engineProfile(config, profileDir(currentSession()))); } catch {}

      log("checking the new browser");
      const passed = await check(d.exec, { config, log });
      // Passed: from here on the new app stays, whatever happens to the bookkeeping below.
      writeRecord(d, { version: manifest.version, sha256: got, archive: basename(archive), installedAt: new Date().toISOString(), checks: passed, branding: BRANDING });
      rmSync(d.pending, { force: true });
      committed = true;
      await keepPrevious(d, layout, log);
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
async function ensureNativeBrowser(log, { pinned, asset }) {
  const layout = nativeLayout();
  const d = nativeDirs();
  if (existsSync(d.pending)) {
    // An install was cut short: undo it before using whatever app is there.
    try { await withLock(d.dir, () => recoverInterrupted(log, d)); } catch (e) { log(`couldn't finish undoing an earlier install (${e.message})`); }
  }
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
    const exec = await installNative(archive, { sha256: asset.sha256, log });
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
// (tests pass stand-ins).
export async function ensureNative(log = () => {}, { pinned = pinnedArchive, engine = ensureEngine, asset = pinnedAsset() } = {}) {
  const exec = await ensureNativeBrowser(log, { pinned, asset });
  if (exec) await engine(log);
  return exec;
}

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) {
  const args = process.argv.slice(2);
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
    .then(() => enginePack ? installEngine(archive, { sha256: expectedSha256(archive, sha256), log }) : installNative(archive, { sha256, log }))
    .then((installed) => { console.log(installed); process.exit(0); }, (e) => { console.error(`pairbrowse: ${e.message}`); process.exit(1); });
}
