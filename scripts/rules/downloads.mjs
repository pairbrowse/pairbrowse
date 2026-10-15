// Where downloads (and recordings) may go, checked when the folder is chosen in Settings, when
// config.json is read (a hand-edited value gets the same check) and again at every save: the folder
// is resolved to its real path each time, so a folder that was later replaced by a link (into
// ~/Library/LaunchAgents, say) is never written to. Pure, standard library only.
import { statSync, realpathSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// A folder that exists (stat follows links). The real folder, or null.
export const folderOf = (p) => { try { return statSync(p).isDirectory() ? realpathSync(p) : null; } catch { return null; } };

// Inside the helper's own home (~/.pairbrowse: the profile, secrets, keys): never a downloads folder,
// so a site's file can't land beside them.
export const inHelperHome = (real, home) => { const h = folderOf(home) || resolve(home); return real === h || real.startsWith(h + sep); };

// Where downloads may go: an ordinary folder inside your home folder, never the home folder itself
// (where a file named like a shell's startup file would be read), never inside a hidden folder (.ssh,
// .config, ...: settings and keys) or the folders apps and the system read from (macOS ~/Library:
// LaunchAgents among them; Windows AppData). user: your home folder. A reason, or "" when it may.
const SYSTEM_DIRS = ["Library", "AppData", "Applications"];
export function downloadsProblem(real, user = homedir()) {
  const h = folderOf(user) || resolve(user);
  if (real === h) return "Downloads can't go straight into your home folder: choose a folder in it.";
  const rel = relative(h, real);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return "Downloads go to a folder inside your home folder.";
  const parts = rel.split(sep);
  if (parts.some((p) => p.startsWith("."))) return "Downloads can't go into a hidden folder (its name starts with a dot).";
  if (SYSTEM_DIRS.some((d) => parts[0].toLowerCase() === d.toLowerCase())) return `Downloads can't go into ~${sep}${parts[0]} (apps and the system read from it).`;
  return "";
}

// A chosen downloads folder (a path as written): its real folder when it may hold downloads, else
// { problem }. home: the helper's home. folder: folderOf (a stand-in in tests).
export function checkDownloads(path, { home, user = homedir(), folder = folderOf } = {}) {
  if (typeof path !== "string" || !isAbsolute(path)) return { problem: "downloads is an absolute path to a folder." };
  const real = folder(path);
  if (!real) return { problem: `${path} isn't a folder` };
  if (home && inHelperHome(real, home)) return { problem: "Downloads can't go inside PairBrowse's own folder (~/.pairbrowse)." };
  const why = downloadsProblem(real, user);
  return why ? { problem: why } : { real };
}

// The real folder a save goes to now: the chosen one when it still passes checkDownloads, else your
// Downloads folder (made when missing) when that passes; { dir, problem? } (problem: why the chosen
// one wasn't used), or { dir: null, problem } when neither may be written to.
export function downloadsFolderNow(chosen, { home, user = homedir(), folder = folderOf, mkdir = mkdirSync } = {}) {
  let problem = "";
  if (typeof chosen === "string" && chosen) {
    const c = checkDownloads(chosen, { home, user, folder });
    if (c.real) return { dir: c.real };
    problem = `${chosen}: ${c.problem}`;
  }
  const fallback = join(user, "Downloads");
  try { if (!folder(fallback)) mkdir(fallback); } catch {}
  const d = checkDownloads(fallback, { home, user, folder });
  if (d.real) return problem ? { dir: d.real, problem } : { dir: d.real };
  return { dir: null, problem: [problem, `${fallback}: ${d.problem}`].filter(Boolean).join("; ") };
}
