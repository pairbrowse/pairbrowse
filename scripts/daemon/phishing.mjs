// Phishing protection: Phishing.Database's list of active phishing domains (MIT licence),
// downloaded over HTTPS every LIST_EVERY_MS into paths.phishingList and checked on this computer by
// exact host (a "www." in front counts too): nothing about what is browsed leaves the computer. A
// top-level navigation to a listed host, a person's or an agent's, is stopped before its page shows:
// a warning page takes its place, with Go back and a Continue anyway that only a click on that
// page itself gives (it lets that host through for the rest of the helper's run). Agents can't
// press it: their hands work only in web tabs (policy.mjs isWebTab). Off with
// config.phishingProtection false. Lists only reported sites, by domain; no malware list.
import { readFileSync, statSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export const LIST_URL = "https://raw.githubusercontent.com/Phishing-Database/Phishing.Database/master/phishing-domains-ACTIVE.txt";
export const LIST_EVERY_MS = 6 * 3600_000;
const LIST_MAX_BYTES = 64 * 1024 * 1024;
const FETCH_MS = 120_000;

// The list's text as a Set of lower-case host names (comments, blanks and anything that isn't a
// host name left out).
export function parseList(text) {
  const out = new Set();
  for (const line of String(text ?? "").split("\n")) {
    const d = line.trim().toLowerCase();
    if (d && d.includes(".") && /^[a-z0-9.-]+$/.test(d)) out.add(d);
  }
  return out;
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

async function fetchList(url, ms = FETCH_MS) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > LIST_MAX_BYTES) throw new Error("the list is larger than expected");
  return text;
}

// file: where the list is kept. fetchText(url): the list's text. enabled(): config's switch.
export function createPhishing({ file, enabled = () => true, fetchText = fetchList, log = () => {}, now = Date.now } = {}) {
  let list = new Set();
  const allowed = new Set(); // hosts a person let through from a warning page
  const warned = new Map(); // host -> the nonce of its warning page
  let timer = null, fetching = null;
  const load = () => { try { list = parseList(readFileSync(file, "utf8")); } catch {} return list.size; };
  const age = () => { try { return now() - statSync(file).mtimeMs; } catch { return Infinity; } };
  async function refresh(force = false) {
    if (!enabled() || fetching || (!force && age() < LIST_EVERY_MS)) return fetching;
    fetching = (async () => {
      try {
        const text = await fetchText(LIST_URL);
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
