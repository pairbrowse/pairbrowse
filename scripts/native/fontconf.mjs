// PairBrowse's own font configuration for the browser on Linux (server-mode spec step 52, decision
// 11's free-fonts and alias routes). The native Linux build brings a font configuration of its own
// (the engine pack points FONTCONFIG_FILE at fonts.generated.conf beside the binary): self-contained,
// it never reads the computer's /etc/fonts, so fonts the server setup installs from the
// distribution (Microsoft's core fonts, colour emoji, CJK) would never reach a page, and its
// bundled clones always stand in for the Windows names. Once the server setup has run
// (native/fontsetup.mjs; its record is paths.fontsSetup), every Linux launch of the native build
// gets this file instead (native-engine.mjs launchNative, the caller's env winning over the
// pack's): the computer's own configuration and fonts, and, only while pairbrowse.fontStandIns is
// on, the open stand-ins (winfonts.mjs STAND_INS) under the Windows names: Selawik from the
// setup's own folder (Microsoft's release, pinned), Carlito and Caladea from the distribution's
// packages. While it is off (the default until the measurement decides) the switched stand-ins
// are kept from the browser altogether, so a width check finds no Windows name there: what is
// left is the free fonts alone. The fonts keep their own names and files; only fontconfig's
// matching changes, and only for the browser. Before the setup has run, the build's own
// configuration stays as it is. Node's standard library only.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "../paths.mjs";
import { readJson } from "../util.mjs";
import { STAND_INS, SWITCHED_STAND_INS, fontGroups, fontStatus, readFontFamiliesAsync } from "./winfonts.mjs";

// The computer's own fontconfig configuration (its fonts, folders, cache and metric aliases).
export const SYSTEM_CONF = "/etc/fonts/fonts.conf";
// The folder in the setup's font folder that holds Selawik (fontsetup.mjs SELAWIK).
export const SELAWIK_DIR = "selawik";

// config.json's pairbrowse.fontStandIns: true only when set to true (default false).
export const fontStandInsOf = (config) => config?.pairbrowse?.fontStandIns === true;

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const family = (name) => `<family>${xml(name)}</family>`;

// The file's text: on (pairbrowse.fontStandIns), the stand-ins' folders (dirs: Selawik's) and
// one alias per Windows name (accept: after the family itself, so a real font of that name always
// wins; binding "same", as fontconfig's own metric aliases); off, the switched stand-ins (never
// Liberation, the system's own alias) rejected, so the browser lists none of them.
export function fontsConf({ on = false, base = SYSTEM_CONF, dirs = [] } = {}) {
  const lines = [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
    `<!-- PairBrowse's font configuration for its browser (written at each start; edit pairbrowse.fontStandIns in config.json instead). Stand-ins: ${on ? "on" : "off"}. -->`,
    "<fontconfig>",
    `  <include ignore_missing="yes">${xml(base)}</include>`,
  ];
  if (on) {
    for (const d of dirs) lines.push(`  <dir>${xml(d)}</dir>`);
    for (const s of STAND_INS) lines.push(`  <alias binding="same">${family(s.family)}<accept>${family(s.standIn)}</accept></alias>`);
  } else {
    lines.push("  <selectfont><rejectfont>");
    for (const name of SWITCHED_STAND_INS) lines.push(`    <pattern><patelt name="family"><string>${xml(name)}</string></patelt></pattern>`);
    lines.push("  </rejectfont></selectfont>");
  }
  lines.push("</fontconfig>", "");
  return lines.join("\n");
}

// Whether the server setup has run in this install (its record is there).
export const setupDone = (record = paths.fontsSetup) => existsSync(record);

// Writes the browser's file (paths.fontsConf) when its text changed, atomically (a browser
// starting at the same moment reads the old file or the new one, never half of one). Answers its path.
export function writeFontsConf({ on = false, file = paths.fontsConf, fontsDir = paths.fonts } = {}) {
  const text = fontsConf({ on, dirs: [join(fontsDir, SELAWIK_DIR)] });
  let now = null;
  try { now = readFileSync(file, "utf8"); } catch {}
  if (now !== text) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, text, { mode: 0o600 });
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }
  return file;
}

// The environment a native launch on Linux adds for its fonts: { FONTCONFIG_FILE } (this file,
// written for the switch now) once the setup has run; null otherwise, and off Linux, so the
// build's own configuration applies. Never throws: a file that can't be written leaves the
// build's (log says so).
export function browserFontEnv(config, { platform = process.platform, record = paths.fontsSetup, file = paths.fontsConf, fontsDir = paths.fonts, log = () => {} } = {}) {
  if (platform !== "linux" || !setupDone(record)) return null;
  try {
    return { FONTCONFIG_FILE: writeFontsConf({ on: fontStandInsOf(config), file, fontsDir }) };
  } catch (e) {
    log(`fonts: the browser's font configuration couldn't be written (${e?.code || e?.message || e}); the build's own applies`);
    return null;
  }
}

// The configuration the browser reads its fonts through, for a report: "pairbrowse" (this
// file, the setup has run), "build" (the native build's own: its clones always stand in) or
// "system"; with the env that makes fc-list read the same, and whether stand-ins apply. native:
// whether the browser in use is the native build; only its launch is given this file
// (native-engine.mjs launchEnv), so the open build reads the system's configuration, whose own
// metric aliases (30-metric-aliases.conf) point Calibri and Cambria at Carlito and Caladea
// whatever pairbrowse.fontStandIns says: they stand in there.
export function fontSource(config, { exec = null, native = true, platform = process.platform, record = paths.fontsSetup, file = paths.fontsConf, exists = existsSync } = {}) {
  if (platform !== "linux") return null;
  if (!native) return { conf: "system", env: process.env, standIns: true };
  if (exists(record) && exists(file)) return { conf: "pairbrowse", env: { ...process.env, FONTCONFIG_FILE: file }, standIns: fontStandInsOf(config) };
  const built = exec ? join(dirname(exec), "fonts", "fonts.generated.conf") : null;
  if (built && exists(built)) return { conf: "build", env: { ...process.env, FONTCONFIG_FILE: built }, standIns: true };
  return { conf: "system", env: process.env, standIns: false };
}

// The Windows fonts as the browser finds them (diagnostics, Settings): { conf, standIns,
// present, standingIn, absent } (winfonts.mjs fontGroups), or null off Linux or when fc-list
// can't be asked. read: readFontFamiliesAsync's stand-in for tests.
export async function fontsReport({ config = readJson(paths.config, {}), exec = null, native = true, platform = process.platform, read = readFontFamiliesAsync, ...where } = {}) {
  const src = fontSource(config, { exec, native, platform, ...where });
  if (!src) return null;
  const entries = await read({ env: src.env });
  if (!entries) return null;
  return { conf: src.conf, standIns: src.standIns, ...fontGroups(fontStatus(entries, { standIns: src.standIns })) };
}

// The setup's record (fontsetup.mjs), or null.
export const readSetup = (record = paths.fontsSetup) => readJson(record, null);
