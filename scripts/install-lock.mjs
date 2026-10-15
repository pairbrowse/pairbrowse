// One install at a time in the shared installs' home (paths.shared): instances of PairBrowse
// (home.mjs) share one runtime, one browser app, one engine pack and one cloudflared, so two
// helpers (or a helper and the by-hand install step) starting at once must not fill the same
// folder together. The lock file names its process; a waiter checks again every 250 ms, and a lock
// whose process is gone (or that is older than staleMs) is taken over. Re-entrant within one
// process: an install that runs another (the native browser's engine pack) never waits on itself.
import { readFileSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "./paths.mjs";
import { pidAlive, sleep } from "./util.mjs";

const POLL_MS = 250;
const WAIT_MS = 15 * 60_000; // the slowest install (the browser on a slow line) finishes in this
const STALE_MS = 30 * 60_000;
let held = 0;

// One try: true when this process now holds the lock.
function tryTake(file, staleMs) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  let pid, age;
  try { pid = Number(readFileSync(file, "utf8")) || 0; age = Date.now() - statSync(file).mtimeMs; } catch { return false; }
  if (pid && pidAlive(pid) && age < staleMs) return false;
  // Take the dead lock over atomically: only one process moves it aside, and only while it's
  // still the dead one.
  const aside = `${file}.${process.pid}`;
  try { renameSync(file, aside); } catch { return false; }
  let still = false;
  try { still = (Number(readFileSync(aside, "utf8")) || 0) === pid; } catch {}
  if (!still) { try { renameSync(aside, file); } catch {} return false; }
  rmSync(aside, { force: true });
  return false; // the next try writes it
}

const release = (file) => { if (--held === 0) rmSync(file, { force: true }); };
const busy = (file) => {
  let pid = "";
  try { pid = readFileSync(file, "utf8").trim(); } catch {}
  return new Error(`another PairBrowse install is still running${pid ? ` (process ${pid})` : ""}; try again in a minute`);
};

// Runs fn (async) holding the lock, waiting up to waitMs for it.
export async function withInstallLock(fn, { file = paths.installLock, waitMs = WAIT_MS, staleMs = STALE_MS, say = () => {} } = {}) {
  if (held > 0) { held++; try { return await fn(); } finally { release(file); } }
  const until = Date.now() + waitMs;
  let told = false;
  while (!tryTake(file, staleMs)) {
    if (Date.now() > until) throw busy(file);
    if (!told) { told = true; say("another PairBrowse helper is installing; waiting for it"); }
    await sleep(POLL_MS);
  }
  held++;
  try { return await fn(); } finally { release(file); }
}

// The same for a synchronous fn (the runtime's npm ci): the wait blocks this thread.
export function withInstallLockSync(fn, { file = paths.installLock, waitMs = WAIT_MS, staleMs = STALE_MS, say = () => {} } = {}) {
  if (held > 0) { held++; try { return fn(); } finally { release(file); } }
  const until = Date.now() + waitMs;
  let told = false;
  while (!tryTake(file, staleMs)) {
    if (Date.now() > until) throw busy(file);
    if (!told) { told = true; say("another PairBrowse helper is installing; waiting for it"); }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS);
  }
  held++;
  try { return fn(); } finally { release(file); }
}
