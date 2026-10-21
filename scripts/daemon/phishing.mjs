// Phishing protection: Phishing.Database's list of active phishing domains (MIT licence),
// downloaded over HTTPS every LIST_EVERY_MS into paths.phishingList and checked on this computer by
// exact host (a "www." in front counts too): nothing about what is browsed leaves the computer. A
// top-level navigation to a listed host, a person's or an agent's, is stopped before its page shows:
// a warning page takes its place, with Go back and a Continue anyway that only a click on that
// page itself gives (it lets that host through for the rest of the helper's run). Agents can't
// press it: their hands work only in web tabs (policy.mjs isWebTab). Off with
// config.phishingProtection false. Lists only reported sites, by domain; no malware list.
import { statSync, mkdirSync, renameSync, openSync, writeSync, closeSync, rmSync, readSync, fstatSync, writeFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pidAlive } from "../util.mjs";

export const LIST_URL = "https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-domains-ACTIVE.txt";
export const LIST_EVERY_MS = 6 * 3600_000;
const LIST_MAX_BYTES = 64 * 1024 * 1024;
const FETCH_MS = 120_000;

// The list as a set of lower-case host names (comments, blanks and anything that isn't a host name
// left out; ASCII spaces around a name read as none): { size, has(host), close() }, iterable. The
// list holds about 400,000 names, so it is kept small: only a table of where each name starts in
// its file, searched by reading the few bytes of a name from the file (the file stays open, so a
// newer list renamed over it changes nothing for this one). Built a piece of the file at a time,
// with one table sized from the file's line count: nothing as large as the file is ever held, and
// nothing is left for the collector afterwards. (A Set of names took about 40 MB of the helper's
// heap; the file's bytes in memory plus the table about 15 MB; this keeps 2 MB.)
const CHUNK = 64 * 1024;
const FP_SHIFT = 27; // a slot: a name's start plus one in its low 27 bits, 5 bits of its hash above
const MAX_AT = (1 << FP_SHIFT) - 1;
// FNV-1a over a name's lowered characters, kept to 30 bits: numbers that small cost the engine no
// allocation, so reading the list makes no garbage. Bits 25 to 29 are a slot's 5 bits of hash.
const HASH_START = 0x811c9dc5 & 0x3fffffff;
const step = (h, c) => Math.imul(h ^ c, 0x01000193) & 0x3fffffff;
const FP = 25;
const lowered = (c) => (c >= 65 && c <= 90 ? c + 32 : c);
// A name's character: a-z, 0-9, "." or "-" (upper case is lowered first).
const nameChar = (c) => (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 46 || c === 45;
const space = (c) => c === 32 || (c >= 9 && c <= 13);

// Where the list's bytes are: a file (kept open) or bytes in memory (tests, short lists).
function fileSource(path) {
  const fd = openSync(path, "r");
  try { return { size: fstatSync(fd).size, read: (into, at, n) => readSync(fd, into, 0, n, at), close: () => { try { closeSync(fd); } catch {} } }; }
  catch (e) { closeSync(fd); throw e; }
}
function bytesSource(bytes) {
  return { size: bytes.length, read: (into, at, n) => bytes.copy(into, 0, at, Math.min(at + n, bytes.length)), close: () => {} };
}

// input: a file's path ({ file }), or the list's bytes or text.
export function parseList(input) {
  const src = input && typeof input === "object" && !Buffer.isBuffer(input) && input.file ? fileSource(input.file)
    : bytesSource(Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ""), "utf8"));
  try { return build(src); } catch (e) { src.close(); throw e; }
}

function build(src) {
  if (src.size > MAX_AT) throw new Error("the list is larger than expected");
  const buf = Buffer.allocUnsafe(CHUNK), near = Buffer.allocUnsafe(CHUNK + 1);
  // The table: a power of two, at least a third more slots than the file has lines (a name is a
  // line), so it is never more than three quarters full.
  let lines = 1;
  for (let at = 0; at < src.size;) {
    const n = src.read(buf, at, CHUNK);
    if (n <= 0) break;
    for (let i = 0; i < n; i++) if (buf[i] === 10) lines++;
    at += n;
  }
  let cap = 1024;
  while (cap < lines + Math.ceil(lines / 3)) cap *= 2;
  const mask = cap - 1, slots = new Uint32Array(cap);
  let size = 0;
  // Whether the name starting at `start` in the source is the one read by name(from + i), i < len
  // (lowered): its bytes, lowered, and the byte after it not a name's character.
  const same = (start, name, from, len) => {
    const n = src.read(near, start, len + 1);
    if (n < len) return false;
    for (let i = 0; i < len; i++) if (lowered(near[i]) !== name(from + i)) return false;
    return n === len || !nameChar(lowered(near[len]));
  };
  // The slot holding that name (hash h), or the empty one where it would go.
  const slotOf = (h, name, from, len) => {
    const fp = h >>> FP;
    let slot = h & mask;
    for (let e = slots[slot]; e !== 0; e = slots[slot]) {
      if (e >>> FP_SHIFT === fp && same((e & MAX_AT) - 1, name, from, len)) return slot;
      slot = (slot + 1) & mask;
    }
    return slot;
  };
  const inBuf = (i) => lowered(buf[i]);
  // The line buf[a] to buf[b - 1], buf[0] being the source's byte `at`: kept if it is a host name.
  const addLine = (a, b, at) => {
    while (a < b && space(buf[a])) a++;
    while (b > a && space(buf[b - 1])) b--;
    if (a === b) return;
    let dot = false, h = HASH_START;
    for (let i = a; i < b; i++) { const c = lowered(buf[i]); if (!nameChar(c)) return; if (c === 46) dot = true; h = step(h, c); }
    if (!dot) return;
    const slot = slotOf(h, inBuf, a, b - a);
    if (slots[slot] === 0) { slots[slot] = ((h >>> FP) << FP_SHIFT) | (at + a + 1); size++; }
  };
  for (let pos = 0; pos < src.size;) {
    const n = src.read(buf, pos, CHUNK);
    if (n <= 0) break;
    let a = 0;
    for (let i = 0; i < n; i++) if (buf[i] === 10) { addLine(a, i, pos); a = i + 1; }
    if (pos + n >= src.size) { addLine(a, n, pos); break; }
    if (a > 0) { pos += a; continue; }
    // A line longer than a piece read: no host name; go on after it.
    let at = pos + n, next = src.size;
    while (at < src.size && next === src.size) {
      const m = src.read(buf, at, CHUNK);
      if (m <= 0) break;
      for (let i = 0; i < m; i++) if (buf[i] === 10) { next = at + i + 1; break; }
      at += m;
    }
    pos = next;
  }
  const has = (host) => {
    const s = String(host ?? ""), len = s.length;
    if (!len || len > CHUNK) return false;
    let h = HASH_START;
    for (let i = 0; i < len; i++) { const c = lowered(s.charCodeAt(i)); if (!nameChar(c)) return false; h = step(h, c); }
    return slots[slotOf(h, (i) => lowered(s.charCodeAt(i)), 0, len)] !== 0;
  };
  // Every name, as a string (made only when asked).
  function* names() {
    for (const e of slots) {
      if (!e) continue;
      const n = src.read(near, (e & MAX_AT) - 1, CHUNK);
      let end = 0;
      while (end < n && nameChar(lowered(near[end]))) end++;
      yield near.toString("latin1", 0, end).toLowerCase();
    }
  }
  return { size, has, close: src.close, [Symbol.iterator]: names };
}

export function listedHost(list, host) {
  const h = String(host ?? "").toLowerCase().replace(/\.$/, "");
  return !!h && (list.has(h) || (h.startsWith("www.") && list.has(h.slice(4))));
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// The warning page, as a data: address. nonce: this warning's own word, kept in the page (a
// Continue anyway from it is known by it).
export function warningPage(url, host, nonce) {
  const html = `<!doctype html><meta charset="utf-8"><meta name="pb-warning" content="${nonce}"><title>Deceptive site ahead</title>
<body style="margin:0;font:16px/1.5 system-ui,-apple-system,sans-serif;background:#7A1F1F;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center">
<main style="max-width:560px;padding:32px"><h1 style="font-size:28px;margin:0 0 12px">Deceptive site ahead</h1>
<p><b>${esc(host)}</b> is on PairBrowse's phishing list (Phishing.Database): it may try to trick you into giving away a password, a card number or other details.</p>
<p><button onclick="history.back()" style="font:600 15px system-ui;padding:10px 18px;border-radius:8px;border:0;background:#fff;color:#7A1F1F;cursor:pointer">Go back</button></p>
<p style="font-size:13px;opacity:.85">Sure it's safe? <a href="${esc(url)}" target="_top" style="color:#fff">Continue anyway</a></p></main>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}


// One GET's response, once its headers are in: redirects followed (three at most, never from https
// to http). Node's own http(s) client, lighter than fetch's, loaded only where a download runs.
async function get(url, signal, hops = 3) {
  const u = new URL(url);
  const { request } = await import(u.protocol === "https:" ? "node:https" : "node:http");
  return new Promise((resolve, reject) => {
    const req = request(u, { signal, headers: { "user-agent": "PairBrowse" } }, (res) => {
      const where = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && where) {
        res.resume();
        let next;
        try { next = new URL(where, u); } catch { return reject(new Error("a bad redirect")); }
        if (!hops || !/^https?:$/.test(next.protocol) || (u.protocol === "https:" && next.protocol !== "https:")) return reject(new Error("a bad redirect"));
        return get(next.href, signal, hops - 1).then(resolve, reject);
      }
      resolve(res);
    });
    req.on("error", reject);
    req.end();
  });
}

// The list downloaded into the file `to` a piece at a time (the whole download is never held in
// memory); resolves to its size in bytes. A failure removes `to`.
export async function fetchList(url, { ms = FETCH_MS, to, max = LIST_MAX_BYTES } = {}) {
  const signal = AbortSignal.timeout(ms);
  mkdirSync(dirname(to), { recursive: true });
  let fd = null, done = false;
  try {
    const res = await get(url, signal);
    if (res.statusCode !== 200) { res.resume(); throw new Error(`HTTP ${res.statusCode}`); }
    fd = openSync(to, "w", 0o600);
    let bytes = 0;
    for await (const chunk of res) {
      bytes += chunk.byteLength;
      if (bytes > max) { res.destroy(); throw new Error("the list is larger than expected"); }
      writeSync(fd, chunk);
    }
    if (!res.complete) throw new Error("the download stopped");
    done = true;
    return bytes;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch {} }
    if (!done) rmSync(to, { force: true });
  }
}

// fetchList run in a short-lived process of its own: the memory its connection's buffers take goes
// with that process, instead of staying with the helper for the rest of its run (about 30 MB). It
// ends with the helper: killed when the helper exits, and on its own when the helper's end of its
// stdin closes (a helper that was killed), its unfinished file removed either way.
const SELF = fileURLToPath(import.meta.url);
const running = new Map(); // child -> the file it writes
let reaper = false;
export function downloadList(url, { ms = FETCH_MS, to, max = LIST_MAX_BYTES } = {}) {
  if (!reaper) {
    reaper = true;
    process.on("exit", () => { for (const [c, file] of running) { try { c.kill(); } catch {} rmSync(file, { force: true }); } });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SELF, "--download", url, to, String(max), String(ms)], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, timeout: ms + 10_000 });
    running.set(child, to);
    let out = "", err = "";
    child.stdout.on("data", (d) => { out = (out + d).slice(-100); });
    child.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    child.on("error", reject);
    child.on("close", (code) => {
      running.delete(child);
      if (code === 0) return resolve(Number(out) || 0);
      rmSync(to, { force: true });
      reject(new Error(err.trim().split("\n").pop() || `the download stopped (${code ?? "ended"})`));
    });
  });
}
if (process.argv[1] === SELF && process.argv[2] === "--download") {
  const [url, to, max, ms] = process.argv.slice(3);
  const gone = () => { rmSync(to, { force: true }); process.exit(1); }; // the helper ended: nobody takes the file
  process.stdin.once("end", gone).once("error", gone).resume();
  const finish = () => { process.stdin.off("end", gone).off("error", gone); process.stdin.destroy(); };
  fetchList(url, { to, max: Number(max), ms: Number(ms) }).then((n) => { finish(); process.stdout.write(String(n)); }, (e) => { finish(); process.stderr.write(`${e?.message || e}\n`); process.exitCode = 1; });
}

// Downloads an ended helper left beside the list (its own pid in the name, that pid gone), and the
// older fixed name: removed, since nothing else ever takes them.
export function removeStaleDownloads(file) {
  const dir = dirname(file), base = `${basename(file)}.`;
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!n.startsWith(base) || !n.endsWith(".download")) continue;
    const mid = n.slice(base.length, -".download".length);
    if (mid === "" || (/^\d+$/.test(mid) && !pidAlive(Number(mid)))) rmSync(join(dir, n), { force: true });
  }
}

// file: where the list is kept. fetchText(url, { to }): downloads the list into the file `to`, or
// resolves to its bytes or text (written there for it). enabled(): config's switch. The list is read
// from its file when a navigation is first checked, not at start: a helper that never browses never
// reads it.
export function createPhishing({ file, enabled = () => true, fetchText = downloadList, log = () => {}, now = Date.now } = {}) {
  let list = null; // null: not read from its file yet
  let stamp = 0; // the file's time when it was read
  const allowed = new Set(); // hosts a person let through from a warning page
  const warned = new Map(); // host -> the nonce of its warning page
  let timer = null, fetching = null;
  const mtime = () => { try { return statSync(file).mtimeMs; } catch { return 0; } };
  const swap = (next, at) => { list?.close(); list = next; stamp = at; };
  const load = () => {
    let next = null;
    const at = mtime();
    try { next = parseList({ file }); } catch {}
    if (next) swap(next, at); else list ??= parseList("");
    return list.size;
  };
  const current = () => (list ? list : (load(), list));
  async function refresh(force = false) {
    if (!enabled() || fetching) return fetching;
    const at = mtime();
    if (!force && at && now() - at < LIST_EVERY_MS) {
      if (list && at !== stamp) { list.close(); list = null; } // another helper on this computer updated it: read anew on next use
      return null;
    }
    fetching = (async () => {
      const to = `${file}.${process.pid}.download`;
      let next = null;
      try {
        const got = await fetchText(LIST_URL, { to });
        if (typeof got === "string" || Buffer.isBuffer(got)) { mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, got); }
        next = parseList({ file: to });
        if (next.size < 1000) throw new Error(`only ${next.size} names`);
        try { renameSync(to, file); } catch { list?.close(); list = null; renameSync(to, file); } // where a file in use can't be replaced
        swap(next, mtime());
        log(`phishing list: ${next.size} sites`);
        next = null;
      } catch (e) {
        next?.close();
        const kept = current().size;
        log(`phishing list: not updated (${e?.message || e}); ${kept ? `the last one (${kept} sites) stays` : "none yet"}`);
      } finally { rmSync(to, { force: true }); fetching = null; }
    })();
    return fetching;
  }
  function start() {
    removeStaleDownloads(file);
    refresh().catch(() => {});
    timer = setInterval(() => refresh().catch(() => {}), 3600_000);
    timer.unref?.();
  }
  const listed = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) && listedHost(current(), u.hostname); } catch { return false; } };
  function onRequest(req) {
    try {
      if (!enabled() || !req.isNavigationRequest()) return;
      const frame = req.frame();
      const page = frame.page();
      if (frame !== page.mainFrame()) return;
      const url = req.url();
      if (!listed(url)) return;
      const host = new URL(url).hostname.toLowerCase();
      if (allowed.has(host)) return;
      const nonce = warned.get(host);
      if (nonce && frame.url().includes(nonce)) { allowed.add(host); log(`phishing list: ${host} let through from its warning`); return; }
      const n = randomBytes(12).toString("hex");
      warned.set(host, n);
      log(`phishing list: ${host} stopped`);
      page.goto(warningPage(url, host, n)).catch(() => {});
    } catch {}
  }
  const watch = (ctx) => { ctx.on("request", onRequest); };
  return { start, refresh, load, listed, watch, onRequest, size: () => current().size, close: () => { clearInterval(timer); list?.close(); list = null; } };
}
