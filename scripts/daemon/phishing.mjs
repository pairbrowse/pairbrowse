// Phishing protection: Phishing.Database's list of active phishing domains (MIT licence),
// downloaded over HTTPS every LIST_EVERY_MS into paths.phishingList and checked on this computer by
// exact host (a "www." in front counts too): nothing about what is browsed leaves the computer. A
// top-level navigation to a listed host, a person's or an agent's, is stopped before its page shows:
// a warning page takes its place, with Go back and a Continue anyway that only a click on that
// page itself gives (it lets that host through for the rest of the helper's run). Agents can't
// press it: their hands work only in web tabs (policy.mjs isWebTab). Off with
// config.phishingProtection false. Lists only reported sites, by domain; no malware list.
import { readFileSync, statSync, mkdirSync, writeFileSync, renameSync, openSync, writeSync, closeSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export const LIST_URL = "https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-domains-ACTIVE.txt";
export const LIST_EVERY_MS = 6 * 3600_000;
const LIST_MAX_BYTES = 64 * 1024 * 1024;
const FETCH_MS = 120_000;

// The list (its file's bytes, or its text) as a set of lower-case host names (comments, blanks
// and anything that isn't a host name left out; ASCII spaces around a name read as none):
// { size, has(host) }, iterable. Kept compact, since the list holds about 400,000 names: the file's bytes
// and a hash table of where each name starts in them, built and searched a byte at a time, so no
// string is made per name. (A Set of them took about 40 MB of the helper's heap, and making it
// about 120 MB more memory that the process kept; this keeps about 15 MB, outside the heap.)
const space = (c) => c === 32 || (c >= 9 && c <= 13);
const lower = (c) => (c >= 65 && c <= 90 ? c + 32 : c);
// A name's character: a-z, 0-9, "." or "-" (upper case read as lower).
const nameChar = (c) => (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 46 || c === 45;
// FNV-1a over the lower-cased characters at(i) for i from `a` to `b`.
const hashOf = (at, a, b) => { let h = 0x811c9dc5; for (let i = a; i < b; i++) h = Math.imul(h ^ lower(at(i)), 0x01000193); return h >>> 0; };
export function parseList(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ""), "utf8");
  const byte = (i) => bytes[i];
  // Each name's start in bytes, plus one (0: an empty slot), at slot (hash & mask), else the slots
  // after it. A kept name ends at the first byte after it that isn't a name's character.
  let mask = 1023, slots = new Uint32Array(1024), size = 0;
  const same = (slot, at, a, b) => {
    const start = slots[slot] - 1;
    for (let i = 0; i < b - a; i++) if (lower(bytes[start + i] ?? 0) !== lower(at(a + i))) return false;
    const next = start + b - a;
    return next >= bytes.length || !nameChar(lower(bytes[next]));
  };
  // The slot holding the name at(a) to at(b - 1), or the empty one where it would go.
  const slotOf = (at, a, b) => { let slot = hashOf(at, a, b) & mask; while (slots[slot] && !same(slot, at, a, b)) slot = (slot + 1) & mask; return slot; };
  const end = (start) => { let i = start; while (i < bytes.length && nameChar(lower(bytes[i]))) i++; return i; };
  const grow = () => {
    const old = slots;
    mask = mask * 2 + 1; slots = new Uint32Array(mask + 1);
    for (const at of old) if (at) slots[slotOf(byte, at - 1, end(at - 1))] = at;
  };
  for (let start = 0; start < bytes.length;) {
    let stop = bytes.indexOf(10, start);
    if (stop < 0) stop = bytes.length;
    let a = start, b = stop;
    while (a < b && space(bytes[a])) a++;
    while (b > a && space(bytes[b - 1])) b--;
    let ok = b > a, dot = false;
    for (let i = a; ok && i < b; i++) { const c = lower(bytes[i]); ok = nameChar(c); dot ||= c === 46; }
    if (ok && dot) {
      const slot = slotOf(byte, a, b);
      if (!slots[slot]) { slots[slot] = a + 1; size++; if (size * 2 > mask) grow(); }
    }
    start = stop + 1;
  }
  const has = (host) => {
    const h = String(host ?? "");
    if (!h.length) return false;
    const at = (i) => h.charCodeAt(i);
    return slots[slotOf(at, 0, h.length)] !== 0;
  };
  // Every name, as a string (made only when asked).
  function* names() { for (const at of slots) if (at) yield bytes.toString("latin1", at - 1, end(at - 1)).toLowerCase(); }
  return { size, has, [Symbol.iterator]: names };
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

// The list's bytes, downloaded a piece at a time into the file `to` (removed after) and read back
// from it: the whole download is never held in memory at once, which kept about 50 MB more of the
// helper's memory for the rest of its run.
export async function fetchList(url, { ms = FETCH_MS, to, max = LIST_MAX_BYTES } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  mkdirSync(dirname(to), { recursive: true });
  let fd = openSync(to, "w", 0o600);
  try {
    let bytes = 0;
    for await (const chunk of res.body) {
      bytes += chunk.byteLength;
      if (bytes > max) throw new Error("the list is larger than expected");
      writeSync(fd, chunk);
    }
    closeSync(fd);
    fd = null;
    return readFileSync(to);
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch {} }
    rmSync(to, { force: true });
  }
}

// file: where the list is kept. fetchText(url, { to }): the list's bytes or text (to: a file it may use
// on the way). enabled(): config's switch.
export function createPhishing({ file, enabled = () => true, fetchText = fetchList, log = () => {}, now = Date.now } = {}) {
  let list = parseList("");
  const allowed = new Set(); // hosts a person let through from a warning page
  const warned = new Map(); // host -> the nonce of its warning page
  let timer = null, fetching = null;
  const load = () => { try { list = parseList(readFileSync(file)); } catch {} return list.size; };
  const age = () => { try { return now() - statSync(file).mtimeMs; } catch { return Infinity; } };
  async function refresh(force = false) {
    if (!enabled() || fetching || (!force && age() < LIST_EVERY_MS)) return fetching;
    fetching = (async () => {
      try {
        const text = await fetchText(LIST_URL, { to: `${file}.download` });
        const next = parseList(text);
        if (next.size < 1000) throw new Error(`only ${next.size} names`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(`${file}.tmp`, text);
        renameSync(`${file}.tmp`, file);
        list = next;
        log(`phishing list: ${next.size} sites`);
      } catch (e) { log(`phishing list: not updated (${e?.message || e}); ${list.size ? `the last one (${list.size} sites) stays` : "none yet"}`); }
      finally { fetching = null; }
    })();
    return fetching;
  }
  function start() {
    load();
    refresh().catch(() => {});
    timer = setInterval(() => refresh().catch(() => {}), 3600_000);
    timer.unref?.();
  }
  const listed = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) && listedHost(list, u.hostname); } catch { return false; } };
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
  return { start, refresh, load, listed, watch, onRequest, size: () => list.size, close: () => clearInterval(timer) };
}
