// Private virtual screen for a Linux machine without a screen: a real, headed browser without a monitor.
// Xvfb runs without TCP and behind an X cookie stored in ~/.pairbrowse, so other users on the
// machine can't watch the screen or send it input.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { paths, DEFAULT_CONFIG } from "./paths.mjs";
import { CONFIG_SCHEMA, fits } from "./config-schema.mjs";
import { pidAlive, sleep, writeJsonAtomic } from "./util.mjs";

// Is a program on the PATH?
export const hasCommand = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;

export function needsVirtualDisplay(config, env = process.env, platform = process.platform) {
  if (config.display === "none" || platform !== "linux") return false;
  if (config.display === "xvfb") return true;
  return !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

// Server mode: the helper runs the browser on its own virtual screen, or config.json's
// server.keepAlive says this is a server. Supervision, the sandbox rule and where() read it; a
// desktop (a screen of its own, no keepAlive) is never in server mode.
export function serverMode(config, env = process.env, platform = process.platform) {
  return needsVirtualDisplay(config, env, platform) || config?.server?.keepAlive === true;
}

// The virtual screen's { width, height, depth } from config.json's virtualScreen: each field the
// schema's bounds allow, else its default (1366x900x24), so a partial or hand-edited value
// still gives a whole screen.
export function screenGeometry(config) {
  const given = config?.virtualScreen && typeof config.virtualScreen === "object" ? config.virtualScreen : {};
  const { fields } = CONFIG_SCHEMA.virtualScreen;
  const out = {};
  for (const k of Object.keys(fields)) out[k] = fits(fields[k], given[k]) ? given[k] : DEFAULT_CONFIG.virtualScreen[k];
  return out;
}

// Xvfb's arguments for display n: one screen of the geometry, the cookie file, no TCP.
export const xvfbArgs = (n, geometry, auth) => [`:${n}`, "-screen", "0", `${geometry.width}x${geometry.height}x${geometry.depth}`, "-auth", auth, "-nolisten", "tcp"];

// A file's text, or null when it can't be read; adds the cookie for display n to the file auth.
const readText = (p) => {
  try { return readFileSync(p, "utf8"); } catch { return null; }
};
const addCookie = (auth, n, cookie) => spawnSync("xauth", ["-f", auth, "add", `:${n}`, ".", cookie]).status === 0;

// The pid an X server's lock file names (/tmp/.X<n>-lock: the pid as text, padded to ten
// characters), or null for anything else.
export function lockPid(text) {
  const m = /^\s*(\d{1,10})\s*$/.exec(typeof text === "string" ? text : "");
  return m ? Number(m[1]) : null;
}

// Is display n ours? Only if our Xvfb child still runs, the display's socket is there and its lock
// holds the child's pid. A socket alone isn't enough: another X server that won the number while
// ours was starting has one too, and ours then exits.
export function ownsDisplay(n, child, { exists = existsSync, read = readText } = {}) {
  if (!Number.isInteger(child?.pid) || child.exitCode !== null || child.signalCode != null) return false;
  if (!exists(`/tmp/.X11-unix/X${n}`)) return false;
  return lockPid(read(`/tmp/.X${n}-lock`)) === child.pid;
}

const FIRST = 99, LAST = 139;

// The ownership record of the screen started behind cookie file name: ~/.pairbrowse/run/<name>.json,
// { display, pid, auth, geometry, startedAt }, owner-only. reapOwn reads it at the next start.
export const recordPath = (name) => join(paths.run, `${name}.json`);

// Is a /proc/<pid>/cmdline (arguments separated by NUL) an Xvfb started behind cookie file auth?
export function isOwnXvfb(cmdline, auth) {
  if (typeof cmdline !== "string" || !cmdline || typeof auth !== "string" || !auth) return false;
  const argv = cmdline.replace(/\0$/, "").split("\0");
  if (basename(argv[0]) !== "Xvfb") return false;
  return argv.some((a, i) => a === "-auth" && argv[i + 1] === auth);
}

// A path's owner uid without following a link, or null when it isn't there.
const ownerOf = (p) => {
  try { return lstatSync(p).uid; } catch { return null; }
};
const removeFile = (p) => {
  try { rmSync(p, { force: true }); } catch {}
};
const signal = (pid, sig) => {
  try { process.kill(pid, sig); return true; } catch { return false; }
};

// Reaping by ownership record, never by guess: what a helper that was killed left of the screen
// it started behind cookie file name. Our recorded pid, still running as our user with Xvfb's
// command line behind our cookie, is ended (SIGTERM, up to 2 s, then SIGKILL). The recorded
// display's lock, when it holds that pid, the pid is gone and the lock is our user's, is removed
// with its socket (also only when ours). Anything else (another program on the pid now, another
// server's lock, a record that doesn't name our cookie) is left alone. The cookie goes either way;
// the record too, unless our Xvfb outlived SIGKILL (stuck in the kernel): then it stays for the next
// start to try again. deps: injectable files, processes and clock for tests. Returns { ended, cleared }.
export async function reapOwn(name, deps = {}) {
  const { log = () => {}, read = readText, alive = pidAlive, kill = signal, owner = ownerOf, remove = removeFile, wait = sleep, uid = process.getuid?.() } = deps;
  const file = recordPath(name), auth = join(paths.run, name);
  const out = { ended: false, cleared: false };
  let stuck = false;
  const text = read(file);
  if (text === null) return out;
  let rec = null;
  try { rec = JSON.parse(text); } catch {}
  const n = /^:(\d{1,3})$/.exec(typeof rec?.display === "string" ? rec.display : "")?.[1];
  const valid = rec && Number.isInteger(rec.pid) && rec.pid > 0 && n !== undefined && Number(n) >= FIRST && Number(n) <= LAST && rec.auth === auth;
  if (valid && uid !== undefined) {
    const { pid } = rec;
    const gone = async (ms) => {
      for (let t = 0; t < ms && alive(pid); t += 100) await wait(100);
      return !alive(pid);
    };
    if (alive(pid) && owner(`/proc/${pid}`) === uid && isOwnXvfb(read(`/proc/${pid}/cmdline`), auth)) {
      kill(pid, "SIGTERM");
      if (!(await gone(2000))) { kill(pid, "SIGKILL"); await gone(1000); }
      out.ended = !alive(pid);
      stuck = !out.ended;
      log(out.ended
        ? `virtual screen ${rec.display}: ended the Xvfb a stopped helper left running (pid ${pid})`
        : `virtual screen ${rec.display}: the Xvfb a stopped helper left running (pid ${pid}) didn't end; its record stays for the next start`);
    }
    const lock = `/tmp/.X${n}-lock`, socket = `/tmp/.X11-unix/X${n}`;
    if (lockPid(read(lock)) === pid && !alive(pid) && owner(lock) === uid) {
      remove(lock);
      if (owner(socket) === uid) remove(socket);
      out.cleared = true;
      log(`virtual screen ${rec.display}: removed the lock our stopped Xvfb left`);
    }
  }
  remove(auth);
  if (!stuck) remove(file);
  return out;
}

// Ending a started screen. stop(): SIGTERM, up to 1 s for Xvfb to exit, then SIGKILL and up to 1 s
// more; the cookie is removed, the record only once Xvfb has exited (once, however often it's
// called). A SIGKILLed Xvfb leaves its lock and socket behind, and the record kept is what lets the
// next start's reapOwn clear them (or end an Xvfb that still runs). stopNow(): synchronous, for
// process exit: SIGTERM and the cookie removed; the record stays unless Xvfb has already exited,
// so an Xvfb that outlives the helper is still ended by the next start's reapOwn.
function ender(child, { auth, record, remove, wait }) {
  const exited = () => child.exitCode !== null || child.signalCode != null;
  const send = (sig) => { try { child.kill(sig); } catch {} };
  let ending = null;
  return {
    stop: () => (ending ||= (async () => {
      if (!exited()) {
        send("SIGTERM");
        for (let t = 0; t < 1000 && !exited(); t += 50) await wait(50);
        if (!exited()) {
          send("SIGKILL");
          for (let t = 0; t < 1000 && !exited(); t += 50) await wait(50);
        }
      }
      remove(auth);
      if (exited()) remove(record);
    })()),
    stopNow: () => {
      if (!exited()) send("SIGTERM");
      remove(auth);
      if (exited()) remove(record);
    },
  };
}

// name: the X cookie file in ~/.pairbrowse/run (the launch self-check uses its own, so a
// running browser's screen keeps working). geometry: { width, height, depth } (screenGeometry;
// checked again here, defaults for what's missing). First reapOwn ends what a killed helper left
// behind this cookie. A display counts as started only when ownsDisplay says so; otherwise its Xvfb
// is ended and the next number is tried. The started screen's ownership record is written then.
// deps: injectable commands and files for tests. Returns { env, display, pid, geometry, stop,
// stopNow } (ender).
export async function startVirtualDisplay(log = () => {}, { name = "Xauthority", geometry } = {}, deps = {}) {
  const { has = hasCommand, spawn: run = spawn, exists = existsSync, read = readText, xauth = addCookie, wait = sleep, tries = 50 } = deps;
  const { reap = reapOwn, save = (file, rec) => writeJsonAtomic(file, rec, { mode: 0o600 }), remove = removeFile } = deps;
  if (!has("Xvfb") || !has("xauth")) {
    throw new Error("pairbrowse needs Xvfb and xauth for a virtual screen. Install them (Debian/Ubuntu: sudo apt-get install -y xvfb xauth).");
  }
  const g = screenGeometry({ virtualScreen: geometry });
  const auth = join(paths.run, name), record = recordPath(name);
  await reap(name, { log });
  mkdirSync(paths.run, { recursive: true, mode: 0o700 });
  let taken = 0;
  for (let n = FIRST; n <= LAST; n++) {
    if (exists(`/tmp/.X11-unix/X${n}`) || exists(`/tmp/.X${n}-lock`)) { taken++; continue; }
    rmSync(auth, { force: true });
    if (!xauth(auth, n, randomBytes(16).toString("hex"))) throw new Error("xauth failed");
    const xvfb = run("Xvfb", xvfbArgs(n, g, auth), { stdio: "ignore" });
    xvfb.on?.("error", () => {});
    for (let i = 0; i < tries && xvfb.exitCode === null; i++) {
      if (ownsDisplay(n, xvfb, { exists, read })) {
        log(`virtual screen :${n} started (${g.width}x${g.height}x${g.depth})`);
        // Without its record the screen still works; only a later reap of it is lost.
        try { save(record, { display: `:${n}`, pid: xvfb.pid, auth, geometry: g, startedAt: Date.now() }); } catch (e) { log(`virtual screen :${n}: its record wasn't written (${e?.message || e})`); }
        return { env: { DISPLAY: `:${n}`, XAUTHORITY: auth }, display: `:${n}`, pid: xvfb.pid, geometry: g, ...ender(xvfb, { auth, record, remove, wait }) };
      }
      await wait(100);
    }
    // Not ours: another server won the number (its lock names another pid), or ours exited or
    // never got ready. Ours is ended either way, so it never lingers on a display we don't use.
    const won = lockPid(read(`/tmp/.X${n}-lock`));
    const foreign = won !== null && won !== xvfb.pid;
    if (foreign) taken++;
    if (xvfb.exitCode === null) xvfb.kill();
    log(`virtual screen :${n} not used (${foreign ? "taken by another X server" : "Xvfb didn't start"})`);
  }
  if (taken === LAST - FIRST + 1) throw new Error(`couldn't start a virtual screen: displays :${FIRST} to :${LAST} are taken (${taken} held by other X servers)`);
  throw new Error("couldn't start a virtual screen (Xvfb)");
}
