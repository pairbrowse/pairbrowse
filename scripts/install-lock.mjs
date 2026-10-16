// One install at a time in the shared installs' home (paths.shared): instances of PairBrowse
// (home.mjs) share one runtime, one browser app, one engine pack and one cloudflared, so two
// helpers (or a helper and the by-hand install step) starting at once must not fill the same
// folder together. The lock file names its holder: { pid, start, token }. start is when that
// process started (startOf below), so a lock left by a crash whose pid now belongs to an unrelated
// process (after a reboot, say) counts as gone; token is this hold's own, and a release removes the
// file only while it still carries it (never a lock another process took over since). A waiter
// checks again every 250 ms; a lock whose process is gone, whose process started at another time,
// or that is older than staleMs (its holder touches it while it holds) is taken over. A plain pid
// (an older helper's lock) is still read, by pid alone.
// Re-entrant only along one call chain: an install that runs another (the native browser's engine
// pack) never waits on itself (AsyncLocalStorage for the async form, the running synchronous fn for
// the sync one), while two unrelated installs in one process take turns like two processes do.
import { readFileSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { paths } from "./paths.mjs";
import { pidAlive, sleep } from "./util.mjs";

const POLL_MS = 250;
const WAIT_MS = 15 * 60_000; // the slowest install (the browser on a slow line) finishes in this
const STALE_MS = 30 * 60_000;

// When a process started, as a string that differs for a pid used again: on Linux the boot's id
// and field 22 of /proc/<pid>/stat (clock ticks since boot); elsewhere on POSIX `ps -o lstart=`
// (to the second, which a reused pid can't match within one boot, and the date tells boots apart).
// null when it can't be told (Windows, ps missing): the pid alone is checked then.
export function startOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // after "pid (comm) ": field 3 on
      let boot = "";
      try { boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch {}
      return fields[19] ? `${boot}:${fields[19]}` : null;
    }
    if (process.platform === "win32") return null;
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } }).trim();
    return out || null;
  } catch { return null; }
}
const ownStart = startOf(process.pid);

// The holder written in a lock file: { pid, start, token }, or null when unreadable.
function readHolder(file) {
  let text;
  try { text = readFileSync(file, "utf8").trim(); } catch { return null; }
  if (/^\d+$/.test(text)) return { pid: Number(text), start: null, token: null };
  try {
    const h = JSON.parse(text);
    return { pid: Number.isInteger(h?.pid) ? h.pid : 0, start: typeof h?.start === "string" ? h.start : null, token: typeof h?.token === "string" ? h.token : null };
  } catch { return { pid: 0, start: null, token: null }; }
}
const sameHolder = (a, b) => !!a && !!b && a.pid === b.pid && a.start === b.start && a.token === b.token;

// Whether a lock's holder still runs: its pid lives and, when both are known, started when it says.
export function holderAlive(h, { alive = pidAlive, started = startOf } = {}) {
  if (!h?.pid || !alive(h.pid)) return false;
  if (h.start == null) return true;
  const now = started(h.pid);
  return now == null || now === h.start;
}

// One try: this hold's token when this process now holds the lock, else null.
function tryTake(file, staleMs) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(16).toString("hex");
  try {
    writeFileSync(file, JSON.stringify({ pid: process.pid, start: ownStart, token }), { flag: "wx", mode: 0o600 });
    return token;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  let holder, age;
  try { holder = readHolder(file); age = Date.now() - statSync(file).mtimeMs; } catch { return null; }
  if (!holder) return null;
  if (holderAlive(holder) && age < staleMs) return null;
  // Take the dead lock over atomically: only one process moves it aside, and only while it's
  // still the dead one.
  const aside = `${file}.${process.pid}.${token}`;
  try { renameSync(file, aside); } catch { return null; }
  if (!sameHolder(readHolder(aside), holder)) { try { renameSync(aside, file); } catch {} return null; }
  rmSync(aside, { force: true });
  return null; // the next try writes it
}

// Removes the lock only while it is still this hold's.
function release(file, token) {
  const h = readHolder(file);
  if (h && h.token === token && h.pid === process.pid) rmSync(file, { force: true });
}
// While held, the file's time is kept fresh, so a long install is never taken for a stale lock.
function keepFresh(file, token, staleMs) {
  const t = setInterval(() => {
    if (readHolder(file)?.token !== token) return;
    try { const now = new Date(); utimesSync(file, now, now); } catch {}
  }, Math.max(1000, Math.floor(staleMs / 3)));
  t.unref?.();
  return () => clearInterval(t);
}
const busy = (file) => {
  const pid = readHolder(file)?.pid;
  return new Error(`another PairBrowse install is still running${pid ? ` (process ${pid})` : ""}; try again in a minute`);
};

// The locks this call chain holds (absolute paths): the async form's, and the sync form's while its
// fn runs (a synchronous fn can't be interleaved with another call, so a call made then is nested).
const chain = new AsyncLocalStorage();
const syncHeld = new Set();
// Locks this process holds at all, so the sync form never blocks the thread on a lock only this
// process could release.
const ownHeld = new Map();
const nested = (key) => syncHeld.has(key) || !!chain.getStore()?.has(key);
const hold = (key) => ownHeld.set(key, (ownHeld.get(key) || 0) + 1);
const unhold = (key) => { const n = (ownHeld.get(key) || 1) - 1; if (n) ownHeld.set(key, n); else ownHeld.delete(key); };

// Runs fn (async) holding the lock, waiting up to waitMs for it.
export async function withInstallLock(fn, { file = paths.installLock, waitMs = WAIT_MS, staleMs = STALE_MS, say = () => {} } = {}) {
  const key = resolve(file);
  if (nested(key)) return await fn();
  const until = Date.now() + waitMs;
  let told = false, token;
  while (!(token = tryTake(file, staleMs))) {
    if (Date.now() > until) throw busy(file);
    if (!told) { told = true; say("another PairBrowse helper is installing; waiting for it"); }
    await sleep(POLL_MS);
  }
  hold(key);
  const stop = keepFresh(file, token, staleMs);
  const held = new Set(chain.getStore() || []).add(key);
  try { return await chain.run(held, fn); } finally { stop(); unhold(key); release(file, token); }
}

// The same for a synchronous fn (the runtime's npm ci): the wait blocks this thread, so it fails at
// once when it is this process (another call chain) that holds the lock.
export function withInstallLockSync(fn, { file = paths.installLock, waitMs = WAIT_MS, staleMs = STALE_MS, say = () => {} } = {}) {
  const key = resolve(file);
  if (nested(key)) return fn();
  const until = Date.now() + waitMs;
  let told = false, token;
  while (!(token = tryTake(file, staleMs))) {
    if (ownHeld.has(key) || Date.now() > until) throw busy(file);
    if (!told) { told = true; say("another PairBrowse helper is installing; waiting for it"); }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS);
  }
  hold(key);
  syncHeld.add(key);
  try { return fn(); } finally { syncHeld.delete(key); unhold(key); release(file, token); }
}
