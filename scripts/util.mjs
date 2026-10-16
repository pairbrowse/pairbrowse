// Small helpers shared by the helper, the hooks and the install steps (Node's standard library only).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Whether a process with this id runs (one of another user's counts: EPERM).
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

// A sliding-window rate limit kept on an object (a joiner, say): true when n more fit among the
// last windowMs' (and counts them, at t), false when they don't (nothing counted).
export function spend(holder, field, max, { t = Date.now(), n = 1, windowMs = 1000 } = {}) {
  // (A time after t: the clock went back. It no longer counts, or the limit would hold until the
  // clock caught up.)
  const times = (Array.isArray(holder[field]) ? holder[field] : []).filter((x) => x > t - windowMs && x <= t);
  holder[field] = times;
  if (times.length + n > max) return false;
  for (let i = 0; i < n; i++) times.push(t);
  return true;
}

// A JSON file's contents, or `fallback` when it's missing or not valid JSON. A file that is there
// but isn't valid JSON (cut short by a full disk, edited by hand) is copied aside first, as
// <file>.corrupt (or <file>.corrupt-<time> when another, different copy holds that name; owner-only),
// so the writer that follows, which starts from the fallback, never loses what it held; then
// reported once per copy (onCorruptJson: the helper logs it).
export function readJson(file, fallback = null) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return fallback; }
  try { return JSON.parse(text); } catch {
    keepCorrupt(file, text);
    return fallback;
  }
}

// The log line for such a file.
export const corruptLine = (file, copy) => `${file} wasn't valid JSON: what it held is kept in ${copy}, and PairBrowse goes on without it`;
let corruptReporter = () => {};
// fn(file, copy): a file readJson couldn't parse, and where its contents were kept. keepCorrupt(file,
// text): the same for a reader that parses a file itself.
export function onCorruptJson(fn) { corruptReporter = typeof fn === "function" ? fn : () => {}; }
export function keepCorrupt(file, text) {
  if (!text.trim()) return; // nothing in it to keep
  try {
    let copy = `${file}.corrupt`;
    if (existsSync(copy)) {
      if (readFileSync(copy, "utf8") === text) return; // kept already
      copy = `${file}.corrupt-${Date.now()}`;
    }
    writeFileSync(copy, text, { mode: 0o600, flag: "wx" });
    try { corruptReporter(file, copy); } catch {}
  } catch {}
}

// Writes `value` as JSON through a .tmp file and a rename, so another process reading the file
// (the helper and the runs server share the run files) never sees half of it. mode: the file's
// permissions (0o600: owner-only), set on the .tmp file before it takes the name; the folder it
// makes gets 0o700 then too. indent: JSON.stringify's (0: on one line, as the engine writes its own
// profile files).
export function writeJsonAtomic(file, value, { mode, indent = 2 } = {}) {
  mkdirSync(dirname(file), { recursive: true, ...(mode !== undefined ? { mode: 0o700 } : {}) });
  // Per process: two processes writing the same file (the runs server of two agents) never share one.
  const tmp = `${file}.${process.pid}.tmp`;
  if (mode !== undefined) rmSync(tmp, { force: true }); // a leftover .tmp keeps its own mode otherwise
  // A write that fails (a full disk, a read-only folder) leaves the file as it was and no half
  // written .tmp beside it; the error goes to the caller.
  try {
    writeFileSync(tmp, JSON.stringify(value, null, indent || undefined), mode !== undefined ? { mode } : undefined);
    if (mode !== undefined) chmodSync(tmp, mode); // the umask can't widen or narrow it
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

// A URL's host (with its port) or origin; fallback when it isn't a URL.
export const urlHost = (url, fallback = "") => { try { return new URL(url).host; } catch { return fallback; } };
export const urlOrigin = (url, fallback = "") => { try { return new URL(url).origin; } catch { return fallback; } };

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

// Downloads url to dest only if the bytes match the pinned SHA-256. It goes through a .part file,
// so an interrupted or wrong download never looks finished. A matching dest is reused as it is.
export async function downloadPinned(url, dest, sha256Hex, { timeoutMs = 30 * 60_000 } = {}) {
  if (existsSync(dest) && (await sha256File(dest)) === sha256Hex) return dest;
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`couldn't download ${basename(dest)} (HTTP ${res.status})`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
    if ((await sha256File(part)) !== sha256Hex) throw new Error(`the ${basename(dest)} download doesn't match its pinned SHA-256`);
    renameSync(part, dest);
    return dest;
  } finally {
    rmSync(part, { force: true });
  }
}

// `promise`'s value, or null once `ms` have passed (for checks that give up quietly).
// The timer goes as soon as the promise settles: no timer outlives the wait (thousands of bounded
// awaits would otherwise keep theirs running, and a process waiting to exit on them).
export function within(ms, promise) {
  let timer;
  const up = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([promise, up]).finally(() => clearTimeout(timer));
}

// A Cloudflare Quick Tunnel's host name, the one check every part uses (join codes, relays, shared
// dev servers, the tunnel's own address): words of lower-case letters and digits joined by single
// hyphens (none at either end, none doubled), then .trycloudflare.com, nothing else.
const QUICK_TUNNEL_HOST = /^[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/;
export const isQuickTunnelHost = (host) => typeof host === "string" && host.length <= 253 && QUICK_TUNNEL_HOST.test(host);

// A page read that gives up quietly: its value, or `fallback` when it failed or didn't answer
// within ms (a page whose scripts never pause answers nothing).
export const bounded = (p, fallback, ms = 2500) => within(ms, Promise.resolve(p).catch(() => fallback)).then((v) => v ?? fallback);

// Until a page has loaded, at most maxMs, by asking it first: a page restored by Back (the
// browser's cache) fires no load event again, and Playwright's waitForLoadState("load") then
// waits its whole bound for one. Right after a move the old document may be gone and the new
// one not yet answering (no answer within probeMs): then a short wait for domcontentloaded and a
// second ask, and only a page that says it's still loading waits for the load event.
export async function pageLoaded(page, { maxMs = 4000, probeMs = 400, dclMs = 1000 } = {}) {
  const ask = () => within(probeMs, page.evaluate(() => document.readyState).catch(() => "")).catch(() => "");
  let ready = await ask();
  if (ready === "complete") return;
  if (!ready) {
    await within(dclMs, page.waitForLoadState("domcontentloaded").catch(() => {}));
    ready = await ask();
    if (ready === "complete") return;
  }
  await within(maxMs, page.waitForLoadState("load").catch(() => {}));
}

// `promise`, or a rejection with `message` once `ms` have passed.
export function withTimeout(promise, ms, message = `timed out after ${ms} ms`) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}

// This computer's account: its full name (macOS: id -F; Linux: the passwd GECOS field, from
// /etc/passwd or getent for directory accounts) and login. Tests pass their own lookups.
export function readAccount({ platform = process.platform, user = () => userInfo(), run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }), passwd = () => readFileSync("/etc/passwd", "utf8") } = {}) {
  let username = "";
  try { username = String(user().username || ""); } catch {}
  const attempt = (fn) => { try { return String(fn() || "").trim(); } catch { return ""; } };
  // GECOS: "Full Name,room,phone,..."; "&" stands for the login, capitalized.
  const gecos = (line) => {
    const f = String(line || "").split("\n")[0].split(":");
    return f.length >= 5 ? f[4].split(",")[0].replace(/&/g, username.charAt(0).toUpperCase() + username.slice(1)).trim() : "";
  };
  let fullName = "";
  if (platform === "darwin") fullName = attempt(() => run("id", ["-F"]));
  else if (platform !== "win32" && username) {
    fullName = gecos(attempt(passwd).split("\n").find((l) => l.startsWith(`${username}:`)))
      || gecos(attempt(() => run("getent", ["passwd", username])));
  }
  return { fullName, username };
}
// Read once: an account's name doesn't change while the helper runs, and id/getent cost a process.
let account = null;
export const currentAccount = () => (account ??= readAccount());

// A description within max characters: cut after the last whole item ("**A**, **B**, ..."), else
// at a word, else hard, with "..." after it and every bold mark paired (never "**Delivery; ...").
export function clipActivity(text, max) {
  const s = String(text);
  if (s.length <= max) return s;
  const cut = (room) => {
    const head = s.slice(0, room);
    const item = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "));
    if (item > 0) return s.slice(0, item + 2);
    const word = head.lastIndexOf(" ");
    return word > 0 ? head.slice(0, word).trimEnd() : head;
  };
  const open = (t) => (t.match(/\*\*/g) || []).length % 2 === 1;
  let out = cut(max - 3);
  if (open(out)) {
    out = cut(max - 5).replace(/[\s,;]+$/, "");
    if (open(out)) out += "**";
    out += " ";
  }
  return `${out}...`.slice(0, max);
}
