// Which PairBrowse home this process uses (paths.mjs builds every path from it), with no side
// effects and no other project module, so scripts/open.mjs can choose a home before paths.mjs loads.
//
// One home = one helper = one browser. Several helpers on one computer are named instances:
//   PAIRBROWSE_HOME=<folder>         that folder, as before (wins over everything below)
//   PAIRBROWSE_INSTANCE=<name>       ~/.pairbrowse/instances/<name>
//   .pairbrowse.json {"instance"}    the same, from the project folder Claude Code (or the Claude
//                                    desktop app) runs in: CLAUDE_PROJECT_DIR, else the current
//                                    folder; only that one file, never a parent folder
//   none of these                    ~/.pairbrowse (the default home, as before)
// "default" names the default home. An instance keeps its own profile, sessions, config, secrets,
// facts, runs and logs; the read-only installs (runtime, browser apps, engine pack, cloudflared,
// downloads, this Mac's measured profile) stay in the default home and are shared: `shared`.
import { closeSync, fstatSync, openSync, readSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const INSTANCE_RE = /^[a-z0-9-]{1,32}$/;
export const PROJECT_FILE = ".pairbrowse.json";
const PROJECT_MAX_BYTES = 4096;

// The default home: the account's ~/.pairbrowse ($HOME's, as before).
export const defaultHome = (account = homedir()) => join(account, ".pairbrowse");
export const instanceHome = (name, account = homedir()) => join(defaultHome(account), "instances", name);
export const validInstance = (name) => typeof name === "string" && INSTANCE_RE.test(name);

// The instance a project folder names in .pairbrowse.json: { name } (null: the default home),
// { warning } when the file is there but can't be used, or null when there's none. The file must
// be a regular file (a link is not followed), owned by this account, at most 4 KB, JSON with
// "instance" a valid name or "default".
export function projectInstance(dir, { uid = process.getuid?.() } = {}) {
  if (typeof dir !== "string" || !isAbsolute(dir)) return null;
  const file = join(dir, PROJECT_FILE);
  let fd;
  try { fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)); } catch (e) {
    return e?.code === "ENOENT" || e?.code === "ENOTDIR" ? null : { warning: `${file} can't be read (${e?.code || e?.message})` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { warning: `${file} is not a file` };
    if (uid !== undefined && st.uid !== uid) return { warning: `${file} belongs to another account` };
    if (st.size > PROJECT_MAX_BYTES) return { warning: `${file} is over 4 KB` };
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    let v;
    try { v = JSON.parse(buf.toString("utf8")); } catch { return { warning: `${file} is not JSON` }; }
    const name = v && typeof v === "object" && !Array.isArray(v) ? v.instance : undefined;
    if (name === undefined) return null; // other settings may live there one day
    if (name === "default" || name === null) return { name: null };
    if (!validInstance(name)) return { warning: `${file}: "instance" must be 1 to 32 of a-z, 0-9 and -` };
    return { name };
  } finally {
    closeSync(fd);
  }
}

// The home for an environment and a project folder:
// { home, instance (name or null), shared (the read-only installs' home), source, warning? }.
// source: "PAIRBROWSE_HOME", "PAIRBROWSE_INSTANCE", "project" or "default". An invalid
// PAIRBROWSE_INSTANCE throws: a mistyped name must never quietly open another profile.
export function resolveHome({ env = process.env, cwd = process.cwd(), account = homedir(), uid } = {}) {
  if (env.PAIRBROWSE_HOME) {
    const home = env.PAIRBROWSE_HOME;
    return { home, instance: null, shared: home, source: "PAIRBROWSE_HOME" };
  }
  const base = defaultHome(account);
  const named = env.PAIRBROWSE_INSTANCE;
  if (named !== undefined && named !== "") {
    if (named === "default") return { home: base, instance: null, shared: base, source: "PAIRBROWSE_INSTANCE" };
    if (!validInstance(named)) throw new Error(`PAIRBROWSE_INSTANCE must be 1 to 32 of a-z, 0-9 and - (got ${JSON.stringify(String(named).slice(0, 40))})`);
    return { home: instanceHome(named, account), instance: named, shared: base, source: "PAIRBROWSE_INSTANCE" };
  }
  const dir = env.CLAUDE_PROJECT_DIR || cwd;
  const found = projectInstance(dir, uid === undefined ? {} : { uid });
  if (found?.name) return { home: instanceHome(found.name, account), instance: found.name, shared: base, source: "project" };
  return { home: base, instance: null, shared: base, source: found?.name === null ? "project" : "default", ...(found?.warning ? { warning: found.warning } : {}) };
}
