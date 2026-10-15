// The opener registry (plans/555 D6.2a): several helpers on one Mac (named instances, homes of
// their own) each hand-open their own build. A native build started by hand reads its own record
// first, ~/.pairbrowse/run/openers/<bundle id>.json (always the account's real ~/.pairbrowse:
// the browser reads $HOME), then ~/.pairbrowse/run/opener.json. A record has the form of
// opener.json ({ v: 1, node, script }) plus fields the browser ignores: "home" (the helper's
// home) and "instance" (its name), so scripts/open.mjs reaches that helper and not the default one.
//
// No paths.mjs here: open.mjs picks its home from a record before paths.mjs loads.
import { closeSync, fstatSync, lstatSync, openSync, readSync, readFileSync, realpathSync, constants as fsConstants } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { defaultHome, instanceHome, validInstance } from "./home.mjs";

export const OPENERS_DIR = "openers";
export const RELEASE_BUNDLE_ID = "app.pairbrowse.browser";
export const DEV_BUNDLE_ID = "app.pairbrowse.browser.dev";
const RECORD_MAX_BYTES = 4096;

// The browser's IsRecordName: ASCII letters, digits, "." and "-", at most 128, starting and ending
// with a letter or digit, no "..": a bundle identifier, never a path.
export const isRecordName = (name) => typeof name === "string" && name.length <= 128 && /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(name) && !name.includes("..");

// The registry's folder: the account's ~/.pairbrowse/run/openers.
export const openersDir = (account = homedir()) => join(defaultHome(account), "run", OPENERS_DIR);
export const recordFile = (name, dir = openersDir()) => join(dir, `${name}.json`);

// A macOS app's program (…/X.app/Contents/MacOS/<name>) -> the app; null for anything else.
export const appOf = (exe) => /^(\/.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(exe || ""))?.[1] || null;

// The bundle id a PairBrowse build's manifest (Contents/Resources/PairBrowse-build.json) names:
// "bundleId" (builds from the dev channel on: app.pairbrowse.browser or …browser.dev), else by
// "channel", else the release id (earlier builds). null: not a PairBrowse build's manifest.
export function bundleIdOf(manifest) {
  if (!manifest || typeof manifest !== "object" || manifest.product !== "PairBrowse") return null;
  if (isRecordName(manifest.bundleId)) return manifest.bundleId;
  return manifest.channel === "dev" ? DEV_BUNDLE_ID : RELEASE_BUNDLE_ID;
}
// The bundle id of the native build an app path (or its program) is; null when it isn't one.
export function bundleIdOfApp(appOrExe) {
  const app = appOf(appOrExe) || (String(appOrExe || "").endsWith(".app") ? appOrExe : null);
  if (!app) return null;
  try { return bundleIdOf(JSON.parse(readFileSync(join(app, "Contents", "Resources", "PairBrowse-build.json"), "utf8"))); } catch { return null; }
}

const okPath = (p) => typeof p === "string" && p.length > 1 && p.length <= 1024 && isAbsolute(p) && !/[\0\r\n]/.test(p) && !p.split(/[\\/]/).includes("..");

// A record's text -> { node, script, home, instance } or null: opener.json's rules (v 1, node and
// script absolute, script .../scripts/open.mjs) plus an absolute home and an optional valid name.
export function parseRecord(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > RECORD_MAX_BYTES) return null;
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  if (!v || typeof v !== "object" || Array.isArray(v) || v.v !== 1) return null;
  if (!okPath(v.node) || !okPath(v.script) || basename(v.script) !== "open.mjs" || basename(dirname(v.script)) !== "scripts") return null;
  if (v.home !== undefined && !okPath(v.home)) return null;
  if (v.instance !== undefined && !validInstance(v.instance)) return null;
  return { node: v.node, script: v.script, home: v.home ?? null, instance: v.instance ?? null };
}

// Reads a record as the browser would: the folder and the file this account's and no one else's
// (a 0700 folder, a 0600 regular file, not a link). null when it's not there or not acceptable.
export function readRecord(file, { uid = process.getuid?.() } = {}) {
  const owned = (st) => uid === undefined || st.uid === uid;
  try {
    const dir = lstatSync(dirname(file));
    if (!dir.isDirectory() || !owned(dir) || (process.platform !== "win32" && (dir.mode & 0o077))) return null;
  } catch { return null; }
  let fd;
  try { fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || !owned(st) || st.size > RECORD_MAX_BYTES || (process.platform !== "win32" && (st.mode & 0o077))) return null;
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    return parseRecord(buf.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

// The program of a process (macOS and Linux ps); "" when it can't be told.
export function programOf(pid) {
  try { return execFileSync("/bin/ps", ["-ww", "-o", "comm=", "-p", String(Number(pid))], { encoding: "utf8", timeout: 2000 }).trim(); } catch { return ""; }
}

// open.mjs's home: the record of the app that ran it (its parent's bundle), when that record names
// this very script and a home; then the environment that reaches that helper ({ PAIRBROWSE_HOME }
// or { PAIRBROWSE_INSTANCE }), else null (opener.json's helper: the default home, as before).
export function openerEnv({ parentExe, script, account = homedir(), dir = openersDir(account), uid } = {}) {
  const name = bundleIdOfApp(parentExe);
  if (!isRecordName(name)) return null;
  const record = readRecord(recordFile(name, dir), uid === undefined ? {} : { uid });
  if (!record?.home) return null;
  const same = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return a === b; } };
  if (!same(record.script, script)) return null; // another copy's record: never this copy's business
  if (record.instance) return record.home === instanceHome(record.instance, account) ? { PAIRBROWSE_INSTANCE: record.instance } : null;
  return record.home === defaultHome(account) ? { PAIRBROWSE_INSTANCE: "default" } : { PAIRBROWSE_HOME: record.home };
}
