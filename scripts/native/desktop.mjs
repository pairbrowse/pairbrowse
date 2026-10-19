// The Linux desktop entry and icons for an installed native build, so the desktop gives its window
// (WM class "Pairbrowse", app id "pairbrowse" on Wayland) its name and icon. The build ships them in
// PairBrowse-Desktop/ next to its program; the install step (native/install.mjs) writes the entry
// itself, from fields it controls (the archive's own entry is never copied: its Exec isn't ours),
// with Exec the installed program's absolute path, and copies the icons into the hicolor theme.
// Destinations: $XDG_DATA_HOME (else ~/.local/share)/applications/<id>.desktop and
// icons/hicolor/<size>/apps/pairbrowse.(png|svg). Each file is written through a new file
// (O_EXCL, so a symlink there is never followed) and a rename; a symlinked folder below the data
// home is refused. One entry per install: the default shared home's is pairbrowse.desktop, another
// home's (PAIRBROWSE_HOME) has a name of its own, so two installs never overwrite each other.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { defaultHome } from "../home.mjs";
import { sha256 } from "../util.mjs";

export const DESKTOP_FOLDER = "PairBrowse-Desktop";
export const WM_CLASS = "Pairbrowse";
const ICON = "pairbrowse";
const MAX_ICON_BYTES = 4 << 20;

// The data home per the XDG base directory spec: $XDG_DATA_HOME when it's an absolute path.
export function dataHome(env = process.env, account = homedir()) {
  const x = env.XDG_DATA_HOME;
  return typeof x === "string" && isAbsolute(x) ? x : join(account, ".local", "share");
}

// The entry's id for the install whose browser folder is browserDir: "pairbrowse" for the default
// shared home's, "pairbrowse-<8 hex>" (from the folder) for any other.
export function desktopId(browserDir, defaultDir = join(defaultHome(), "browser")) {
  return browserDir === defaultDir ? ICON : `${ICON}-${sha256(browserDir).slice(0, 8)}`;
}

// An Exec program path, quoted per the desktop entry spec: inside double quotes, " ` $ \ take a
// backslash; then the string value's own escape doubles each backslash; % is written %%.
// A path with a control character can't be written and throws.
export function quoteExec(path) {
  if (typeof path !== "string" || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error("the program's path can't go in a desktop entry");
  const quoted = `"${path.replace(/["`$\\]/g, (c) => `\\${c}`)}"`;
  return quoted.replace(/\\/g, "\\\\").replace(/%/g, "%%");
}

// The entry's text. label: shown after the name for an install other than the default one.
export function desktopEntry(exec, { label = "" } = {}) {
  const suffix = String(label).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);
  return [
    "[Desktop Entry]",
    "Version=1.0",
    "Type=Application",
    `Name=PairBrowse${suffix ? ` (${suffix})` : ""}`,
    "GenericName=Web Browser",
    "Comment=The browser you and your agent use together",
    `Exec=${quoteExec(exec)} %U`,
    `Icon=${ICON}`,
    "Terminal=false",
    "StartupNotify=true",
    `StartupWMClass=${WM_CLASS}`,
    "Categories=Network;WebBrowser;",
    "",
  ].join("\n");
}

// A folder below base, made where missing; a symlink on the way is refused.
function ownDir(base, ...parts) {
  mkdirSync(base, { recursive: true });
  let dir = base;
  for (const part of parts) {
    dir = join(dir, part);
    let st = null;
    try { st = lstatSync(dir); } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (!st) mkdirSync(dir);
    else if (!st.isDirectory()) throw new Error(`${dir} isn't a folder`);
  }
  return dir;
}

// Writes data at dir/name through a new file and a rename (the rename replaces a symlink there,
// never follows it).
function writeAtomic(dir, name, data) {
  const tmp = join(dir, `.${name}.${process.pid}.tmp`);
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, data, { flag: "wx" });
    renameSync(tmp, join(dir, name));
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

// The icons a build ships: [size folder, file name, source path], regular files only.
function shippedIcons(app) {
  const root = join(app, DESKTOP_FOLDER, "icons", "hicolor");
  const icons = [];
  let sizes;
  try { sizes = readdirSync(root); } catch { return icons; }
  for (const size of sizes) {
    if (!/^(\d{1,4}x\d{1,4}|scalable)$/.test(size)) continue;
    const file = `${ICON}.${size === "scalable" ? "svg" : "png"}`;
    const src = join(root, size, "apps", file);
    try {
      const st = lstatSync(src);
      if (st.isFile() && st.size <= MAX_ICON_BYTES) icons.push([size, file, src]);
    } catch {}
  }
  return icons;
}

// Installs the desktop entry and icons for the build installed at app (exec: its program). Returns
// the entry's path, or null when the build ships no desktop entry (an older build). Throws on a
// failed write; the install step logs it and goes on.
export function installDesktop(app, exec, { browserDir, home = dataHome(), defaultDir } = {}) {
  if (!existsSync(join(app, DESKTOP_FOLDER, `${ICON}.desktop`))) return null;
  const id = desktopId(browserDir, defaultDir);
  for (const [size, file, src] of shippedIcons(app)) writeAtomic(ownDir(home, "icons", "hicolor", size, "apps"), file, readFileSync(src));
  const label = id === ICON ? "" : basename(join(browserDir, ".."));
  const dir = ownDir(home, "applications");
  writeAtomic(dir, `${id}.desktop`, desktopEntry(exec, { label }));
  return join(dir, `${id}.desktop`);
}
