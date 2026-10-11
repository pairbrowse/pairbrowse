// The approval card as a page: the bubble the PairBrowse browser shows when no web page is in
// front (DESIGN.md B6); the in-page card stays scripts/hud.js's. One source for two hosts: with
// window.pairbrowse (the native build) the helper's address comes from session.helper();
// otherwise from chrome.storage.session "view" (the extension).
//
// Data contract with the helper (lane H builds scripts/liveview.mjs to this shape;
// test/fixtures/ui-approve.json and test/ui-approve.test.mjs pin it):
//   GET <base>approvals.json -> { pending: Item[] } (owner key; 404 or a failure = none pending,
//     the stream then carries everything).
//   SSE <base>events?panel=1&page=approve (the shared stream, common.js helperStream):
//     event "approval" { op: "add", item: Item } | { op: "withdraw", item: { id } };
//     event "driving" { on: boolean } (an agent's input is under way: no answer counts while on);
//     events "join" (Request[] as joins.json), "dev" ({ asks: [{ id, who, port }] }) and
//     "joinhost" ({ asks: [{ id, host, who }] }) exactly as the side panel receives them.
//   POST <base>approve { id, answer: "allow" | "deny" | "site" | "terminal" } -> 200 { ok: true }
//     | 404 (gone: answered elsewhere or timed out); a body with `answer` is a click approval,
//     { id, allow } stays the join answer and { id, remove } the removal, as today.
//   POST <base>dev { op: "answer", id, allow } and POST <base>joinhost { op: "allow", id, always }
//     | { op: "cancel", id }: unchanged routes.
//   Item = { id: string, agent: { label: string, color: "#rrggbb" }, kind: "click",
//     target: string (the button's label with its glyph), reason: string (the click rule's
//     reason as the helper sends it; empty hides the line), tab: { id: number, host: string },
//     at: number (ms epoch; the oldest shows first) }.
// The page sets body[data-pending] to the number of open requests and body[data-driving]; the
// bubble host reads nothing else.
//
// Gating, as the in-page join card (scripts/hud.js joinWire/joinWatch): trusted events only;
// Allow-type answers by a pointer click (detail > 0), Deny-type answers by any trusted click (so
// Enter on the focused Deny works); nothing while an agent drives; and only ARM_MS after
// IntersectionObserver v2 reports the card fully visible. The observer lives only while a card
// shows and the page is visible. No timer: arming is a timestamp compared at click time. The
// helper checks the answer again.
import { $, el, avatar, splitLabel, helperStream } from "../common.js";

const ARM_MS = 600;
const POINTER = new Set(["allow", "site", "always"]);
const SAY = {
  driving: "An agent is acting in the browser: wait, then click again.",
  key: "Allow with a click: a key press can't allow.",
  early: "Not yet: the card just appeared. Click again.",
  covered: "Something is over the card: answer in the terminal.",
  offline: "Not connected to PairBrowse yet.",
  gone: "That request is gone (answered, or it timed out).",
  failed: "Couldn't reach PairBrowse. Try again.",
};

let base = null;
let items = [];              // normalized requests, insertion order
const ats = new Map();       // key -> first-seen ms
const dismissed = new Set(); // keys hidden here; the request stays for the terminal and the dock
let shownKey = "";
let seen = null;             // the IntersectionObserver, only while a card shows and the page is visible
let visibleSince = 0;        // performance.now() when the card was last reported fully visible; 0: not
let covered = false;         // the observer has reported the card not fully visible
let driving = false;
let busy = false;

const card = $("card"), menu = $("menu"), more = $("more");

// ---- the helper's address and stream ----
async function findBase() {
  const pb = globalThis.pairbrowse;
  if (typeof pb?.session?.helper === "function") {
    try {
      const { origin, key } = (await pb.session.helper()) || {};
      return origin && key ? `${origin}/${key}/` : null;
    } catch { return null; }
  }
  try { return (await globalThis.chrome?.storage?.session?.get("view"))?.view || null; } catch { return null; }
}

let stream = null; // the shared helper stream (common.js helperStream)
function connect(url) {
  if (!url || url === base) return;
  stream?.close();
  base = url;
  // panel=1 always (common.js): the bubble is never a viewer. approvals.json is the snapshot on each open.
  stream = helperStream(base, { kind: "approve", onState: (s) => { document.body.dataset.s = s; }, onOpen: () => load() });
  const on = stream.on;
  on("approval", (d) => {
    const id = d?.item?.id;
    if (typeof id !== "string" || !id) return;
    if (d.op === "add") upsert(normalize("click", d.item));
    else if (d.op === "withdraw") { items = items.filter((it) => it.key !== `click:${id}`); prune(); }
    draw();
  });
  on("driving", (d) => {
    driving = !!d?.on;
    document.body.dataset.driving = String(driving);
    hint(driving ? SAY.driving : "");
  });
  on("join", (d) => {
    replace("join", (Array.isArray(d) ? d : []).filter((r) => r && r.id && (!r.state || r.state === "pending")));
  });
  on("dev", (d) => replace("dev", d?.asks));
  on("joinhost", (d) => replace("host", d?.asks));
}

// The pending clicks from approvals.json; a 404 or a failure leaves the list as the stream made it.
async function load() {
  try {
    const r = await fetch(base + "approvals.json");
    if (!r.ok) return;
    const d = await r.json();
    if (!Array.isArray(d?.pending)) return;
    replace("click", d.pending);
  } catch {}
}

// ---- items ----
function normalize(kind, raw) {
  const key = `${kind}:${raw.id}`;
  if (!ats.has(key)) ats.set(key, Date.now());
  const it = { key, kind, id: raw.id, who: "", color: "", verb: "", target: "", host: "", reason: "", labels: {}, menu: [], at: ats.get(key) };
  if (kind === "click") {
    Object.assign(it, {
      who: String(raw.agent?.label || "Claude"), color: raw.agent?.color || "", verb: "wants to click",
      target: String(raw.target || ""), host: raw.tab?.host ? String(raw.tab.host) : "", reason: String(raw.reason || ""),
      menu: [{ answer: "site", label: raw.tab?.host ? `Allow for ${raw.tab.host}` : "Allow for this site" }, { answer: "terminal", label: "Ask in the terminal only" }],
      at: Number(raw.at) || it.at,
    });
  } else if (kind === "join") {
    Object.assign(it, {
      who: `${raw.name || "Someone"}${raw.app ? ` (${raw.app})` : ""}`, verb: "wants to join",
      target: raw.role === "drive" ? "Shared browser, can drive" : "Watch only",
    });
  } else if (kind === "dev") {
    Object.assign(it, { who: String(raw.who || "An agent"), verb: "wants to share a dev server", target: `localhost:${Number(raw.port)}`, reason: "With the people in your session." });
  } else if (kind === "host") {
    const host = String(raw.host);
    Object.assign(it, {
      verb: "Join through another address?", target: host,
      reason: `This code leads to ${host}, not a PairBrowse address.` + (raw.who ? ` The code came from ${raw.who}. Only you can allow an address.` : ""),
      labels: { allow: "Allow once", deny: "Cancel" }, menu: [{ answer: "always", label: "Always allow" }],
    });
  }
  return it;
}
const valid = (raw) => raw && (typeof raw.id === "string" || typeof raw.id === "number") && String(raw.id) !== "";
function upsert(it) {
  const i = items.findIndex((x) => x.key === it.key);
  if (i >= 0) items[i] = it; else items.push(it);
}
// Every item of one kind, replaced by list's entries.
function replace(kind, list) {
  const next = (Array.isArray(list) ? list : []).filter(valid).map((raw) => normalize(kind, raw));
  items = [...items.filter((it) => it.kind !== kind), ...next];
  prune();
  draw();
}
// First-seen stamps and dismissals of requests the helper no longer lists.
function prune() {
  for (const k of ats.keys()) if (!items.some((it) => it.key === k)) { ats.delete(k); dismissed.delete(k); }
}
const current = () => items.find((it) => it.key === shownKey) || null;

// ---- drawing ----
function hint(text, kind = "") { const h = $("hint"); h.textContent = text; h.dataset.kind = kind; }
const buttons = () => [...card.querySelectorAll(".act button, .menu button")];
function closeMenu() { menu.hidden = true; more.setAttribute("aria-expanded", "false"); }

function draw() {
  const open = items.map((it, i) => [it, i]).filter(([it]) => !dismissed.has(it.key))
    .sort((a, b) => a[0].at - b[0].at || a[1] - b[1]).map(([it]) => it);
  document.body.dataset.pending = String(open.length);
  const it = open[0];
  $("empty").hidden = !!it;
  card.hidden = !it;
  if (!it) { shownKey = ""; busy = false; watch(false); return; }
  const n = open.length - 1, count = $("count");
  count.hidden = !n;
  count.textContent = n ? `${n} more` : "";
  if (n) count.setAttribute("aria-label", `${n} more waiting`); else count.removeAttribute("aria-label");
  if (it.key === shownKey) return;

  shownKey = it.key;
  busy = false;
  hint("");
  card.dataset.kind = it.kind;
  const slot = $("avatar-slot");
  slot.hidden = it.kind === "host";
  slot.replaceChildren(...(it.kind === "host" ? [] : [avatar(splitLabel(it.who).name, it.color)]));
  $("who").textContent = it.who;
  $("verb").textContent = it.verb;
  $("target").textContent = it.target;
  // The tab's host is the target's title, not a visible line (the compact header); #host, visually
  // hidden, gives it to readers through the card's description.
  $("target").title = it.host ? `In the tab on ${it.host}` : "";
  $("host").textContent = it.host ? `In the tab on ${it.host}` : "";
  $("reason").textContent = it.reason;
  $("reason").hidden = !it.reason;
  $("allow").textContent = it.labels.allow || "Allow";
  $("deny").textContent = it.labels.deny || "Deny";
  more.hidden = !it.menu.length;
  closeMenu();
  menu.replaceChildren(...it.menu.map((m) => {
    const b = el("button", { type: "button", textContent: m.label });
    b.dataset.answer = m.answer;
    b.addEventListener("click", (ev) => answer(m.answer, ev));
    return b;
  }));
  for (const b of buttons()) b.disabled = false;
  // What a click lands on changed: watched afresh, armed again only once seen whole.
  watch(false);
  watch(true);
  card.focus({ preventScroll: true }); // the card itself (tabindex -1): no stray Enter answers anything
}

// ---- visibility and gating ----
function watch(on) {
  if (!on || document.hidden) { seen?.disconnect(); seen = null; visibleSince = 0; covered = false; return; }
  if (seen) return;
  try {
    seen = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const v = "isVisible" in en ? en.isVisible : en.isIntersecting;
        covered = !v;
        if (!v) visibleSince = 0;
        else if (!visibleSince) visibleSince = performance.now();
      }
    }, { trackVisibility: true, delay: 100 });
    seen.observe(card);
  } catch { visibleSince = performance.now(); } // no v2 here: armed at once, as the in-page card
}
document.addEventListener("visibilitychange", () => watch(!document.hidden && !!shownKey));

function answer(name, ev) {
  if (busy) return;
  const it = current();
  if (!it || !ev?.isTrusted) return; // a synthetic event: nothing
  if (POINTER.has(name) && !(ev.detail > 0)) return hint(SAY.key);
  if (driving) return hint(SAY.driving);
  if (!visibleSince) return hint(covered ? SAY.covered : SAY.early);
  if (performance.now() - visibleSince < ARM_MS) return hint(SAY.early);
  if (!base) return hint(SAY.offline, "error");
  busy = true;
  for (const b of buttons()) b.disabled = true;
  hint(POINTER.has(name) ? "Allowing…" : "");
  post(it, name);
}

async function post(it, name) {
  const [route, body] = it.kind === "click" ? ["approve", { id: it.id, answer: name }]
    : it.kind === "join" ? ["approve", { id: it.id, allow: name === "allow" }]
      : it.kind === "dev" ? ["dev", { op: "answer", id: it.id, allow: name === "allow" }]
        : ["joinhost", name === "deny" ? { op: "cancel", id: it.id } : { op: "allow", id: it.id, always: name === "always" }];
  let status = 0;
  try {
    const r = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    status = r.ok ? 200 : r.status;
  } catch {}
  if (shownKey !== it.key) return; // withdrawn or dismissed meanwhile
  if (status === 200) {
    items = items.filter((x) => x.key !== it.key);
    prune();
    busy = false;
    draw();
  } else if (status === 404) {
    hint(SAY.gone, "error"); // buttons stay off; × still dismisses
  } else {
    busy = false;
    for (const b of buttons()) b.disabled = false;
    hint(SAY.failed, "error");
  }
}

$("allow").addEventListener("click", (ev) => answer("allow", ev));
$("deny").addEventListener("click", (ev) => answer("deny", ev));
$("dismiss").addEventListener("click", () => { if (shownKey) { dismissed.add(shownKey); draw(); } });
more.addEventListener("click", () => {
  if (!menu.hidden) return closeMenu();
  menu.hidden = false;
  more.setAttribute("aria-expanded", "true");
  menu.querySelector("button")?.focus();
});
card.addEventListener("focusout", (e) => {
  const to = e.relatedTarget;
  if (!menu.hidden && !(to && (menu.contains(to) || to === more))) closeMenu();
});

draw();
findBase().then((url) => { if (url) connect(url); else document.body.dataset.s = "closed"; });
