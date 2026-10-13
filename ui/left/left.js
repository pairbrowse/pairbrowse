// The PairBrowse left dock (DESIGN.md B3). One source for two hosts: in the browser build
// window.pairbrowse (the mojom) gives the layout, the tabs and the tab owners; served without it,
// the helper's layout, tabs and agent-tabs events do. Both read the helper's stream for the
// agents (board), the activity, who it is shared with and the session. The page only reflects
// the dock's state: it sets it only from Tools (the right dock opens, on its Tools tab through
// the helper's POST layout tab), from Activity in the rail and from the collapse and expand
// buttons. Tools is the agent panel's (its tab): no row here opens the other dock (DESIGN.md Part
// I). The Sessions row is the one door to sessions (2026-10-14): it names the open session (the
// helper's session event) and opens the switcher; the switcher's "All sessions…" asks this dock
// (pairbrowse-sessions channel) to open the sessions page in the contents. Nothing here is invented: every row is what the helper or the browser reported. Storage is PairBrowse Pro's (its cloud storage): a row only
// when the session event carries session.storage (see the comment in index.html), never diskBytes.
import { $, el, rich, clock, activityHead, agentWords, ownAgentLine, isColor, inkOn, splitLabel, initialOf, pickerPopover, askDock, helperStream, servedByBrowser, syncList, enter } from "../common.js";

const pb = window.pairbrowse ?? null;
// The browser build serves the dock itself (chrome://pairbrowse.top-chrome), with or without the
// API; anything else is a page in a plain browser.
document.documentElement.dataset.host = pb || servedByBrowser() ? "native" : "extension";
const DOCK = ["hidden", "rail", "open"]; // DockState order
const DRIVING_MS = 8000; // "working" for this long after an agent's last action (the panel's)
const ACTIVITY_SHOWN = 12;
const SVG = "http://www.w3.org/2000/svg";

let layout = null; // the last LayoutState (native) or { left, right, strip } (served)
const tabs = new Map(); // id -> tab
const owners = new Map(); // tab id -> { agent, color }
let board = { people: [], messages: [] };
let activity = [];
let guests = [];
let session = null;
let ownerLabel = "You"; // the collaboration's owner label: the one person row under Agents
let lastWebTab = -1; // the last active tab that is not History
let myWindow = -1; // this dock's window (pb.windows.list), -1 until known
let base = null;
let stream = null; // the shared helper stream (common.js helperStream)
let everLive = false;
let driveTimer = 0;
let focusAfter = ""; // "rail" or "open": the state whose button takes focus once the layout applies it
let switchAsked = false; // the rail's Sessions row asked for the framed switcher (no browser API) while this dock was not yet open
let paused = false; // agents paused session-wide (the helper's pause event)
let noHelperKnown = false; // the browser (or the host) said there is no helper to ask

const isHistory = (url) => /^chrome:\/\/history(\/|$)/.test(url || "");
const isSettings = (url) => /^(pairbrowse:\/\/|chrome:\/\/pairbrowse\/)settings(\/|$)/.test(url || "");
const dock = () => document.body.dataset.dock;
const icon = (id) => {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG, "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
};

// ---- dock state ----
const ROWS = ["nav-browser", "nav-sessions", "nav-history", "nav-activity"];
function railTitles() {
  const rail = dock() === "rail";
  for (const id of ROWS) {
    const row = $(id);
    const label = row.querySelector(".label").textContent;
    if (!rail) row.removeAttribute("title");
    else row.title = id === "nav-browser" ? `${label} · ${$("tab-count-words").textContent}` : label;
  }
  // The open session's name follows the row's word in the rail's tooltip ("Sessions · Default").
  const open = sessionShown();
  if (rail && open) $("nav-sessions").title = `Sessions · ${open.long}`;
  // A disabled row keeps saying why, in either state.
  for (const id of ["nav-history"]) if ($(id).disabled) $(id).title = `${$(id).querySelector(".label").textContent} · opens in the PairBrowse browser`;
}
// The open session as the row shows it: a kept session by its name ("default" as "Default"), a
// fresh one (the helper's temporary, deleted when the person switches away) marked as such; null
// before the helper said.
function sessionShown() {
  if (session?.temporary === true) return { short: "Fresh", long: "Fresh session (temporary)" };
  const name = typeof session?.name === "string" ? session.name.trim() : "";
  if (!name) return null;
  const shown = name === "default" ? "Default" : name;
  return { short: shown, long: shown };
}
function drawSession() {
  const open = sessionShown();
  $("session-name").textContent = open?.short || "";
  $("session-name").toggleAttribute("data-temporary", session?.temporary === true);
  $("session-words").textContent = open ? `, ${open.long}` : "";
  railTitles();
}
function setDock(name) {
  const state = DOCK.includes(name) ? name : "open";
  const was = dock();
  document.body.dataset.dock = state;
  const hidden = state === "hidden";
  for (const id of ["main", "settings", "dock-collapse", "dock-expand"]) $(id).inert = hidden;
  // The buttons show only once the layout is known (a host that cannot set it shows none).
  $("dock-collapse").hidden = !layout || state !== "open";
  $("dock-expand").hidden = !layout || state !== "rail";
  if (state !== "open") { closeHint(false); setActivity(false); }
  else if (switchAsked) { switchAsked = false; caretAt(); switcher.open($("nav-sessions")); }
  // Open and rail swap the dock's content: it comes in with the sheet's motion, not a jump (the
  // first state, on load, is only placed).
  if (was && was !== state && state !== "hidden") for (const n of [$("main"), document.querySelector(".foot")]) enter(n, { axis: "fade" });
  if (hidden) { switcher.close(false); closeRowBubble(); }
  // Nothing redraws rows nobody can see: the drive timer stops with the dock hidden.
  if (hidden) { clearTimeout(driveTimer); driveTimer = 0; } else armDrive();
  if (focusAfter && state !== was) {
    const wanted = focusAfter;
    focusAfter = "";
    if (wanted === state) $(state === "rail" ? "dock-expand" : "dock-collapse").focus();
  }
  railTitles();
}

// ---- tabs: the count and which row is current ----
function drawCount() {
  const n = tabs.size;
  $("tab-count").textContent = String(n);
  $("tab-count-words").textContent = `${n} open ${n === 1 ? "tab" : "tabs"}`;
  railTitles();
}
const setCurrent = (row, on) => (on ? row.setAttribute("aria-current", "page") : row.removeAttribute("aria-current"));
function drawNav() {
  const active = [...tabs.values()].find((t) => t.active);
  const history = !!active && isHistory(active.url);
  setCurrent($("nav-history"), history);
  setCurrent($("nav-browser"), !history);
}

// ---- agents: the board's agents, then every agent that owns a tab and is not on it, then you ----
// Agents, and the owner last ("You · Online", the mockup's row); people who joined are under
// Shared with, never here.
function drawAgents() {
  // The native host keys owners and tabs by the browser's tab id, so a closed tab never counts;
  // the served host's agent-tabs list replaces owners whole and its tabs are keyed by index.
  const tabCount = (who) => [...owners].filter(([id, o]) => o.agent === who && (!pb || tabs.has(id))).length;
  const colorOf = (who) => [...owners.values()].find((o) => o.agent === who && isColor(o.color))?.color || "";
  const seen = new Set();
  const rows = [];
  for (const p of board.people) {
    if (!p?.who || seen.has(p.who) || p.kind !== "agent") continue;
    seen.add(p.who);
    rows.push(p);
  }
  for (const o of owners.values()) if (o.agent && !seen.has(o.agent)) { seen.add(o.agent); rows.push({ who: o.agent, kind: "agent" }); }
  const me = board.people.find((p) => p?.kind === "person" && p.who === ownerLabel);
  if (me) rows.push(me);
  const items = rows.map((p) => {
    const n = tabCount(p.who);
    const driving = Date.now() - actedAt(p.who) < DRIVING_MS;
    // The right dock's words and inputs (common.js agentWords: the board's status, the pause, the
    // agent's own last action), so an agent reads the same in both docks; its tabs follow the state.
    const { state, words } = agentWords(p, { tabs: n, driving, paused: paused && p.kind === "agent" });
    const { name, app } = splitLabel(p.who);
    const color = isColor(p.color) ? p.color : colorOf(p.who);
    const face = el("span", { className: "avatar", textContent: initialOf(name) });
    face.setAttribute("aria-hidden", "true");
    if (color) { face.style.background = color; face.style.color = inkOn(color); } // the initial's ink passes AA (B11)
    else face.classList.add("plain");
    face.append(el("i", { className: "dot" }));
    const li = el("li", { title: `${p.who} · ${words}` }, face,
      el("strong", { textContent: name }, ...(app ? [el("span", { className: "app", textContent: ` · ${app}` })] : [])),
      el("small", { textContent: words }));
    li.dataset.state = state;
    li.dataset.key = `who:${p.who}`;
    return li;
  });
  const agents = items.filter((li) => li.dataset.state !== "online");
  const none = el("li", { className: "empty", textContent: "No agent yet" });
  none.dataset.key = "empty";
  // Keyed (common.js syncList): an agent that joins grows in, one that leaves folds away.
  syncList($("agents"), agents.length ? items : [none, ...items]);
}

// ---- storage: PairBrowse Pro's cloud storage, only when the session event carries it ----
// session.storage = { used, limit } in bytes; anything else (diskBytes, no figure) shows nothing.
const gb = (n) => { const v = n / 1e9; return `${v >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} GB`; };
function drawStorage() {
  const st = session?.storage;
  const ok = st && Number.isFinite(st.used) && Number.isFinite(st.limit) && st.limit > 0 && st.used >= 0;
  $("storage")?.remove();
  if (!ok) return;
  const text = `${gb(st.used)} / ${gb(st.limit)}`;
  const fill = el("i", { id: "storage-bar" });
  fill.style.width = `${Math.min(100, (st.used / st.limit) * 100).toFixed(1)}%`;
  const bar = el("div", { className: "bar", title: `${text} used` }, fill);
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", `${gb(st.used)} of ${gb(st.limit)} used`);
  const box = el("div", { className: "storage", id: "storage" }, el("div", { className: "line" }, el("span", { textContent: "Storage" }), el("span", { id: "storage-text", textContent: text })), bar);
  document.querySelector(".foot-row").before(box);
}

// ---- activity ----
function drawActivity() {
  const items = activity.slice(-ACTIVITY_SHOWN).reverse();
  $("activity-list").replaceChildren(...(items.length ? items.map((a) => el("li", {}, el("time", { textContent: clock(a.t) }),
    el("span", {}, ...(activityHead(a) ? [el("strong", { textContent: `${activityHead(a)}: ` })] : []), rich(a.text)))) : [el("li", { className: "empty", textContent: "Nothing yet" })]));
}
// When an agent acted last (its own action: not a joiner's line, not a note), as the right dock
// counts it.
function actedAt(who) {
  for (let i = activity.length - 1; i >= 0; i--) if (activity[i].who === who && ownAgentLine(activity[i])) return activity[i].t;
  return 0;
}
// One one-shot timer: an agent stops "working" DRIVING_MS after its last action. Armed only by
// an activity event, never while hidden.
function armDrive() {
  clearTimeout(driveTimer);
  driveTimer = 0;
  const newest = activity.findLast(ownAgentLine);
  if (!newest || document.hidden || dock() === "hidden") return;
  const left = DRIVING_MS + 500 - (Date.now() - newest.t);
  if (left > 0) driveTimer = setTimeout(() => { driveTimer = 0; drawAgents(); }, left);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { clearTimeout(driveTimer); driveTimer = 0; }
  else { drawAgents(); armDrive(); }
});

// ---- shared with: the joined people, one row per name ----
// A group avatar per name: the helper's color when it sends one, else the neutral raised circle (the
// mockup's Team row); the people icon in --ink on either.
function drawGuests() {
  const byName = new Map();
  for (const g of guests) {
    if (!g?.label) continue;
    const e = byName.get(g.label) || { n: 0, drive: false, color: "" };
    e.n++;
    e.color ||= isColor(g.color) ? g.color : "";
    e.drive ||= g.role === "drive";
    byName.set(g.label, e);
  }
  syncList($("guests"), [...byName].map(([label, { n, drive, color }]) => {
    // "N online" on screen; the role stays in the row's title and, for readers, in words.
    const role = drive ? "can drive" : "watching";
    const face = el("span", { className: "avatar guest" }, icon("i-people"));
    face.setAttribute("aria-hidden", "true");
    if (color) face.style.background = color;
    else face.classList.add("plain");
    const li = el("li", { title: `${label} · ${n} online · ${role}` }, face, el("strong", { textContent: label }), el("small", { textContent: `${n} online` }), el("span", { className: "sr", textContent: `, ${role}` }));
    li.dataset.state = "online";
    li.dataset.key = `guest:${label}`;
    return li;
  }));
  // The section stays: a line says so while nobody has joined (Share is the strip's).
  $("guests-empty").hidden = byName.size > 0;
}

// ---- actions ----
// The session switcher. In the browser (window.pairbrowse) the Sessions row, its one door, opens
// the browser's own switcher bubble beside the row, its arrow at the row (530's Bubbles: the picker
// page itself, which reaches the helper; a frame here gets no bindings and could not): its state shows on the row (pressed), a second click or Escape on the row closes it,
// and Escape inside gives the focus back to the row. A build without Bubbles, or one that refuses,
// opens the picker as a tab. Served without the browser's API (a plain browser, the pages'
// harness) the picker opens in a same-origin frame under the row, where it reads the extension's
// storage for the helper's address.
const SWITCHER_KIND = Number.isInteger(pb?.BubbleKind?.kSwitcher) ? pb.BubbleKind.kSwitcher : 0;
const hasBubbles = () => typeof pb?.bubbles?.open === "function";
// With no helper to ask (none at all, or one whose stream never opened) the switcher opens on the
// picker's resting state, not its question.
const switcher = pickerPopover({ pop: $("switcher"), frame: $("picker"), openers: [$("nav-sessions")], noHelper: () => (base ? !everLive : noHelperKnown) });
// Where the framed switcher opens, at its trigger (DESIGN.md Part I): right under the Sessions row,
// the caret at its icon.
function caretAt() {
  const edge = 8; // the switcher's left edge in the dock (--dock-gutter, left.css)
  const row = $("nav-sessions").getBoundingClientRect();
  const x = $("nav-sessions").querySelector(".ic").getBoundingClientRect().left + 8 - edge;
  const pop = $("switcher");
  pop.style.setProperty("--caret-x", `${Math.round(Math.max(16, Math.min(x, window.innerWidth - 32)))}px`);
  pop.style.setProperty("--pop-top", `${Math.round(row.bottom + 8)}px`);
}
// ---- the browser's switcher bubble (530 E1-E2, from the Sessions row) ----
let rowBubble = false; // the bubble this dock opened is showing
// A click outside closes the bubble before that click lands: when it lands on the row itself it is
// the close, not a new open. When the browser said so (not by Escape), and how recently: a
// timestamp, no timer.
const REOPEN_MS = 400;
let rowClosedAt = -Infinity;
let rowSelfClosed = false;
let rowObserved = false;
function rowState(open) {
  rowBubble = open;
  $("nav-sessions").setAttribute("aria-expanded", String(open));
  holdOpener(open);
}
// While this dock's bubble shows it holds the pairbrowse-switcher-opener lock: the bubble's "All
// sessions…" checks for it before asking over the channel, so it can say at once when no dock
// would answer (no timer of its own). Released when the bubble closes.
const OPENER_LOCK = "pairbrowse-switcher-opener";
let wantOpener = false;
let releaseOpener = null;
function holdOpener(on) {
  wantOpener = on;
  if (!on) { releaseOpener?.(); releaseOpener = null; return; }
  if (releaseOpener || typeof navigator.locks?.request !== "function") return;
  navigator.locks.request(OPENER_LOCK, { ifAvailable: true }, (lock) => (lock && wantOpener ? new Promise((r) => { releaseOpener = r; }) : null)).catch(() => {});
}
function observeRowBubble() {
  if (rowObserved) return;
  rowObserved = true;
  pb.bubbles.addObserver({
    onClosed: (kind, byEscape) => {
      if (kind !== SWITCHER_KIND || !rowBubble) return;
      rowState(false);
      if (!byEscape && !rowSelfClosed) rowClosedAt = performance.now();
      rowSelfClosed = false;
      // Escape, a pick or the picker's own close: the focus comes back to the row.
      if (byEscape) $("nav-sessions").focus();
    },
  });
}
// The row's box in this page's CSS pixels, rounded outward and kept inside the page (the browser
// refuses an anchor outside its slot).
function anchorRect(node) {
  const r = node.getBoundingClientRect();
  const x = Math.max(0, Math.floor(r.left)), y = Math.max(0, Math.floor(r.top));
  const right = Math.min(window.innerWidth, Math.ceil(r.right)), bottom = Math.min(window.innerHeight, Math.ceil(r.bottom));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}
const isPicker = (url) => /^(pairbrowse:\/\/|chrome:\/\/pairbrowse\/)picker(\/|#|$)/.test(url || "");
const openPickerTab = () => findOrOpen(isPicker, "pairbrowse://picker");
// ---- "All sessions…" (the switcher's last item): the sessions page in the contents ----
// The bubble gets Session and Bubbles only, so it cannot open a tab: it asks over the
// pairbrowse-sessions channel (this origin only) with { open: "sessions" }, and the dock whose row
// opened it (the one door: the strip's logo is a brand mark; it holds the opener lock meanwhile)
// finds or opens pairbrowse://sessions in its window and answers { opened: "sessions" }; the bubble
// then closes. Any other dock stays quiet.
const isSessionsPage = (url) => /^(pairbrowse:\/\/|chrome:\/\/pairbrowse\/)sessions(\/|#|\?|$)/.test(url || "");
let sessionsChannel = null;
try { sessionsChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("pairbrowse-sessions") : null; } catch {}
if (sessionsChannel) sessionsChannel.onmessage = (e) => {
  if (e.data?.open !== "sessions" || !pb || !rowBubble) return;
  findOrOpen(isSessionsPage, "pairbrowse://sessions");
  sessionsChannel.postMessage({ opened: "sessions" });
};
function closeRowBubble() {
  if (!rowBubble) return;
  rowSelfClosed = true;
  rowState(false);
  pb.bubbles.close(SWITCHER_KIND).catch(() => {});
}
async function toggleRowSwitcher() {
  if (rowBubble) { closeRowBubble(); return; }
  if (performance.now() - rowClosedAt < REOPEN_MS) return;
  if (!hasBubbles()) { openPickerTab(); return; }
  observeRowBubble();
  let shown = false;
  try { ({ shown } = await pb.bubbles.open(SWITCHER_KIND, anchorRect($("nav-sessions")), "")); } catch {}
  if (shown) rowState(true);
  else openPickerTab();
}
if (pb) {
  // The bubble is a dialog of the window: the row says so, and controls no element of this page.
  $("nav-sessions").setAttribute("aria-haspopup", "dialog");
  $("nav-sessions").removeAttribute("aria-controls");
}
$("nav-sessions").addEventListener("click", (e) => {
  if (pb) {
    // The browser's bubble (or the picker tab), from the open dock and the rail alike: never the
    // frame, which gets no bindings in the browser.
    e.stopImmediatePropagation();
    toggleRowSwitcher();
    return;
  }
  if (dock() !== "rail") { if (!switcher.isOpen()) caretAt(); return; }
  // In the rail the framed switcher has no room (44 px): the row opens the dock first and the
  // switcher once the dock is open (Part H).
  e.stopImmediatePropagation();
  if (askDock({ pb, layout, base, side: "left", state: "open" })) switchAsked = true;
}, true);
$("nav-sessions").addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !rowBubble) return;
  e.preventDefault();
  closeRowBubble();
}, true);
// Find a tab whose address matches, else open one in the active tab's window.
function findOrOpen(match, url) {
  if (!pb) return;
  const t = [...tabs.values()].find((x) => match(x.url));
  if (t) { pb.tabs.activate(t.id).catch(() => {}); return; }
  const w = [...tabs.values()].find((x) => x.active)?.window ?? -1;
  pb.tabs.create(url, true, w).catch(() => {});
}
const openHistory = () => findOrOpen(isHistory, "chrome://history");
const openSettings = () => findOrOpen(isSettings, "pairbrowse://settings");
function openBrowser() {
  if (pb && lastWebTab >= 0 && tabs.has(lastWebTab) && !tabs.get(lastWebTab).active) pb.tabs.activate(lastWebTab).catch(() => {});
}
function setActivity(open) {
  $("nav-activity").setAttribute("aria-expanded", String(open));
  $("activity-list").hidden = !open;
}
function toggleActivity() {
  const open = $("nav-activity").getAttribute("aria-expanded") !== "true";
  if (open && dock() === "rail" && !askDock({ pb, layout, base, side: "left", state: "open" })) return;
  if (open) drawActivity();
  setActivity(open);
}

// The "+" hint: a card under the Agents heading, closed with Escape, a click outside or focus
// leaving it.
const hintInside = (node) => !!node && ($("hint").contains(node) || $("add-agent").contains(node));
const onOutsidePointer = (e) => { if (!hintInside(e.target)) closeHint(false); };
const onFocusOut = (e) => { if (e.relatedTarget && !hintInside(e.relatedTarget)) closeHint(false); };
const onHintKey = (e) => { if (e.key === "Escape") { e.preventDefault(); closeHint(true); } };
function openHint() {
  const hint = $("hint");
  hint.hidden = false;
  $("add-agent").setAttribute("aria-expanded", "true");
  document.addEventListener("pointerdown", onOutsidePointer, true);
  hint.addEventListener("focusout", onFocusOut);
  $("add-agent").addEventListener("focusout", onFocusOut);
  hint.addEventListener("keydown", onHintKey);
  $("add-agent").addEventListener("keydown", onHintKey);
  const first = hint.querySelector("p");
  first.tabIndex = -1;
  first.focus();
}
function closeHint(refocus) {
  const hint = $("hint");
  if (hint.hidden) return;
  hint.hidden = true;
  $("add-agent").setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", onOutsidePointer, true);
  hint.removeEventListener("focusout", onFocusOut);
  $("add-agent").removeEventListener("focusout", onFocusOut);
  hint.removeEventListener("keydown", onHintKey);
  $("add-agent").removeEventListener("keydown", onHintKey);
  if (refocus) $("add-agent").focus();
}
const toggleHint = () => ($("hint").hidden ? openHint() : closeHint(false));

// ---- the browser's own state (native) ----
// This dock's own window (Part H): the badge, the current row and find-or-open read only its tabs.
// Until the window is known (-1) every tab counts.
const ours = (t) => !!t && (myWindow === -1 || t.window === myWindow);
function tabsFrom(list) {
  tabs.clear();
  for (const t of list) if (ours(t)) tabs.set(t.id, t);
  const a = list.find((t) => t.active);
  if (a && !isHistory(a.url)) lastWebTab = a.id;
  drawCount();
  drawNav();
  drawAgents();
}
function setOwners(agents, colors) {
  owners.clear();
  for (const [id, name] of Object.entries(agents || {})) if (name) owners.set(Number(id), { agent: name, color: colors?.[id] || "" });
  drawAgents();
}
if (pb) {
  pb.layout.get().then(({ state }) => { layout = state; setDock(DOCK[state?.left] ?? "open"); }).catch(() => {});
  pb.layout.addObserver({ onLayout: (s) => { layout = s; setDock(DOCK[s?.left] ?? "open"); } });
  // The window first, then its tabs.
  pb.windows.list().then(({ windows }) => { myWindow = (windows.find((w) => w.current) || windows.find((w) => w.focused))?.id ?? -1; }).catch(() => {})
    .then(() => pb.tabs.list()).then(({ tabs: list }) => tabsFrom(list || [])).catch(() => {});
  pb.tabs.addObserver({
    onCreated: (t) => { if (!ours(t)) return; tabs.set(t.id, t); drawCount(); drawNav(); },
    onChanged: (t) => {
      if (!ours(t)) { if (tabs.delete(t.id)) { drawCount(); drawNav(); } return; } // moved to another window
      const known = tabs.has(t.id);
      tabs.set(t.id, t);
      if (!known) drawCount();
      drawNav();
    },
    onRemoved: (id) => { tabs.delete(id); owners.delete(id); if (lastWebTab === id) lastWebTab = -1; drawCount(); drawNav(); drawAgents(); },
    onActivated: (id, window) => {
      if (myWindow !== -1 && window !== undefined && window !== myWindow) return; // another window's
      for (const t of tabs.values()) t.active = t.id === id;
      const t = tabs.get(id);
      if (t && !isHistory(t.url)) lastWebTab = id;
      drawNav();
    },
  });
  pb.agent.getOwners().then(({ agents, colors }) => setOwners(agents, colors)).catch(() => {});
  pb.agent.addObserver({
    onOwnerChanged: (id, agent, color) => {
      if (agent) owners.set(id, { agent, color: color || "" });
      else owners.delete(id);
      drawAgents();
    },
  });
}

// ---- the helper's stream ----
function connect(url) {
  if (!url || url === base) return;
  base = url;
  stream?.close();
  // panel=1 always (common.js): today's helper never counts the dock as a viewer (no screencast for it).
  stream = helperStream(base, {
    kind: "left",
    onState: (s) => {
      document.body.dataset.s = s;
      $("conn").hidden = s === "live";
      if (s === "live") everLive = true;
      // Before the first open the line keeps saying it is connecting.
      else if (s === "closed" || everLive) $("conn").textContent = s === "closed" ? "PairBrowse is closed" : "Reconnecting to PairBrowse…";
    },
  });
  const on = stream.on;
  // The open session's name follows every switch and rename as the helper says it (no polling).
  on("session", (s) => { session = s && typeof s === "object" ? s : null; drawSession(); drawStorage(); });
  on("collaboration", (c) => {
    guests = Array.isArray(c?.guests) ? c.guests : [];
    const label = typeof c?.owner?.label === "string" && c.owner.label ? c.owner.label : "You";
    if (label !== ownerLabel) { ownerLabel = label; drawAgents(); }
    drawGuests();
  });
  on("activity", (list) => {
    activity = Array.isArray(list) ? list.filter((a) => a && Number.isFinite(a.t)) : [];
    if ($("nav-activity").getAttribute("aria-expanded") === "true") drawActivity();
    drawAgents();
    armDrive();
  });
  on("board", (b) => { board = { people: Array.isArray(b?.people) ? b.people : [], messages: [] }; drawAgents(); });
  // Paused agents read "Paused" here as in the right dock.
  on("pause", (p) => { const was = paused; paused = !!p?.paused; if (paused !== was) drawAgents(); });
  if (!pb) {
    on("layout", (l) => { if (l && typeof l === "object") { layout = l; setDock(l.left); } });
    on("tabs", (list) => {
      if (!Array.isArray(list)) return;
      tabs.clear();
      list.forEach((t, i) => { const id = t?.id ?? i; tabs.set(id, { id, url: t?.url, active: !!t?.shown }); });
      drawCount();
      drawNav();
    });
    on("agent-tabs", (list) => {
      owners.clear();
      for (const t of Array.isArray(list) ? list : []) if (t?.agent?.label) owners.set(t.id, { agent: t.agent.label, color: t.agent.color || "" });
      drawAgents();
    });
  }
}
// No helper to ask (no browser API and no extension storage, or the browser has no helper
// address): no connection line (the strip's pill says Local, the right dock says what to do);
// the Agents section keeps only its label and its + button.
function noHelper() {
  if (base) return;
  noHelperKnown = true;
  document.body.dataset.s = "closed";
  $("conn").hidden = true;
}
if (pb) pb.session.helper().then(({ origin, key }) => { if (origin && key) connect(`${origin}/${key}/`); else noHelper(); }).catch(noHelper);
else {
  // The extension's storage (the bridge period); null on a page opened without it.
  let area = null;
  try { area = globalThis.chrome?.storage?.session || null; } catch {}
  if (!area) noHelper();
  else area.get("view").then(({ view }) => (view ? connect(view) : null)).catch(() => {});
  try { globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => { if (area === "session" && changes.view) connect(changes.view.newValue); }); } catch {}
}

// ---- wiring ----
$("nav-browser").addEventListener("click", openBrowser);
$("nav-history").addEventListener("click", openHistory);
$("nav-activity").addEventListener("click", toggleActivity);
$("add-agent").addEventListener("click", toggleHint);
// The strip's logo is a brand mark: the Sessions row above is the one door to the switcher.
$("settings").addEventListener("click", openSettings);
const askLeft = (state) => { focusAfter = state; if (!askDock({ pb, layout, base, side: "left", state, onFail: () => { focusAfter = ""; } })) focusAfter = ""; };
$("dock-collapse").addEventListener("click", () => askLeft("rail"));
$("dock-expand").addEventListener("click", () => askLeft("open"));
if (!pb) {
  $("nav-browser").disabled = true; // it brings the last web tab forward: the browser's API only
  $("nav-history").disabled = true;
  $("settings").disabled = true;
  $("settings").title = "Settings · opens in the PairBrowse browser";
}
drawCount();
drawNav();
drawAgents();
drawGuests();
