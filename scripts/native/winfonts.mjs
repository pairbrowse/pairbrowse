// The Windows fonts a Linux host without a GPU lacks under the Windows identity it shows
// (server-mode spec decision 11, 2026-10-22): the eight families font checks on a Windows
// persona look for first (the reference's own minimum set), which no free package carries.
// PairBrowse never downloads or ships them; the server setup (docs/server.md, native/fontsetup.mjs)
// installs only free fonts: Microsoft's core fonts for the web through the distribution's own
// package, and the open metric-compatible stand-ins (STAND_INS) that the alias file
// (native/fontconf.mjs, pairbrowse.fontStandIns) points the Windows names at. This reads
// fontconfig's own list (fc-list, the one program on a Linux desktop that knows every font the
// browser can reach) and says, per Windows family, whether it is present, standing in or absent.
// Pure parts apart from readFontFamilies and readFontFamiliesAsync; Node's standard library only.
import { execFile, spawnSync } from "node:child_process";

// The eight families, as a Windows machine names them (a style of Segoe UI counts as a family of
// its own on Windows, so "Segoe UI Light" is looked for as a name or as Segoe UI's Light style).
export const WINDOWS_FONTS = Object.freeze(["Segoe UI", "Segoe UI Light", "Calibri", "Marlett", "MS UI Gothic", "Franklin Gothic", "Consolas", "Courier New"]);
const FC_LIST_MS = 10_000;
// Families Windows carries under a longer name only (Franklin Gothic Medium): a name that starts
// with the family counts; for every other family only the name itself does (Segoe UI Symbol and
// Segoe UI Emoji are not Segoe UI).
const LONGER_NAMES = new Set(["franklin gothic"]);

// The Windows families a report lists (diagnostics, Settings, the setup's check): the eight
// above, Cambria (Office's serif, Caladea's), the Segoe UI weights Selawik has, and Microsoft's
// core fonts for the web (the distribution's package: ttf-mscorefonts-installer on Debian and
// Ubuntu), in that order.
export const REPORT_FONTS = Object.freeze([...WINDOWS_FONTS, "Segoe UI Semilight", "Segoe UI Semibold", "Cambria",
  "Arial", "Times New Roman", "Verdana", "Georgia", "Trebuchet MS", "Comic Sans MS", "Impact", "Andale Mono", "Webdings"]);

// The open stand-ins for Windows-only names (spec decision 11, second route): each keeps its own
// name and licence (never renamed or modified); only fontconfig's matching points the Windows name
// at it, through PairBrowse's alias file while pairbrowse.fontStandIns is on. Selawik is
// Microsoft's own OFL 1.1 stand-in for Segoe UI (close, not exact: its kerning differs), Carlito
// and Caladea are metric-compatible with Calibri and Cambria (OFL 1.1), Liberation with Arial,
// Times New Roman and Courier New (OFL 1.1). system: fontconfig's own metric aliases
// (30-metric-aliases.conf) already point the name there, whatever the switch says, so the
// alias file never rejects it (Liberation has been part of the server's font set all along).
export const STAND_INS = Object.freeze([
  { family: "Segoe UI", standIn: "Selawik" },
  { family: "Segoe UI Light", standIn: "Selawik Light" },
  { family: "Segoe UI Semilight", standIn: "Selawik Semilight" },
  { family: "Segoe UI Semibold", standIn: "Selawik Semibold" },
  { family: "Calibri", standIn: "Carlito" },
  { family: "Cambria", standIn: "Caladea" },
  { family: "Arial", standIn: "Liberation Sans", system: true },
  { family: "Times New Roman", standIn: "Liberation Serif", system: true },
  { family: "Courier New", standIn: "Liberation Mono", system: true },
].map(Object.freeze));
// The stand-in families the alias file keeps from the browser while the switch is off.
export const SWITCHED_STAND_INS = Object.freeze([...new Set(STAND_INS.filter((s) => !s.system).map((s) => s.standIn))]);

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

// Per family of families (REPORT_FONTS by default): { family, status, by? }. status "present" (the
// font itself is listed), "standing-in" (absent, and its open stand-in is listed where the
// browser looks it up: by is that family) or "absent". standIns: pairbrowse.fontStandIns, which
// points the Windows names at the switched stand-ins (the alias file); the system's own aliases
// (Liberation) stand in whatever it says.
export function fontStatus(entries, { standIns = false, families = REPORT_FONTS } = {}) {
  return families.map((family) => {
    if (listed(entries, family)) return { family, status: "present" };
    const s = STAND_INS.find((x) => x.family === family);
    if (s && (standIns || s.system) && listed(entries, s.standIn)) return { family, status: "standing-in", by: s.standIn };
    return { family, status: "absent" };
  });
}

// What a report shows of fontStatus's answer: { present: [names], standingIn: [{ family, by }],
// absent: [names] }.
export function fontGroups(statuses) {
  return {
    present: statuses.filter((s) => s.status === "present").map((s) => s.family),
    standingIn: statuses.filter((s) => s.status === "standing-in").map((s) => ({ family: s.family, by: s.by })),
    absent: statuses.filter((s) => s.status === "absent").map((s) => s.family),
  };
}

// One line of fontGroups' answer for diagnostics and the setup's check: "Windows fonts: present
// Arial, ...; standing in Calibri (Carlito), ...; absent Segoe UI, ...", each part only when
// it names one; null groups (not Linux, or fontconfig not asked): "Windows fonts: not checked".
export function fontGroupsLine(groups) {
  if (!groups) return "Windows fonts: not checked";
  const parts = [
    groups.present.length ? `present ${groups.present.join(", ")}` : "",
    groups.standingIn.length ? `standing in ${groups.standingIn.map((s) => `${s.family} (${s.by})`).join(", ")}` : "",
    groups.absent.length ? `absent ${groups.absent.join(", ")}` : "",
  ].filter(Boolean);
  return `Windows fonts: ${parts.join("; ") || "none listed"}`;
}

const FC_ARGS = [":", "family", "style"];
// fontconfig's list on this computer: the parsed entries, or null when fc-list isn't there or
// doesn't answer in time. env: the environment fc-list reads its configuration from (the
// browser's: FONTCONFIG_FILE naming PairBrowse's alias file, native/fontconf.mjs fontEnv).
// run: spawnSync's stand-in for tests.
export function readFontFamilies({ run = spawnSync, env } = {}) {
  try {
    const r = run("fc-list", FC_ARGS, { encoding: "utf8", timeout: FC_LIST_MS, stdio: ["ignore", "pipe", "ignore"], ...(env ? { env } : {}) });
    if (!r || r.error || r.status !== 0 || typeof r.stdout !== "string") return null;
    return parseFontList(r.stdout);
  } catch { return null; }
}

// The same without blocking (the helper's diagnostics): resolves the entries or null.
// run: execFile's stand-in for tests.
export function readFontFamiliesAsync({ run = execFile, env } = {}) {
  return new Promise((resolve) => {
    try {
      run("fc-list", FC_ARGS, { encoding: "utf8", timeout: FC_LIST_MS, maxBuffer: 16 << 20, ...(env ? { env } : {}) }, (error, stdout) => {
        resolve(error || typeof stdout !== "string" ? null : parseFontList(stdout));
      });
    } catch { resolve(null); }
  });
}

// The install check's line (and the helper log's): the eight as found, standing in or missing,
// or that fontconfig couldn't be asked. entries: readFontFamilies' answer; standIns: as fontStatus.
export function windowsFontsLine(entries, { standIns = false } = {}) {
  if (!entries) return "Windows fonts: not checked (fc-list is not installed)";
  const { present, standingIn, absent } = fontGroups(fontStatus(entries, { standIns, families: WINDOWS_FONTS }));
  if (present.length === WINDOWS_FONTS.length) return "Windows fonts: all eight found";
  const parts = [`${present.length} of the eight found`];
  if (standingIn.length) parts.push(`standing in: ${standingIn.map((s) => `${s.family} (${s.by})`).join(", ")}`);
  if (absent.length) parts.push(`missing: ${absent.join(", ")} (Microsoft's, not provided by PairBrowse: docs/server.md)`);
  return `Windows fonts: ${parts.join("; ")}`;
}
