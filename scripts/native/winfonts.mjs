// The Windows fonts a Linux host without a GPU lacks under the Windows identity it shows
// (server-mode spec decision 11, 2026-10-22): the eight families font checks on a Windows
// persona look for first (the reference's own minimum set), which no free package carries.
// PairBrowse never downloads or ships them; the server setup (docs/server.md) names the ones
// missing and what the person may do about them (a licensed Windows of their own carries them).
// This reads fontconfig's own list (fc-list, the one program on a Linux desktop that knows every
// font the browser can reach) and names the families among the eight it doesn't list. Pure parts
// apart from readFontFamilies; Node's standard library only.
import { spawnSync } from "node:child_process";

// The eight families, as a Windows machine names them (a style of Segoe UI counts as a family of
// its own on Windows, so "Segoe UI Light" is looked for as a name or as Segoe UI's Light style).
export const WINDOWS_FONTS = Object.freeze(["Segoe UI", "Segoe UI Light", "Calibri", "Marlett", "MS UI Gothic", "Franklin Gothic", "Consolas", "Courier New"]);
const FC_LIST_MS = 10_000;
// Families Windows carries under a longer name only (Franklin Gothic Medium): a name that starts
// with the family counts; for every other family only the name itself does (Segoe UI Symbol and
// Segoe UI Emoji are not Segoe UI).
const LONGER_NAMES = new Set(["franklin gothic"]);

// fontconfig's families as "family[,family...]:style=..." lines (fc-list : family style), parsed
// to [{ families: [lower-cased names], styles: [lower-cased names] }].
export function parseFontList(text) {
  const out = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(":style=");
    const familyPart = at < 0 ? line : line.slice(0, at);
    const stylePart = at < 0 ? "" : line.slice(at + 7);
    const families = familyPart.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const styles = stylePart.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (families.length) out.push({ families, styles });
  }
  return out;
}

// Whether a family of WINDOWS_FONTS is among the parsed entries: by name, by a name that starts
// with it where Windows names it longer ("Franklin Gothic Medium" for Franklin Gothic), or, for
// a styled name, as the base family in that style ("Segoe UI" with style "Light").
function listed(entries, name) {
  const want = name.toLowerCase();
  if (entries.some((e) => e.families.some((f) => f === want || (LONGER_NAMES.has(want) && f.startsWith(`${want} `))))) return true;
  const space = want.lastIndexOf(" ");
  if (space < 0) return false;
  const base = want.slice(0, space), style = want.slice(space + 1);
  return entries.some((e) => e.families.includes(base) && e.styles.some((s) => s.split(/\s+/).includes(style)));
}

// The families of WINDOWS_FONTS fontconfig's list doesn't carry, in WINDOWS_FONTS' order.
export const missingWindowsFonts = (entries) => WINDOWS_FONTS.filter((name) => !listed(entries, name));

// fontconfig's list on this computer: the parsed entries, or null when fc-list isn't there or
// doesn't answer in time. run: spawnSync's stand-in for tests.
export function readFontFamilies({ run = spawnSync } = {}) {
  try {
    const r = run("fc-list", [":", "family", "style"], { encoding: "utf8", timeout: FC_LIST_MS, stdio: ["ignore", "pipe", "ignore"] });
    if (!r || r.error || r.status !== 0 || typeof r.stdout !== "string") return null;
    return parseFontList(r.stdout);
  } catch { return null; }
}

// The install check's line (and the helper log's): which of the eight are missing, or that all
// are there, or that fontconfig couldn't be asked. entries: readFontFamilies' answer.
export function windowsFontsLine(entries) {
  if (!entries) return "Windows fonts: not checked (fc-list is not installed)";
  const missing = missingWindowsFonts(entries);
  if (!missing.length) return "Windows fonts: all eight found";
  return `Windows fonts missing: ${missing.join(", ")} (not provided by PairBrowse; a licensed Windows of your own carries them: docs/server.md)`;
}
