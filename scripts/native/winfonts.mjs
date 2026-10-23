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
// above, Cambria (Office's serif, Caladea's), the Segoe UI weights Selawik has, Microsoft's
// core fonts for the web (the distribution's package: ttf-mscorefonts-installer on Debian and
// Ubuntu) and Tahoma (Windows' own, not among them), in that order.
export const REPORT_FONTS = Object.freeze([...WINDOWS_FONTS, "Segoe UI Semilight", "Segoe UI Semibold", "Cambria",
  "Arial", "Times New Roman", "Verdana", "Georgia", "Trebuchet MS", "Comic Sans MS", "Impact", "Andale Mono", "Webdings", "Tahoma"]);

// The open stand-ins for Windows names (spec decision 11, second route): one distinct open family
// per Windows family, so no two Windows names answer with one font and a width check (the width
// of Verdana against Arial's) sees them apart as on Windows. Each keeps its own name and licence
// (never renamed or modified); only fontconfig's matching points the Windows name at it, through
// PairBrowse's alias file while pairbrowse.fontStandIns is on, and after the name itself, so
// Microsoft's own font of that name (the core fonts, where the person accepted their EULA) always
// wins. Selawik is Microsoft's own OFL 1.1 stand-in for Segoe UI (close, not exact: its kerning
// differs); the rest come pinned from their publishers (native/standins.mjs). Measured against
// the Windows fonts' advance widths (docs/server.md, Fonts): Arimo, Tinos, Cousine, Gelasio and
// Comic Relief match Arial, Times New Roman, Courier New, Georgia and Comic Sans MS glyph for
// glyph; Carlito and Caladea are metric-compatible with Calibri and Cambria by design; DejaVu Sans
// is within 3% of Verdana and DejaVu Sans Condensed within 5% of Tahoma on the probe strings; Fira
// Sans was the closest of the open sans families measured for Trebuchet MS (within 3%; Noto Sans
// 4 to 10% wide); Anton within 4% of Impact; Inconsolata, the nearest monospace not already taken
// (Cousine is Courier New's), is 0.5 em a character, narrower than Consolas. systemAlias: the
// family fontconfig's own metric aliases (30-metric-aliases.conf) give the name on any Linux
// desktop, whatever the switch says, so a report counts it standing in with the switch off too
// (Liberation, where the distribution's package is installed). common: a family Linux desktops
// carry for their own text (DejaVu Sans is Debian's default face), never kept from the browser
// with the switch off.
export const STAND_INS = Object.freeze([
  { family: "Segoe UI", standIn: "Selawik" },
  { family: "Segoe UI Light", standIn: "Selawik Light" },
  { family: "Segoe UI Semilight", standIn: "Selawik Semilight" },
  { family: "Segoe UI Semibold", standIn: "Selawik Semibold" },
  { family: "Calibri", standIn: "Carlito" },
  { family: "Cambria", standIn: "Caladea" },
  { family: "Arial", standIn: "Arimo", systemAlias: "Liberation Sans" },
  { family: "Times New Roman", standIn: "Tinos", systemAlias: "Liberation Serif" },
  { family: "Courier New", standIn: "Cousine", systemAlias: "Liberation Mono" },
  { family: "Georgia", standIn: "Gelasio" },
  { family: "Verdana", standIn: "DejaVu Sans", common: true },
  { family: "Tahoma", standIn: "DejaVu Sans Condensed", common: true },
  { family: "Trebuchet MS", standIn: "Fira Sans" },
  { family: "Comic Sans MS", standIn: "Comic Relief" },
  { family: "Impact", standIn: "Anton" },
  { family: "Consolas", standIn: "Inconsolata" },
].map(Object.freeze));
// Names pages use for the same faces as a Windows family (Helvetica for Arial's): the alias file
// answers each with that Windows family first (Microsoft's font where installed), then its
// stand-in, so the two names always measure alike, as on Windows.
export const NAME_ALIASES = Object.freeze([
  { name: "Helvetica", of: "Arial" },
  { name: "Times", of: "Times New Roman" },
  { name: "Courier", of: "Courier New" },
].map(Object.freeze));
// The stand-in families the alias file keeps from the browser while the switch is off.
export const SWITCHED_STAND_INS = Object.freeze([...new Set(STAND_INS.filter((s) => !s.common).map((s) => s.standIn))]);

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
// points the Windows names at their stand-ins (the alias file); the system's own aliases
// (systemAlias: Liberation) stand in whatever it says, after the stand-in where both are listed.
export function fontStatus(entries, { standIns = false, families = REPORT_FONTS } = {}) {
  return families.map((family) => {
    if (listed(entries, family)) return { family, status: "present" };
    const s = STAND_INS.find((x) => x.family === family);
    const by = s && [standIns ? s.standIn : null, s.systemAlias].find((f) => f && listed(entries, f));
    if (by) return { family, status: "standing-in", by };
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
