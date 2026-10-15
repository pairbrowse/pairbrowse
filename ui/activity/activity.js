// Activity (pairbrowse://activity in the PairBrowse browser, opened from the left dock's Activity
// row; activity/index.html served elsewhere): the session's activity lines as the helper sends them
// (its activity event: { t, who, tab, text, from? }, newest last, the helper's latest few), newest
// first, grouped by day; each with its time, who (an agent or a person, with the color the helper
// gives them on the board or in the collaboration), what (common.js rich: **bold** and `code` as
// text nodes, never markup) and the tab it was in (activityHead). A filter by who: All, each agent
// with a line here, People. Nothing is made up: a line is one the helper sent.
// Messages between participants (pairbrowse_collaboration message) are lines too, by time with
// the rest: in the log as { t, kind: "message", who (the sender), to (a label or "all"), text },
// live from the board event's messages ({ from, to, text, t }, the helper giving each the log's
// time, so the two are one line). Shown as "<sender> to <who>:" and the text, as text only (it is
// another participant's words, never markup), a long one clipped with "Show all".
// The session's history: GET activity.json (the helper's log of the session, newest first, a page
// at a time: { items, more, kept: { lines, days, saved } }) read when the stream goes live, and
// the next older page on "Show earlier"; merged with the stream's lines by the same key, so a line
// in both shows once. A helper without the route (404, an older one): the stream's lines alone.
// A tab page: in the browser only window.pairbrowse.session exists here, so nothing else is called.
// The stream's events (activity, board, collaboration) and that one route: no timer, no poll.
import { $, el, rich, clock, activityHead, isColor, helperConnection, enter, busy, NO_AGENT, noAgentLine } from "../common.js";
import { followHelper } from "../helper.js";

const KEPT = 3000; // lines this page keeps while open, newest (the helper's log holds 2,000)
const FIRST = 100; // lines in the first page of history
const EARLIER = 200; // lines per "Show earlier" (the route's most)
const DAY = 86_400_000;
const CLIP = 280; // a message's characters shown before "Show all" (the helper keeps up to 500)

let base = null;
let seq = 0; // arrival order, for lines with the same time
const lines = new Map(); // key -> { t, who, tab, text, from, kind, to, seq }
const unclipped = new Set(); // the keys of long messages shown whole
let board = [];
let collab = null;
let only = "all"; // "all", "people" or "agent:<who>"
let drawn = false; // the first draw only places the lines
let boardSeen = false; // the stream's first board since it went live: its messages only placed
// The history read so far: older (the oldest time read, the next page's before), more (the helper
// has older lines), kept (what it says it keeps), or null before the first answer or without one.
let history = null;
let loading = null; // the history request out now

// ---- who is who: the helper's board says agent or person; else the collaboration's owner and
// joiners are people; any other named line is an agent's ----
const text = (v) => (typeof v === "string" ? v.trim() : "");
function people() {
  const set = new Set();
  for (const p of board) if (p?.kind === "person" && text(p.who)) set.add(text(p.who));
  if (text(collab?.owner?.label)) set.add(text(collab.owner.label));
  for (const g of Array.isArray(collab?.guests) ? collab.guests : []) if (text(g?.label)) set.add(text(g.label));
  for (const p of board) if (p?.kind === "agent" && text(p.who)) set.delete(text(p.who));
  return set;
}
function colorOf(who) {
  const b = board.find((p) => text(p?.who) === who && isColor(p.color));
  if (b) return b.color;
  const g = (Array.isArray(collab?.guests) ? collab.guests : []).find((x) => text(x?.label) === who && isColor(x.color));
  return g ? g.color : "";
}

// ---- the lines ----
// A message is one by its time and sender (the log's times are unique; the board's copy has the
// log's time, its text maybe masked differently).
const keyOf = (a) => (a.kind === "message" ? ["message", a.t, a.who] : [a.t, a.who, a.tab, a.text, a.from]).join("\u0000");
function take(list, { quiet = false } = {}) {
  if (!Array.isArray(list)) return;
  for (const a of list) {
    if (!a || typeof a !== "object" || !Number.isFinite(a.t) || typeof a.text !== "string" || !a.text) continue;
    const message = a.kind === "message";
    if (message && !text(a.who)) continue;
    const line = { t: a.t, who: text(a.who), tab: message ? "" : text(a.tab), text: a.text, from: message ? "" : text(a.from), ...(message ? { kind: "message", to: text(a.to) || "all" } : {}) };
    const k = keyOf(line);
    if (!lines.has(k)) lines.set(k, { ...line, seq: seq++ });
  }
  // Only the newest KEPT stay.
  if (lines.size > KEPT) for (const [k] of [...lines].sort((x, y) => x[1].t - y[1].t || x[1].seq - y[1].seq).slice(0, lines.size - KEPT)) { lines.delete(k); unclipped.delete(k); }
  draw({ quiet });
}
// The board's messages ({ from, to, text, t }) as lines.
const boardMessages = (list) => (Array.isArray(list) ? list : []).map((m) => (m && typeof m === "object" ? { t: m.t, kind: "message", who: m.from, to: m.to, text: m.text } : null));

// "Today", "Yesterday", else the day's date, worked out when drawn (nothing ticks).
function dayName(t, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= start) return "Today";
  if (t >= start - DAY) return "Yesterday";
  const d = new Date(t);
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

function row(a, isPerson) {
  const dot = el("span", { className: "dot" });
  dot.setAttribute("aria-hidden", "true");
  const color = a.who ? colorOf(a.who) : "";
  if (color) dot.style.background = color;
  else if (!a.who) dot.classList.add("none");
  const head = activityHead(a);
  const what = a.kind === "message" ? said(a) : el("span", { className: "what" }, ...(head ? [el("strong", { className: "who", textContent: `${head}: ` })] : []), rich(a.text));
  const time = el("time", { dateTime: new Date(a.t).toISOString(), textContent: clock(a.t) });
  const li = el("li", {}, time, dot, what);
  li.dataset.key = keyOf(a);
  li.dataset.kind = !a.who ? "" : isPerson ? "person" : "agent";
  if (a.kind === "message") li.dataset.type = "message";
  if (a.who) li.dataset.who = a.who;
  return li;
}

// A message: "<sender> to <who>: " and its words as one text node (no rich(): nothing in another
// participant's words is styled); past CLIP, cut with "Show all" / "Show less".
function said(a) {
  const k = keyOf(a);
  const long = a.text.length > CLIP;
  const whole = !long || unclipped.has(k);
  const words = el("span", { className: "said", textContent: whole ? a.text : `${a.text.slice(0, CLIP).trimEnd()}…` });
  const what = el("span", { className: "what" }, el("strong", { className: "who", textContent: `${a.who} to ${a.to === "all" ? "everyone" : a.to}: ` }), words);
  if (long) {
    const b = el("button", { type: "button", className: "clip", textContent: whole ? "Show less" : "Show all" });
    b.setAttribute("aria-expanded", String(whole));
    b.addEventListener("click", () => {
      const open = !unclipped.has(k);
      if (open) unclipped.add(k); else unclipped.delete(k);
      words.textContent = open ? a.text : `${a.text.slice(0, CLIP).trimEnd()}…`;
      b.textContent = open ? "Show less" : "Show all";
      b.setAttribute("aria-expanded", String(open));
    });
    what.append(" ", b);
  }
  return what;
}

function chips(agents, anyPerson) {
  const want = [["all", "All"], ...agents.map((w) => [`agent:${w}`, w]), ...(anyPerson ? [["people", "People"]] : [])];
  if (!want.some(([k]) => k === only)) only = "all";
  const box = $("filter");
  const had = box.contains(document.activeElement) ? document.activeElement.dataset.only : "";
  box.replaceChildren(...want.map(([k, label]) => {
    const b = el("button", { type: "button", className: "chip", textContent: label });
    b.dataset.only = k;
    b.setAttribute("aria-pressed", String(k === only));
    b.addEventListener("click", () => { only = k; draw(); $("filter").querySelector(`[data-only="${CSS.escape(k)}"]`)?.focus(); });
    return b;
  }));
  if (had) box.querySelector(`[data-only="${CSS.escape(had)}"]`)?.focus();
  box.hidden = want.length < 2 || !lines.size;
}

function draw({ quiet = false } = {}) {
  if (document.body.dataset.s === "none") return;
  const known = new Set([...$("log").querySelectorAll("li[data-key]")].map((li) => li.dataset.key));
  const persons = people();
  const all = [...lines.values()].sort((x, y) => y.t - x.t || y.seq - x.seq);
  const isPerson = (a) => !!a.who && persons.has(a.who);
  // The agents with a line here, the newest first; People when a person has one.
  const agents = [...new Set(all.filter((a) => a.who && !isPerson(a)).map((a) => a.who))];
  chips(agents, all.some(isPerson));
  const shown = all.filter((a) => only === "all" || (only === "people" ? isPerson(a) : a.who === only.slice(6) && !isPerson(a)));
  const days = [];
  for (const a of shown) {
    const k = dayKey(a.t);
    if (days.at(-1)?.k !== k) days.push({ k, t: a.t, items: [] });
    days.at(-1).items.push(a);
  }
  const fresh = [];
  $("log").replaceChildren(...days.map((d, i) => {
    const id = `day-${i}`;
    const rows = d.items.map((a) => { const li = row(a, isPerson(a)); if (!known.has(li.dataset.key)) fresh.push(li); return li; });
    const ol = el("ol", { className: "lines" }, ...rows);
    ol.setAttribute("aria-labelledby", id);
    return el("section", { className: "day" }, el("h2", { id, textContent: dayName(d.t) }), ol);
  }));
  $("empty").hidden = shown.length > 0;
  $("note").textContent = noteText();
  $("note").hidden = !lines.size;
  $("earlier").hidden = !history?.more || !lines.size;
  // A line that came in while the page was open grows in at the top (common.js enter: none under
  // reduced motion or while hidden); the first draw, a filter change and history only place them.
  if (drawn && !quiet) for (const li of fresh) enter(li);
  drawn = true;
}

// What the helper keeps, as it says (activity.json's kept); before an answer, or without the
// route, only what this page saw.
const count = (n) => n.toLocaleString("en-US");
function noteText() {
  const k = history?.kept;
  if (!k || !Number.isFinite(k.lines) || !Number.isFinite(k.days)) return "Showing the actions PairBrowse sent while this page was open.";
  const span = `last ${count(k.lines)} actions, up to ${count(k.days)} ${k.days === 1 ? "day" : "days"}`;
  return k.saved ? `PairBrowse keeps this session's ${span}, on this computer only.` : `A clean session's actions are kept while PairBrowse runs: the ${span}.`;
}

// ---- the history (GET activity.json) ----
// One page: the lines older than `before` (none: the newest). -> true when it was read.
async function readHistory(before, limit) {
  const from = base;
  const q = `limit=${limit}${before ? `&before=${before}` : ""}`;
  const r = await fetch(`${from}activity.json?${q}`, { signal: AbortSignal.timeout(8000) }).then(async (x) => ({ status: x.status, body: x.ok ? await x.json().catch(() => null) : null }), () => ({ status: 0, body: null }));
  if (from !== base) return false; // another helper meanwhile: its own lines
  const b = r.body;
  if (!b || !Array.isArray(b.items)) {
    if (r.status !== 404) say("PairBrowse didn't send the earlier actions. Try again.");
    return false;
  }
  const times = b.items.map((a) => a?.t).filter(Number.isFinite);
  const oldest = times.length ? Math.min(...times) : null;
  const kept = b.kept && typeof b.kept === "object" ? b.kept : history?.kept || null;
  // A newer page (the stream came back) never moves the cursor back up or forgets older ones.
  if (!history || before || history.older === null) history = { older: oldest ?? history?.older ?? null, more: !!b.more, kept };
  else history = { ...history, kept };
  say("");
  take(b.items, { quiet: true });
  return true;
}
function loadNewest() {
  if (loading || !base) return;
  loading = readHistory(null, FIRST).finally(() => { loading = null; });
}
function showEarlier() {
  const btn = $("earlier");
  if (loading || !history?.more || history.older === null) return;
  loading = busy(btn, () => readHistory(history.older, EARLIER)).finally(() => { loading = null; });
  loading.then(() => {
    // The last page read: the button goes, the focus to the oldest line now shown.
    if (btn.hidden && (document.activeElement === btn || document.activeElement === document.body)) {
      const last = [...$("log").querySelectorAll("li")].at(-1);
      if (last) { last.tabIndex = -1; last.focus(); }
    }
  });
}
$("earlier").addEventListener("click", showEarlier);

// ---- the helper ----
function none() {
  document.body.dataset.s = "none";
  $("sub").textContent = `${NO_AGENT}. ${noAgentLine("The session's actions")}`;
  $("log").replaceChildren();
  $("filter").hidden = true;
  $("empty").hidden = true;
  $("note").hidden = true;
  $("earlier").hidden = true;
}
const say = (t) => { $("msg").textContent = t; };
const SUB = $("sub").textContent;
// The helper's stream, one per address (stream.js helperConnection).
const connect = helperConnection({
  onState: (s) => {
    // Live (first, or back after a drop): the newest page of the log, which also covers what
    // the stream said while it was away (it sends only its latest 30).
    if (s === "live") { boardSeen = false; document.body.dataset.s = "live"; $("sub").textContent = SUB; say(""); draw(); loadNewest(); }
    else if (s === "closed") none();
    else if (document.body.dataset.s !== "none") document.body.dataset.s = "connecting";
  },
}, (stream, url, was) => {
  // Another helper (a restart, another key): its lines are its own.
  if (was) { lines.clear(); unclipped.clear(); drawn = false; }
  history = null;
  loading = null;
  base = url;
  stream.on("activity", take);
  stream.on("board", (b) => {
    board = Array.isArray(b?.people) ? b.people : [];
    const quiet = !boardSeen;
    boardSeen = true;
    take(boardMessages(b?.messages), { quiet });
  });
  stream.on("collaboration", (c) => { collab = c && typeof c === "object" ? c : null; draw(); });
});
// The helper's address (ui/helper.js), and each new one the extension's worker stores.
followHelper({ connect, none });
