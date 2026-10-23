// The server setup's fonts (server-mode spec step 52; decision 11: free fonts only, and the
// metric-compatible route to measure). Run by the person, as the user PairBrowse runs as:
//   node scripts/native/fontsetup.mjs check      what the browser finds now, and what is missing
//   node scripts/native/fontsetup.mjs install    installs the set, then checks again
// Debian and Ubuntu first (the packages through apt, with sudo); on Fedora and Arch it names the
// packages to install with dnf or pacman and does the rest; elsewhere docs/server.md lists them.
// What it installs, all free and never from a third-party mirror site:
//   1. Microsoft's core fonts for the web, only through the distribution's own package
//      (ttf-mscorefonts-installer, Debian's contrib or Ubuntu's multiverse), and only after the
//      person accepted Microsoft's EULA: on Debian (whose package asks nothing) this shows the
//      licence's text (corefonts-eula.txt: the text Ubuntu's own package shows, its debconf note
//      msttcorefonts/present-mscorefonts-eula) and installs only on a typed "yes"; on Ubuntu the
//      package shows it and asks itself. The acceptance is recorded once (setup.json, with the
//      text's SHA-256). Nothing here answers for the person: the one way past the question is the
//      owner's own recorded acceptance for an unattended server, "server": { "acceptMsCoreFontsEula":
//      true } in config.json or `install --accept-ms-corefonts-eula`, each the owner's act (the
//      licence's text sits beside this file); only then is Ubuntu's own question preseeded, as
//      the distribution itself provides for an unattended install.
//   2. Colour emoji and CJK (fonts-noto-color-emoji, fonts-noto-cjk).
//   3. The open stand-ins, one distinct family per Windows name (winfonts.mjs STAND_INS): Selawik
//      from Microsoft's own release (SELAWIK: the archive and each font pinned by SHA-256, its OFL
//      licence beside them), and the rest from their publishers (native/standins.mjs: Google Fonts'
//      own repository at one commit, DejaVu's own release), every file and its licence pinned,
//      each family in its own folder beside its licence, never renamed or modified.
//   4. The browser's font configuration (native/fontconf.mjs), switched by pairbrowse.fontStandIns.
// Node's standard library only.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { userInfo } from "node:os";
import { inflateRawSync } from "node:zlib";
import { paths } from "../paths.mjs";
import { downloadPinned, readJson, sha256, writeJsonAtomic } from "../util.mjs";
import { STAND_IN_FONTS, urlName } from "./standins.mjs";
import { SELAWIK_DIR, fontSource, fontStandInsOf, readSetup, writeFontsConf } from "./fontconf.mjs";
import { fontGroups, fontGroupsLine, fontStatus, readFontFamilies } from "./winfonts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// Microsoft's EULA for the TrueType core fonts for the Web, as the distribution shows it.
export const EULA_FILE = join(HERE, "corefonts-eula.txt");
export const CORE_PACKAGE = "ttf-mscorefonts-installer";

// Selawik 1.01, Microsoft's release (github.com/microsoft/Selawik, tag 1.01): the archive, the
// five fonts in it, and the licence at the tag's commit.
export const SELAWIK = Object.freeze({
  version: "1.01",
  url: "https://github.com/microsoft/Selawik/releases/download/1.01/Selawik_Release.zip",
  file: "Selawik_Release-1.01.zip",
  sha256: "3f62c51e05e3b5a1e6241cf92a371f0be2ea1183aa87b30718bbd40832a8d423",
  fonts: Object.freeze({
    "selawk.ttf": "e9d98518d8ac2817782a9a382430463a2e0793ea68350b695bb727d9a830ee1c",
    "selawkb.ttf": "f0db5e174a90e0956ad7d2844bdca1d5e6da92ec65b2c04e57ba9b180668c904",
    "selawkl.ttf": "8e19d073091a1e869b5b0d48b925e605c0a4c6ece7df7b22a364fb065314c4c5",
    "selawksb.ttf": "0a9e9d0549a10f24bef9b3a29e06fe6e0b5c21e7a784c503b048a307841a7783",
    "selawksl.ttf": "8620960344f12093482cded984a1aafa5a57d24cbf7e9299da125ccf0e9d4102",
  }),
  license: Object.freeze({ url: "https://raw.githubusercontent.com/microsoft/Selawik/b65ff9ce7c4673e75ec5c622924a6b6f61f2f876/LICENSE.txt", file: "LICENSE.txt", sha256: "77b7c2506d4efb22e09c8ccf10159f4956eab3ef7c007fef95de136bcf45300c" }),
});

// The packages per distribution family. core: Microsoft's core fonts package (null where the
// distribution's own repositories carry none: PairBrowse never takes them from elsewhere);
// component: the section it lives in.
export const PACKAGES = Object.freeze({
  debian: { manager: "apt", core: CORE_PACKAGE, component: "contrib", base: ["fontconfig"], emoji: ["fonts-noto-color-emoji"], cjk: ["fonts-noto-cjk"] },
  ubuntu: { manager: "apt", core: CORE_PACKAGE, component: "multiverse", base: ["fontconfig"], emoji: ["fonts-noto-color-emoji"], cjk: ["fonts-noto-cjk"] },
  fedora: { manager: "dnf", core: null, base: ["fontconfig"], emoji: ["google-noto-color-emoji-fonts"], cjk: ["google-noto-sans-cjk-fonts"] },
  arch: { manager: "pacman", core: null, base: ["fontconfig"], emoji: ["noto-fonts-emoji"], cjk: ["noto-fonts-cjk"] },
});
const MANAGER_COMMAND = { apt: "sudo apt-get install", dnf: "sudo dnf install", pacman: "sudo pacman -S" };
export const freePackages = (plan) => [...plan.base, ...plan.emoji, ...plan.cjk];

// The families those packages give, as fontconfig names them, for a computer whose packages the
// person installs (no apt): colour emoji and CJK (Noto Sans CJK JP and its sisters, by the name's
// start). The open stand-ins come from their publishers on every distribution (STAND_IN_FONTS).
export const FREE_FAMILIES = Object.freeze(["Noto Color Emoji", "Noto Sans CJK"]);
// Which of FREE_FAMILIES fontconfig's entries (winfonts.mjs parseFontList) lack; all when fc-list
// couldn't be asked.
export function freeFamiliesLacking(entries) {
  if (!entries) return [...FREE_FAMILIES];
  const names = entries.flatMap((e) => e.families);
  return FREE_FAMILIES.filter((family) => { const want = family.toLowerCase(); return !names.some((n) => n === want || n.startsWith(`${want} `)); });
}

const QUERY_MS = 30_000, FC_CACHE_MS = 120_000;

// /etc/os-release's fields: { id, like: [ids], name }.
export function parseOsRelease(text) {
  const f = {};
  for (const line of String(text || "").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) f[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return { id: (f.ID || "").toLowerCase(), like: (f.ID_LIKE || "").toLowerCase().split(/\s+/).filter(Boolean), name: f.PRETTY_NAME || f.NAME || "" };
}

// The distribution family PACKAGES has, or null: Ubuntu and its derivatives before Debian (their
// core fonts live in multiverse and the package asks for the EULA itself).
export function distroOf(os) {
  const ids = [os?.id, ...(os?.like || [])];
  for (const family of ["ubuntu", "debian", "fedora", "arch"]) if (ids.includes(family)) return family;
  if (ids.some((id) => ["rhel", "centos"].includes(id))) return "fedora";
  return null;
}

// Which of names dpkg calls installed: dpkg-query's "<package> <status>" lines ("ii" installed).
export function parseDpkgStatus(text) {
  const installed = new Set();
  for (const line of String(text || "").split("\n")) {
    const [name, status] = line.trim().split(/\s+/);
    if (name && /^ii/.test(status || "")) installed.add(name.replace(/:[a-z0-9]+$/, ""));
  }
  return installed;
}

// apt-cache policy's candidate for one package, or null ("(none)", or the package unknown: its
// section isn't in this computer's sources).
export function parseCandidate(text) {
  const m = /Candidate:\s*(\S+)/.exec(String(text || ""));
  return m && m[1] !== "(none)" ? m[1] : null;
}

// The entries of a zip archive (its central directory): Map name -> { method, csize, size, local }.
export function zipEntries(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("the archive's directory is damaged");
    const nameLength = buf.readUInt16LE(p + 28);
    out.set(buf.toString("utf8", p + 46, p + 46 + nameLength), { method: buf.readUInt16LE(p + 10), csize: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24), local: buf.readUInt32LE(p + 42) });
    p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

// One entry's bytes (stored or deflated; nothing else is read).
export function zipRead(buf, entry) {
  const l = entry.local;
  if (buf.readUInt32LE(l) !== 0x04034b50) throw new Error("the archive's entry is damaged");
  const start = l + 30 + buf.readUInt16LE(l + 26) + buf.readUInt16LE(l + 28);
  const data = buf.subarray(start, start + entry.csize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: entry.size + 1 });
  throw new Error(`an entry compressed in a way PairBrowse doesn't read (method ${entry.method})`);
}

// Whether every pinned font and the licence are in dir as pinned.
export function selawikInstalled(dir, pin = SELAWIK) {
  try {
    return [...Object.entries(pin.fonts), [pin.license.file, pin.license.sha256]].every(([name, want]) => sha256(readFileSync(join(dir, name))) === want);
  } catch { return false; }
}

// Selawik into dir: the release archive (downloads, pinned), each pinned font taken from it
// under its own name and checked against its own pin, and the licence (pinned). Nothing else in
// the archive is written. download: util.mjs downloadPinned's stand-in for tests.
export async function installSelawik({ dir, downloads = paths.downloads, pin = SELAWIK, download = downloadPinned } = {}) {
  if (selawikInstalled(dir, pin)) return { installed: false };
  const archive = await download(pin.url, join(downloads, pin.file), pin.sha256);
  const buf = readFileSync(archive);
  const entries = zipEntries(buf);
  const fonts = {};
  for (const [name, want] of Object.entries(pin.fonts)) {
    const entry = entries.get(name);
    if (!entry) throw new Error(`Selawik's release has no ${name}`);
    const data = zipRead(buf, entry);
    if (sha256(data) !== want) throw new Error(`Selawik's ${name} doesn't match its pinned SHA-256`);
    fonts[name] = data;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  await download(pin.license.url, join(dir, pin.license.file), pin.license.sha256);
  for (const [name, data] of Object.entries(fonts)) writeFileSync(join(dir, name), data, { mode: 0o644 });
  return { installed: true };
}

// Whether one STAND_IN_FONTS family is in dir as pinned (every font and its licence).
export function standInInstalled(dir, pin) {
  try {
    return [...Object.entries(pin.fonts), [pin.license.file, pin.license.sha256]].every(([name, want]) => sha256(readFileSync(join(dir, name))) === want);
  } catch { return false; }
}

// The STAND_IN_FONTS families not in place under fontsDir (their dirs).
export const standInsMissing = (fontsDir, pins = STAND_IN_FONTS) => pins.filter((pin) => !standInInstalled(join(fontsDir, pin.dir), pin)).map((pin) => pin.dir);

// One family into dir: each font (from its URL, or read from the pinned release archive) checked
// against its own pin, and its licence beside it; every file is fetched and checked before any is
// written, and nothing else is written. download: util.mjs downloadPinned's stand-in for tests.
export async function installStandIn({ dir, pin, downloads = paths.downloads, download = downloadPinned }) {
  if (standInInstalled(dir, pin)) return { installed: false };
  const files = {};
  if (pin.archive) {
    const buf = readFileSync(await download(pin.archive.url, join(downloads, pin.archive.file), pin.archive.sha256));
    const entries = zipEntries(buf);
    const take = (inArchive, name, want) => {
      const entry = entries.get(inArchive);
      if (!entry) throw new Error(`${pin.family}'s release has no ${name}`);
      const data = zipRead(buf, entry);
      if (sha256(data) !== want) throw new Error(`${pin.family}'s ${name} doesn't match its pinned SHA-256`);
      files[name] = data;
    };
    for (const [name, want] of Object.entries(pin.fonts)) take(pin.archive.prefix + name, name, want);
    take(pin.license.inArchive, pin.license.file, pin.license.sha256);
  } else {
    const staging = join(downloads, "fonts", pin.dir);
    for (const [name, want] of [...Object.entries(pin.fonts), [pin.license.file, pin.license.sha256]]) {
      const url = name === pin.license.file ? pin.license.url : pin.base + urlName(name);
      files[name] = readFileSync(await download(url, join(staging, name), want));
    }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data, { mode: 0o644 });
  return { installed: true };
}

// Every STAND_IN_FONTS family under fontsDir: { installed: [dirs written], failed: [{ dir, error }] }.
export async function installStandIns({ fontsDir, pins = STAND_IN_FONTS, downloads = paths.downloads, download = downloadPinned } = {}) {
  const out = { installed: [], failed: [] };
  for (const pin of pins) {
    try {
      if ((await installStandIn({ dir: join(fontsDir, pin.dir), pin, downloads, download })).installed) out.installed.push(pin.dir);
    } catch (e) { out.failed.push({ dir: pin.dir, error: e?.message || String(e) }); }
  }
  return out;
}

// The person's answer to Microsoft's EULA for the core fonts: { accepted, how } where how is
// "recorded" (accepted before, same text), "typed" (the text shown, "yes" typed), "package" (the
// distribution's package asks, Ubuntu: the person goes ahead with "yes" and answers its own
// question there), "preset" (the owner accepted beforehand for an unattended server: `preset`
// names where, config.json's key or the flag; the text isn't shown, its path is named once, and
// `source` carries where), or why not ("declined", "no answer"). ask(question): one line the
// person typed, or null when nobody can answer (no terminal, input closed): never taken as yes.
export async function eulaAnswer({ distro, ask, print, record = null, text = readFileSync(EULA_FILE, "utf8"), preset = null }) {
  const textSha = sha256(text);
  if (record?.coreFonts?.eula?.sha256 === textSha) return { accepted: true, how: "recorded" };
  if (preset) {
    print(`Microsoft's licence (EULA) for the core fonts for the web: accepted by the owner beforehand (${preset}); its text is in ${EULA_FILE}.`);
    return { accepted: true, how: "preset", source: preset, sha256: textSha };
  }
  if (distro === "ubuntu") {
    print("Microsoft's core fonts for the web come with Microsoft's licence (EULA). Ubuntu's package shows it and asks whether you accept; PairBrowse never answers for you.");
    const a = await ask('Install them now and read the licence there? Type "yes" to go ahead, anything else to skip them: ');
    return /^yes$/i.test(String(a ?? "").trim()) ? { accepted: true, how: "package" } : { accepted: false, how: a == null ? "no answer" : "declined" };
  }
  print("Microsoft's core fonts for the web (Arial, Courier New, Times New Roman, Verdana, Georgia, Trebuchet MS, Comic Sans MS, Impact, Andale Mono, Webdings) are free to use under Microsoft's licence, shown here in full:");
  print("");
  print(text.trimEnd());
  print("");
  const a = await ask('Type "yes" to accept Microsoft\'s licence and install these fonts, anything else to skip them: ');
  if (!/^yes$/i.test(String(a ?? "").trim())) return { accepted: false, how: a == null ? "no answer" : "declined" };
  return { accepted: true, how: "typed", sha256: textSha };
}

// The font set's state, for check and install: { distro, os, plan, installed (Set), missing,
// core: { installed, candidate }, selawik, standInsMissing (STAND_IN_FONTS dirs not in place), standIns, conf (fontconf.mjs fontSource's kind),
// groups (winfonts.mjs fontGroups, or null), lacking (where no apt installs them: the
// FREE_FAMILIES this computer's own font configuration lacks; null with apt) }.
export function fontState({ deps, config }) {
  const os = parseOsRelease(deps.readOs());
  const distro = distroOf(os);
  const plan = distro ? PACKAGES[distro] : null;
  const wanted = plan ? [...freePackages(plan), ...(plan.core ? [plan.core] : [])] : [];
  let installed = new Set();
  let core = { installed: false, candidate: null };
  if (plan?.manager === "apt") {
    const q = deps.run("dpkg-query", ["-W", "-f=${Package} ${db:Status-Abbrev}\n", ...wanted], { encoding: "utf8", timeout: QUERY_MS });
    installed = parseDpkgStatus(q?.stdout);
    const policy = deps.run("apt-cache", ["policy", plan.core], { encoding: "utf8", timeout: QUERY_MS });
    core = { installed: installed.has(plan.core), candidate: parseCandidate(policy?.stdout) };
  }
  const missing = plan ? freePackages(plan).filter((p) => !installed.has(p)) : [];
  const src = fontSource(config, { exec: deps.exec, platform: deps.platform });
  const entries = src ? readFontFamilies({ run: deps.run, env: src.env }) : null;
  // The system's configuration, not the browser's: with the stand-ins off PairBrowse's file
  // keeps Carlito and Caladea from the browser, installed or not.
  const lacking = plan?.manager === "apt" ? null : freeFamiliesLacking(readFontFamilies({ run: deps.run }));
  return { os, distro, plan, installed, missing, core, selawik: selawikInstalled(join(deps.fontsDir, SELAWIK_DIR)), standInsMissing: standInsMissing(deps.fontsDir), standIns: fontStandInsOf(config),
    conf: src?.conf ?? null, groups: entries ? fontGroups(fontStatus(entries, { standIns: src.standIns })) : null, lacking };
}

// What check prints.
export function stateLines(s) {
  const out = [`Distribution: ${s.os.name || s.os.id || "unknown"}${s.distro ? "" : " (not one this setup installs for: docs/server.md lists the packages)"}`];
  if (s.plan?.manager === "apt") {
    out.push(s.missing.length ? `Packages missing: ${s.missing.join(" ")}` : "Packages: emoji and CJK installed");
    out.push(s.core.installed ? "Microsoft's core fonts: installed (the distribution's package)" : s.core.candidate ? "Microsoft's core fonts: not installed (install asks you about Microsoft's licence first)"
      : `Microsoft's core fonts: not installed; their package is in ${s.plan.component}, which this computer's package sources don't include (docs/server.md)`);
  } else if (s.plan) {
    out.push(`Packages to install with ${s.plan.manager}: ${freePackages(s.plan).join(" ")} (${MANAGER_COMMAND[s.plan.manager]} ...)`);
    out.push("Microsoft's core fonts: not in this distribution's own repositories (PairBrowse never takes them from elsewhere)");
  }
  if (s.lacking) out.push(s.lacking.length ? `Fonts missing: ${s.lacking.join(", ")}` : "Fonts: emoji and CJK installed");
  out.push(s.selawik ? `Selawik ${SELAWIK.version}: installed (Microsoft's release, pinned)` : "Selawik: not installed (install takes it from Microsoft's release)");
  out.push(s.standInsMissing.length ? `Open stand-ins: not installed: ${s.standInsMissing.join(", ")} (install takes them from their publishers, pinned)` : "Open stand-ins: installed (pinned from their publishers, unchanged)");
  out.push(`Stand-ins (pairbrowse.fontStandIns): ${s.standIns ? "on" : "off"}; the browser reads its fonts through ${{ pairbrowse: "PairBrowse's font configuration", build: "the build's own font configuration (run install to use the computer's fonts)", system: "this computer's font configuration" }[s.conf] || "nothing checked here"}`);
  out.push(fontGroupsLine(s.groups));
  return out;
}

const apt = (deps, args) => deps.interactive("sudo", ["apt-get", ...args]);

// Ubuntu's package asks its EULA question through debconf: the owner's preset acceptance is
// given to debconf beforehand, the distribution's own way for an unattended install, so the
// package installs without a terminal. Never without the preset (deps.preseed runs it with sudo).
export const UBUNTU_EULA_PRESEED = `${CORE_PACKAGE} msttcorefonts/accepted-mscorefonts-eula select true\n`;
export const EULA_FLAG = "--accept-ms-corefonts-eula";
export const EULA_CONFIG_KEY = "server.acceptMsCoreFontsEula";
// Where the owner accepted the licence beforehand, or null: config.json's server block or the flag.
export function eulaPreset(config, argv = []) {
  if (argv.includes(EULA_FLAG)) return `the ${EULA_FLAG} flag`;
  if (config?.server?.acceptMsCoreFontsEula === true) return `${EULA_CONFIG_KEY} in config.json`;
  return null;
}

// install: the packages (apt with sudo, interactive: apt's own confirmation, and on Ubuntu the
// core fonts package's EULA question, go to the person), Selawik, the setup's record and the
// browser's font configuration. Answers the exit code (0: the set is in place; 1: a part is not).
async function install({ deps, config, print, preset = null }) {
  if (deps.uid === 0) {
    print("Run this as the user PairBrowse runs as, not as root: it asks sudo for the packages and keeps its fonts in that user's ~/.pairbrowse.");
    return 2;
  }
  let s = fontState({ deps, config });
  let ok = true;
  const record = readSetup(deps.record) || {};
  if (s.plan?.manager === "apt") {
    if (!deps.hasSudo) {
      const all = [...s.missing, ...(s.core.installed ? [] : [s.plan.core])];
      if (all.length) { print(`sudo isn't installed: as root, run apt-get install --no-install-recommends ${all.join(" ")}, then this again.`); ok = false; }
    } else {
      if (s.missing.length) {
        print(`Installing ${s.missing.join(" ")} (the distribution's packages)...`);
        if (apt(deps, ["update"]) !== 0 || apt(deps, ["install", "--no-install-recommends", ...s.missing]) !== 0) { print("apt-get didn't finish: the packages above are still missing."); ok = false; }
      }
      if (!s.core.installed) {
        if (!s.core.candidate) {
          print(s.distro === "ubuntu" ? `Microsoft's core fonts are in Ubuntu's multiverse, which this computer's package sources don't include: run sudo add-apt-repository multiverse, then this again.`
            : `Microsoft's core fonts are in Debian's contrib section, which this computer's package sources don't include: add contrib to the Components of your Debian entries (/etc/apt/sources.list.d/debian.sources, or the lines in /etc/apt/sources.list), run sudo apt-get update, then this again.`);
        } else {
          const answer = await eulaAnswer({ distro: s.distro, ask: deps.ask, print, record, preset });
          if (!answer.accepted) print(`Microsoft's core fonts: skipped (${answer.how === "no answer" ? `nobody answered: run this in a terminal to read and accept the licence, or, on a server set up without one, record your acceptance as ${EULA_CONFIG_KEY} in config.json (docs/server.md)` : "not accepted"}).`);
          else {
            let preseeded = true;
            if (answer.how === "preset" && s.distro === "ubuntu") {
              preseeded = deps.preseed(UBUNTU_EULA_PRESEED) === 0;
              if (!preseeded) { print("debconf didn't take the owner's acceptance (sudo debconf-set-selections): the package would ask in a terminal, so it is skipped."); ok = false; }
            }
            const status = preseeded ? apt(deps, ["install", "--no-install-recommends", s.plan.core]) : null;
            if (status !== 0) { if (preseeded) { print("The core fonts package didn't install (declined in its own question, or apt-get stopped): they stay absent."); ok = false; } }
            else if (answer.how !== "recorded") record.coreFonts = { eula: { acceptedAt: new Date(deps.now()).toISOString(), how: answer.how, ...(answer.source ? { source: answer.source } : {}), sha256: sha256(readFileSync(EULA_FILE, "utf8")), user: deps.user } };
          }
        }
      }
    }
  } else if (s.plan) {
    print(`On this distribution install the packages yourself: ${MANAGER_COMMAND[s.plan.manager]} ${freePackages(s.plan).join(" ")}`);
    print("Microsoft's core fonts are not in its own repositories; PairBrowse never takes them from elsewhere.");
  } else print("This distribution isn't one the setup installs packages for: docs/server.md lists what to install.");

  const selawikDir = join(deps.fontsDir, SELAWIK_DIR);
  try {
    const r = await deps.installSelawik({ dir: selawikDir });
    print(r.installed ? `Selawik ${SELAWIK.version} installed from Microsoft's release (pinned, unchanged).` : `Selawik ${SELAWIK.version}: already installed.`);
    deps.run("fc-cache", [selawikDir], { timeout: FC_CACHE_MS, stdio: "ignore" });
  } catch (e) {
    print(`Selawik couldn't be installed: ${e?.message || e}`);
    ok = false;
  }
  const standIns = await deps.installStandIns({ fontsDir: deps.fontsDir });
  if (standIns.installed.length) print(`Open stand-ins installed from their publishers (pinned, unchanged): ${standIns.installed.join(", ")}.`);
  for (const f of standIns.failed) { print(`The open stand-in ${f.dir} couldn't be installed: ${f.error}`); ok = false; }
  for (const pin of STAND_IN_FONTS) if (!standIns.failed.some((f) => f.dir === pin.dir)) deps.run("fc-cache", [join(deps.fontsDir, pin.dir)], { timeout: FC_CACHE_MS, stdio: "ignore" });
  writeJsonAtomic(deps.record, { ...record, version: 1, at: new Date(deps.now()).toISOString(), distro: s.distro, selawik: selawikInstalled(selawikDir) ? SELAWIK.version : null, standInFonts: STAND_IN_FONTS.map((p) => p.dir).filter((d) => !standInsMissing(deps.fontsDir).includes(d)) }, { mode: 0o600 });
  writeFontsConf({ on: fontStandInsOf(config), file: deps.conf, fontsDir: deps.fontsDir, executablePath: deps.exec });
  print(`The browser's font configuration is in place (pairbrowse.fontStandIns ${fontStandInsOf(config) ? "on" : "off"}); it applies at the browser's next start.`);
  s = fontState({ deps, config });
  for (const l of stateLines(s)) print(l);
  // Where the packages are the person's to install: in place only once fontconfig lists their fonts.
  if (s.lacking?.length) { print("Fonts the browser needs are still missing (listed above): install them, then run this again."); ok = false; }
  return ok ? 0 : 1;
}

export const USAGE = `Usage: node scripts/native/fontsetup.mjs [check|install [${EULA_FLAG}]]`;

// The person's terminal: one line, or null when stdin isn't one or closes first.
function askTerminal(question) {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((done) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.on("close", () => { if (!answered) done(null); });
    rl.question(question, (a) => { answered = true; rl.close(); done(a); });
  });
}

export function defaultDeps() {
  const which = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
  return {
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    user: userInfo().username,
    hasSudo: which("sudo"),
    readOs: () => { try { return readFileSync("/etc/os-release", "utf8"); } catch { return ""; } },
    run: spawnSync,
    // apt's prompts and the package's questions go to the person's terminal; DEBIAN_FRONTEND is
    // left out so a noninteractive setting in this shell can't answer the EULA question for them.
    // The owner's preset acceptance, given to debconf before the package asks (Ubuntu).
    preseed: (selections) => spawnSync("sudo", ["debconf-set-selections"], { input: selections, stdio: ["pipe", "inherit", "inherit"] }).status,
    interactive: (cmd, args) => {
      const env = { ...process.env };
      delete env.DEBIAN_FRONTEND;
      return spawnSync(cmd, args, { stdio: "inherit", env }).status;
    },
    ask: askTerminal,
    installSelawik,
    installStandIns,
    now: Date.now,
    exec: null,
    fontsDir: paths.fonts,
    record: paths.fontsSetup,
    conf: paths.fontsConf,
  };
}

export async function runFontSetup(argv, { deps = defaultDeps(), config = readJson(paths.config, {}), print = (l) => process.stdout.write(`${l}\n`) } = {}) {
  const [command = "check", ...rest] = argv;
  const flags = rest.filter((a) => a === EULA_FLAG);
  if (rest.length !== flags.length || !["check", "install"].includes(command) || (flags.length && command !== "install")) { print(USAGE); return 2; }
  if (deps.platform !== "linux") { print("The font setup is for a Linux server (docs/server.md); this computer's own fonts are what its browser uses."); return command === "check" ? 0 : 2; }
  if (command === "check") { for (const l of stateLines(fontState({ deps, config }))) print(l); return 0; }
  return install({ deps, config, print, preset: eulaPreset(config, rest) });
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // The native build in use, so check reads the fonts through the configuration the browser does.
  const deps = defaultDeps();
  deps.exec = await import("./install.mjs").then((m) => m.nativeDirs().exec, () => null);
  runFontSetup(process.argv.slice(2), { deps }).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e?.message || e}\n`); process.exitCode = 1; });
}
