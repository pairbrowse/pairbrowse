// The pinned native PairBrowse downloads, and the engine pack the native browser launches with.
//
// The native browser (scripts/native-install.mjs installs it) is launched with switches and
// humanized input built by the engine pack: a small archive published next to the browser builds
// (built by the private PairBrowse Pro repo: engine/build.mjs). It's downloaded on first use,
// checked against the SHA-256s pinned here (the archive, then each file again before it's loaded),
// and kept in ~/.pairbrowse/engine.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, mkdtempSync, renameSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { paths } from "./paths.mjs";
import { downloadPinned, readJson, sha256, sha256File } from "./util.mjs";

const run = promisify(execFile);
const INSTALLER = join(dirname(fileURLToPath(import.meta.url)), "native-install.mjs");

// The native build PairBrowse uses: a new version is a deliberate change here, with the SHA-256s
// the Pro repo's builds print (macOS: scripts/package.py, Linux/Windows: scripts/linuxwin.py, the
// engine pack: engine/build.mjs). baseUrl: the public GitHub release they're published in (file
// name appended). A platform whose sha256 is null has no build yet.
export const NATIVE = {
  version: "150.0.7871.114",
  arm64: { file: "pairbrowse-150.0.7871.114-macos-arm64.zip", sha256: "097f1231f13f1bba3a2580bf3f83d682571e329496fbe5261fc22a4cc9e5a743" },
  x64: { file: "pairbrowse-150.0.7871.114-macos-x86_64.zip", sha256: "148496489ffabe2a649a3283e83dcdc2f42a5e2fa5df5294c24b11f2e8d373e8" },
  linux: { file: "pairbrowse-150.0.7871.114-linux-x64.tar.xz", sha256: "677c9f5c19a8a48e39b890206ef9aee1c0f1647f41d73ee7d5f7d9331fcb75e0" },
  windows: { file: "pairbrowse-150.0.7871.114-windows-x64.zip", sha256: null },
  engine: {
    file: "pairbrowse-engine-150.0.7871.114.tgz",
    sha256: "629d7bf87293b1707ff07e597581dd44c528733a93644b17d84245d966705cf2",
    files: { "engine.mjs": "6d72cf1a49807f23fa0a73fe8b7678ed88727913b5ec403c3ca61b358194d6d9", "collector.js": "38d4afc53caccc1b92d640354166f53c2108f489c6c054ad0f81ca9d7a02b151" },
  },
  baseUrl: "https://github.com/pairbrowse/pairbrowse/releases/download/browser-150.0.7871.114",
};

// How to install a pinned file by hand, for error messages.
export const installHint = (asset) => `node ${INSTALLER} <${asset.file}>`;

// A pinned file in ~/.pairbrowse/downloads, fetched from the release when it isn't there yet.
export function pinnedArchive(asset, log, what = `PairBrowse ${NATIVE.version} (about 150-250 MB, once)`) {
  const archive = join(paths.home, "downloads", asset.file);
  if (!existsSync(archive)) log(`downloading ${what}`);
  return downloadPinned(`${NATIVE.baseUrl}/${asset.file}`, archive, asset.sha256);
}

export const engineDir = () => join(paths.home, "engine");

// Each pinned file of an unpacked engine pack, checked against its SHA-256 (throws on the first
// that doesn't match). Returns their contents.
function checkEngineFiles(dir, pins) {
  const files = {};
  for (const [name, want] of Object.entries(pins)) {
    const file = join(dir, name);
    if (!existsSync(file)) throw new Error(`the engine pack has no ${name}`);
    const data = readFileSync(file);
    if (sha256(data) !== want) throw new Error(`the engine pack's ${name} doesn't match its pinned SHA-256`);
    files[name] = data;
  }
  return files;
}

// Installs an engine pack archive into ~/.pairbrowse/engine. The installed pack is replaced only
// once the new one checks out, and comes back if the swap fails. Returns the folder.
export async function installEngine(archive, { sha256: want = NATIVE.engine.sha256, log = () => {}, pins = NATIVE.engine.files } = {}) {
  archive = resolve(archive);
  const got = await sha256File(archive);
  if (got !== want) throw new Error(`${basename(archive)} doesn't match its SHA-256 (expected ${want}, got ${got})`);
  const dir = engineDir();
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dirname(dir), ".engine-"));
  try {
    log(`unpacking ${basename(archive)}`);
    await run("tar", ["-xzf", archive, "-C", staging], { timeout: 120_000, windowsHide: true });
    const unpacked = join(staging, "engine");
    checkEngineFiles(unpacked, pins);
    const manifest = readJson(join(unpacked, "engine.json"));
    if (manifest?.product !== "PairBrowse engine") throw new Error("not a PairBrowse engine pack");
    writeFileSync(join(unpacked, "installed.json"), JSON.stringify({ version: manifest.version, sha256: got, archive: basename(archive), installedAt: new Date().toISOString() }, null, 2) + "\n");
    const previous = join(staging, "previous");
    if (existsSync(dir)) renameSync(dir, previous);
    try {
      renameSync(unpacked, dir);
    } catch (e) {
      if (existsSync(previous)) renameSync(previous, dir);
      throw e;
    }
    log(`installed the PairBrowse engine ${manifest.version}`);
    return dir;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// The pinned engine pack, installed (downloaded first when needed). Returns its folder.
export async function ensureEngine(log = () => {}) {
  const dir = engineDir();
  if (readJson(join(dir, "installed.json"))?.sha256 === NATIVE.engine.sha256) return dir;
  const archive = await pinnedArchive(NATIVE.engine, log, "the PairBrowse engine (under 1 MB, once)").catch((e) => {
    throw new Error(`the PairBrowse engine isn't installed (${e.message}). Install it with: ${installHint(NATIVE.engine)}`);
  });
  const installed = await installEngine(archive, { log });
  rmSync(archive, { force: true }); // installed and checked: the download isn't needed any more
  return installed;
}

// Loads an installed engine pack: its launch helpers, plus the host fingerprint collector's source.
// Every file is checked against its pin again first.
export async function loadEngine(dir = engineDir(), pins = NATIVE.engine.files) {
  const files = checkEngineFiles(dir, pins);
  // Keyed by content: a pack replaced while the helper runs is loaded again, not served from cache.
  const helpers = await import(`${pathToFileURL(join(dir, "engine.mjs")).href}?sha256=${pins["engine.mjs"]}`);
  return { ...helpers, collector: files["collector.js"].toString("utf8") };
}
