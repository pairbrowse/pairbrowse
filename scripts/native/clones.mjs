// The engine's code-sign clone on macOS (its code_sign_clone_manager, the MacAppCodeSignClone
// feature, on by default): at every start the browser makes a copy-on-write copy of its whole app
// in the per-user "X" folder (<DARWIN_USER_TEMP_DIR>/../X/<bundle id>.code_sign_clone/
// code_sign_clone.XXXXXX/) and removes it only on a clean exit. It is there for an app that updates
// itself in place while it runs; PairBrowse's builds never do (the install swaps the whole app),
// and a browser the helper or a test kills hard left a copy behind each time (~400 MB as du counts
// it, less on disk as APFS clones, still growing with every hard stop).
//
// So every launch of the native build on macOS turns the feature off (native-engine.mjs
// launchNative, merged into its one --disable-features), and the helper's start removes the clones
// earlier runs left (sweepCodeSignClones): only PairBrowse's own (app.pairbrowse.browser* and the
// open build's dev.pairbrowse.browser*, never another app's), only when no PairBrowse browser runs
// at all (the engine keeps no lock on a clone: a running browser is the only sign one is in use),
// never one made in the last few minutes, bounded in count and time, best effort.
// The open build gets no switch: the engine takes a switch's last value only, and a lone
// --disable-features there would replace the driver's own list of turned-off features (the
// native launch merges its list in the engine pack's one switch, which comes last already). Its
// leftovers go with the sweep.
import { execFile } from "node:child_process";
import { readdir, lstat, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export const NO_CLONE_FEATURE = "MacAppCodeSignClone";

// The folders the engine names after the app's bundle id, PairBrowse's only: the native build
// (app.pairbrowse.browser, a dev build's app.pairbrowse.browser.dev) and the open build
// (dev.pairbrowse.browser). One clone in each: "code_sign_clone." and mkdtemp's six characters
// (the engine checks the same set: letters, digits, ".", "_", "-").
const CLONE_PARENT = /^(?:app|dev)\.pairbrowse\.browser(?:\.[A-Za-z0-9-]+)*\.code_sign_clone$/;
const CLONE_DIR = /^code_sign_clone\.[A-Za-z0-9._-]{6}$/;
// The per-user temp folder getconf gives (/var/folders/<2>/<id>/T/, under /private on disk); X sits beside it.
const USER_TEMP = /^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T\/?$/;

export const isCloneParent = (name) => CLONE_PARENT.test(name);
export const isCloneDir = (name) => CLONE_DIR.test(name);

// The X folder for a DARWIN_USER_TEMP_DIR, or null for anything not shaped like one.
export function cloneRoot(userTempDir) {
  const t = String(userTempDir ?? "").trim();
  if (!USER_TEMP.test(t) || t.split("/").includes("..")) return null;
  return join(dirname(t.replace(/\/+$/, "")), "X");
}

// Whether a process list (one executable path per line, as ps -o comm= prints them) has a
// PairBrowse browser in it: any process from an app bundle whose name says PairBrowse (the
// browser, its helpers, the open build, a dev build) or from inside a clone, except PairBrowse
// Agent (the helper's own program on a native build, launcher/daemon-connect.mjs AGENT: never a
// browser, and always running while the sweep does). Wider than needed on purpose: a match only
// means the sweep waits for another start.
const BROWSER_PROCESS = /PairBrowse[^/]*\.app\/|\.code_sign_clone\//i;
const AGENT_PROCESS = /\/PairBrowse Agent\.app\/Contents\/MacOS\/PairBrowse Agent$/;
export const browserRunning = (psOutput) => String(psOutput ?? "").split("\n").some((l) => BROWSER_PROCESS.test(l) && !AGENT_PROCESS.test(l.trim()));

// Of { name, isDirectory, isSymbolicLink, born } entries in one clone parent, the clones to
// remove: real folders (never a link) with the engine's name, made before minAgeMs ago.
export function stale(entries, { now = Date.now(), minAgeMs = MIN_AGE_MS } = {}) {
  return entries.filter((e) => e.isDirectory && !e.isSymbolicLink && isCloneDir(e.name) && Number.isFinite(e.born) && now - e.born >= minAgeMs).map((e) => e.name);
}

const MIN_AGE_MS = 5 * 60_000;
const MAX_REMOVED = 50;
const BUDGET_MS = 60_000;

const run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { encoding: "utf8", timeout: 5_000, maxBuffer: 8 << 20 }, (error, stdout) => resolve(error ? null : stdout));
});

// Removes stale PairBrowse clones; resolves { removed, skipped } and never throws. platform, ps,
// getconf, now, root (the X folder found from getconf's answer, a temp tree's in tests): seams for tests.
export async function sweepCodeSignClones({ log = () => {}, platform = process.platform, now = Date.now,
  getconf = () => run("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"]), ps = () => run("/bin/ps", ["-axww", "-o", "comm="]),
  minAgeMs = MIN_AGE_MS, maxRemoved = MAX_REMOVED, budgetMs = BUDGET_MS, root: given = null } = {}) {
  if (platform !== "darwin") return { removed: 0, skipped: "not macOS" };
  try {
    const found = cloneRoot(await getconf());
    if (!found) return { removed: 0, skipped: "no per-user temp folder" };
    const root = given ?? found;
    const parents = (await readdir(root, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && isCloneParent(d.name));
    if (!parents.length) return { removed: 0, skipped: "none" };
    const list = await ps();
    if (list === null) return { removed: 0, skipped: "the process list could not be read" };
    if (browserRunning(list)) return { removed: 0, skipped: "a PairBrowse browser is running" };
    const started = now();
    let removed = 0;
    for (const parent of parents) {
      const dir = join(root, parent.name);
      const entries = [];
      for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!isCloneDir(d.name)) continue;
        const st = await lstat(join(dir, d.name)).catch(() => null);
        if (st) entries.push({ name: d.name, isDirectory: st.isDirectory(), isSymbolicLink: st.isSymbolicLink(), born: st.birthtimeMs });
      }
      for (const name of stale(entries, { now: now(), minAgeMs })) {
        if (removed >= maxRemoved || now() - started > budgetMs) break;
        try { await rm(join(dir, name), { recursive: true, force: true }); removed++; } catch (e) { log(`code-sign clones: ${parent.name}/${name}: ${e?.code || e?.message || e}`); }
      }
    }
    if (removed) log(`code-sign clones: removed ${removed} ${removed > 1 ? "copies" : "copy"} of the browser a hard stop left behind`);
    return { removed, skipped: null };
  } catch (e) {
    log(`code-sign clones: ${e?.code || e?.message || e}`);
    return { removed: 0, skipped: "error" };
  }
}
