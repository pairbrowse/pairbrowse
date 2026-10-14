// The session's activity log: the bar's lines (hud.addActivity, liveview.mjs addActivity) for the
// whole session, not only the stream's latest 30, so the Activity page can page back through them
// (GET activity.json, owner only). Bounded: the last LOG_MAX lines, none older than LOG_AGE_MS.
// Each line is the one the stream sends ({ t, text, who, tab, tabId?, from? }: names and plain
// sentences, never a value typed or a secret), its text and tab passed through mask() (saved
// passwords) as well before they are kept. A kept session's log is an owner-only file in its
// folder (sessions.mjs activityFile, written whole through util.mjs writeJsonAtomic at each line:
// no timer), moved by a rename and removed with the session; a clean session's stays in memory.
// Times are unique and rising within a log (a line in the same millisecond as the last gets the
// next one), so `before` pages without losing a line on a boundary.
// A message between participants (pairbrowse_collaboration message, daemon/session.mjs) is a
// line too: { t, kind: "message", who (its sender), to (a label or "all"), text (up to 500,
// already redacted, masked again here), tab: "" }, interleaved with the others by time.
import { readJson, writeJsonAtomic } from "../util.mjs";

export const LOG_MAX = 2000;
export const LOG_AGE_MS = 7 * 86_400_000;
export const PAGE_MAX = 200;
export const PAGE_DEFAULT = 50;
const FILE_VERSION = 1;
const TAB_ID = /^[0-9a-f]{8}$/;

const MESSAGE_MAX = 500; // a message's text (session.mjs TEXT_MAX); other lines keep 200
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
// A line as it may be kept (from the stream's entry or the file), or null.
export function cleanLine(a) {
  if (!a || typeof a !== "object" || !Number.isSafeInteger(a.t) || a.t <= 0) return null;
  const message = a.kind === "message";
  const text = str(a.text, message ? MESSAGE_MAX : 200);
  if (!text || (message && !str(a.who, 60))) return null;
  return {
    t: a.t, text, who: str(a.who, 60), tab: str(a.tab, 80),
    ...(message ? { kind: "message", to: str(a.to, 60) || "all" } : {}),
    ...(typeof a.tabId === "string" && TAB_ID.test(a.tabId) ? { tabId: a.tabId } : {}),
    ...(str(a.from, 80) ? { from: str(a.from, 80) } : {}),
  };
}

// GET activity.json's query: before (epoch ms, lines strictly older; none: the newest) and limit
// (1..PAGE_MAX, more is PAGE_MAX; none: PAGE_DEFAULT). { before, limit } or { error }.
export function readPageQuery(params) {
  const b = params.get("before"), l = params.get("limit");
  if (b !== null && !/^\d{1,16}$/.test(b)) return { error: "before is a time in epoch milliseconds." };
  if (l !== null && !/^\d{1,6}$/.test(l)) return { error: `limit is a whole number from 1 to ${PAGE_MAX}.` };
  const limit = l === null ? PAGE_DEFAULT : Number(l);
  if (limit < 1) return { error: `limit is a whole number from 1 to ${PAGE_MAX}.` };
  return { before: b === null ? Infinity : Number(b), limit: Math.min(limit, PAGE_MAX) };
}

// where(): { name, file }: the open session's name and its log file (null: memory only, a clean
// session). Read at each call, so a session switch or rename reaches the right log: another
// name loads that session's file. mask(text): as results are masked. now(): the clock (tests).
export function createActivityLog({ where = () => ({ name: "", file: null }), mask = (t) => t, now = Date.now, max = LOG_MAX, maxAgeMs = LOG_AGE_MS, log = () => {} } = {}) {
  let name; // the session the lines below are for
  let file = null;
  let lines = []; // oldest first

  const trim = () => {
    const from = now() - maxAgeMs;
    let cut = 0;
    while (cut < lines.length && lines[cut].t < from) cut++;
    cut = Math.max(cut, lines.length - max);
    if (cut > 0) lines = lines.slice(cut);
  };
  function load(f) {
    const kept = readJson(f)?.lines;
    if (!Array.isArray(kept)) return [];
    const out = [];
    for (const a of kept) {
      const line = cleanLine(a);
      if (line && (!out.length || line.t > out.at(-1).t)) out.push(line);
    }
    return out;
  }
  function current() {
    let w = {};
    try { w = where() || {}; } catch {}
    const n = String(w.name ?? "");
    const f = typeof w.file === "string" && w.file ? w.file : null;
    if (n !== name || f !== file) {
      name = n;
      file = f;
      lines = f ? load(f) : [];
      trim();
    }
  }
  function save() {
    if (!file) return;
    try { writeJsonAtomic(file, { v: FILE_VERSION, lines }, { mode: 0o600 }); } catch (e) { log(`activity log: ${e?.message || e}`); }
  }

  return {
    // One line, as the stream has it; returns it with the time it was kept under (the stream
    // sends that time too, so the page's lines and the log's are the same), or null.
    add(entry) {
      current();
      const t0 = Number.isSafeInteger(entry?.t) ? entry.t : Math.trunc(now());
      const t = Math.max(t0, (lines.at(-1)?.t ?? 0) + 1);
      let text = entry?.text, tab = entry?.tab;
      try { text = mask(String(text ?? "")); tab = mask(String(tab ?? "")); } catch { return null; }
      const line = cleanLine({ ...entry, t, text, tab });
      if (!line) return null;
      lines.push(line);
      trim();
      save();
      return line;
    },
    // The lines older than `before`, newest first, at most `limit`; more: older ones are kept too.
    page({ before = Infinity, limit = PAGE_DEFAULT } = {}) {
      current();
      trim();
      let end = lines.length;
      while (end > 0 && lines[end - 1].t >= before) end--;
      const n = Math.max(1, Math.min(PAGE_MAX, Math.trunc(limit) || PAGE_DEFAULT));
      const start = Math.max(0, end - n);
      return { items: lines.slice(start, end).reverse(), more: start > 0, kept: { lines: max, days: Math.round(maxAgeMs / 86_400_000), saved: !!file } };
    },
    size: () => { current(); return lines.length; },
  };
}
