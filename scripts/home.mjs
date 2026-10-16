// Which PairBrowse home this process uses (paths.mjs builds every path from it), with no side
// effects and no other project module, so scripts/open.mjs can choose a home before paths.mjs loads.
//
// One home = one helper = one browser. Several helpers on one computer are named instances:
//   PAIRBROWSE_HOME=<folder>         that folder, as before (wins over everything below)
//   PAIRBROWSE_INSTANCE=<name>       ~/.pairbrowse/instances/<name>
//   .pairbrowse.json {"instance"}    the same, from the project folder Claude Code (or the Claude
//                                    desktop app) runs in: CLAUDE_PROJECT_DIR, else the current
//                                    folder (projectDir); only that one file, never a parent folder
//   none of these                    ~/.pairbrowse (the default home, as before)
// "default" names the default home. An instance keeps its own profile, sessions, config, secrets,
// facts, runs and logs; the read-only installs (runtime, browser apps, engine pack, cloudflared,
// downloads, this Mac's measured profile) stay in the default home and are shared: `shared`.
import { closeSync, fstatSync, openSync, readSync, readFileSync, constants as fsConstants } from "node:fs";
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

// Variables a project's own settings may not set. Claude Code hands a project's
// .claude/settings.json (and .claude/settings.local.json) "env" to the plugin it runs, and Codex
// reads a project's .codex folder (its TOML settings file). Those name which folder is this
// helper's home (its profile, config, secrets, the installs it runs), the name it shows the
// people it shares with, and how long an ask waits in the browser (guard.mjs: a project must not
// cut that short so you have no time to answer). Set there, they
// are removed before anything reads them (paths.mjs), so a project never picks a home of its
// choosing (it may still pick one of your own instances: PAIRBROWSE_INSTANCE, .pairbrowse.json)
// nor speaks as someone else. Set in your own shell or user settings, they work as before.
export const PROJECT_GATED = Object.freeze(["PAIRBROWSE_HOME", "PAIRBROWSE_PARTICIPANT", "PAIRBROWSE_APPROVAL_WAIT_MS"]);
// The Codex file's name is joined so util.test.mjs's config-key scan doesn't read it as a setting.
export const PROJECT_SETTINGS = Object.freeze([[".claude", "settings.json"], [".claude", "settings.local.json"], [".codex", ["config", "toml"].join(".")]]);
const SETTINGS_MAX_BYTES = 4 << 20;

// The gated names one settings file names. Claude Code's .claude files are JSON: a key anywhere in
// the parsed file (its "env" above all) that is a gated name, in any letter case, counts, so a key
// spelled with \u escapes is caught as JSON.parse reads it; a file that doesn't parse names them
// all. The Codex file is TOML: any mention counts, in its text as written or with its \uXXXX and
// \UXXXXXXXX escapes decoded (a quoted key may spell a name that way).
export function settingsNames(kind, text) {
  const t = String(text);
  if (kind === "json") {
    let v;
    try { v = JSON.parse(t.replace(/^\uFEFF/, "")); } catch { return [...PROJECT_GATED]; }
    const named = new Set();
    const stack = [v];
    while (stack.length) {
      const o = stack.pop();
      if (!o || typeof o !== "object") continue;
      for (const k of Object.keys(o)) {
        const up = k.toUpperCase();
        for (const name of PROJECT_GATED) if (up === name) named.add(name);
        stack.push(o[k]);
      }
    }
    return [...named];
  }
  const decoded = t.replace(/\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8}))/g, (m, a, b) => {
    const cp = parseInt(a || b, 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
  return PROJECT_GATED.filter((name) => t.includes(name) || decoded.includes(name));
}

// The gated names the project folder's settings files name (settingsNames; a file too big or
// unreadable for a reason other than its absence counts as naming them all).
export function projectSetNames(dir) {
  if (typeof dir !== "string" || !isAbsolute(dir)) return [];
  const named = new Set();
  for (const parts of PROJECT_SETTINGS) {
    let text;
    try {
      text = readFileSync(join(dir, ...parts));
    } catch (e) {
      if (e?.code === "ENOENT" || e?.code === "ENOTDIR") continue;
      return [...PROJECT_GATED];
    }
    if (text.length > SETTINGS_MAX_BYTES) return [...PROJECT_GATED];
    for (const name of settingsNames(parts[1].endsWith(".json") ? "json" : "toml", text.toString("utf8"))) named.add(name);
  }
  return [...named];
}

// The project folder every PairBrowse process reads (.pairbrowse.json, the project settings): Claude
// Code's CLAUDE_PROJECT_DIR when it is an absolute path, else the current folder. Hooks get
// CLAUDE_PROJECT_DIR from Claude Code; the bridge gets it too (Claude Code sets it for MCP servers,
// and .mcp.json passes it in "env" as well). A value that isn't an absolute path (such as the
// unexpanded "${CLAUDE_PROJECT_DIR}" an older client may leave, or the "." default .mcp.json
// gives where nothing sets it) counts as unset.
export function projectDir(env = process.env, cwd = process.cwd()) {
  const dir = env.CLAUDE_PROJECT_DIR;
  return typeof dir === "string" && isAbsolute(dir) ? dir : cwd;
}

// Removes from env each gated variable the project's settings name (projectDir); returns the
// names removed.
export function gateProjectEnv(env = process.env, { cwd = process.cwd() } = {}) {
  const present = PROJECT_GATED.filter((k) => env[k] !== undefined);
  if (!present.length) return [];
  const names = projectSetNames(projectDir(env, cwd));
  const removed = present.filter((k) => names.includes(k));
  for (const k of removed) delete env[k];
  return removed;
}

// The home for an environment and a project folder:
// { home, instance (name or null), shared (the read-only installs' home), source, warning? }.
// source: "PAIRBROWSE_HOME", "PAIRBROWSE_INSTANCE", "project" or "default". An invalid
// PAIRBROWSE_INSTANCE throws (code BAD_INSTANCE): a mistyped name must never quietly open another
// profile.
export const BAD_INSTANCE = "EBADINSTANCE";
export function resolveHome({ env = process.env, cwd = process.cwd(), account = homedir(), uid } = {}) {
  if (env.PAIRBROWSE_HOME) {
    const home = env.PAIRBROWSE_HOME;
    return { home, instance: null, shared: home, source: "PAIRBROWSE_HOME" };
  }
  const base = defaultHome(account);
  const named = env.PAIRBROWSE_INSTANCE;
  if (named !== undefined && named !== "") {
    if (named === "default") return { home: base, instance: null, shared: base, source: "PAIRBROWSE_INSTANCE" };
    if (!validInstance(named)) throw Object.assign(new Error(`PAIRBROWSE_INSTANCE must be 1 to 32 of a-z, 0-9 and - (got ${JSON.stringify(String(named).slice(0, 40))})`), { code: BAD_INSTANCE });
    return { home: instanceHome(named, account), instance: named, shared: base, source: "PAIRBROWSE_INSTANCE" };
  }
  const found = projectInstance(projectDir(env, cwd), uid === undefined ? {} : { uid });
  if (found?.name) return { home: instanceHome(found.name, account), instance: found.name, shared: base, source: "project" };
  return { home: base, instance: null, shared: base, source: found?.name === null ? "project" : "default", ...(found?.warning ? { warning: found.warning } : {}) };
}

// Points env at a chosen home ({ PAIRBROWSE_HOME } or { PAIRBROWSE_INSTANCE }, replacing both);
// with none chosen, a home the environment already names stays, else the default home (never a
// project file in the folder this runs in). For scripts/open.mjs, before paths.mjs loads.
export function selectHome(env, chosen) {
  if (chosen) {
    delete env.PAIRBROWSE_HOME;
    delete env.PAIRBROWSE_INSTANCE;
    Object.assign(env, chosen);
  } else if (!env.PAIRBROWSE_HOME && !env.PAIRBROWSE_INSTANCE) {
    env.PAIRBROWSE_INSTANCE = "default";
  }
  return env;
}
