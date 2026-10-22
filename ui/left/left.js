// The PairBrowse left dock (DESIGN.md B3). One source for two hosts: in the browser build
// window.pairbrowse (the mojom) gives the layout, the tabs and the tab owners; served without it,
// the helper's layout, tabs and agent-tabs events do. Both read the helper's stream for the
// agents (board), the activity, who it is shared with and the session. The page only reflects
// the dock's state: it sets it only from Tools (the right dock opens, on its Tools tab through
// the helper's POST layout tab) and from the collapse and expand buttons. Tools is the agent panel's (its tab): no row here opens the other dock (DESIGN.md Part
// I). The Sessions row is the one door to sessions (2026-10-14): it names the open session (the
// helper's session event); in the browser it opens the sessions page in the contents
// (pairbrowse://sessions, a page rather than a popup, the user's choice), served without the
// browser's API the framed switcher. History, Activity and Proxies open their pages in the contents
// (chrome://history, pairbrowse://activity, pairbrowse://settings/proxies). Nothing here is invented: every row is what the helper or the browser reported. Storage is PairBrowse Pro's (its cloud storage): a row only
// when the session event carries session.storage (see the comment in index.html), never diskBytes.
import { $, el, avatar, agentWords, ownAgentLine, isColor, splitLabel, pickerPopover, askDock, helperConnection, servedByBrowser, syncList, enter } from "../common.js";
import { PROXIES_PAGE, isOwnTabPage, isProxiesPage, isSettingsPage, ownPage, settingsPage } from "../urls.js";
import { DRIVING_MS } from "../limits.js";
import { followHelper } from "../helper.js";

const pb = window.pairbrowse ?? null;
// The browser build serves the dock itself (chrome://pairbrowse.top-chrome), with or without the
// API; anything else is a page in a plain browser.
document.documentElement.dataset.host = pb || servedByBrowser() ? "native" : "extension";
const DOCK = ["hidden", "rail", "open"]; // DockState order
// DRIVING_MS (ui/limits.js): "working" for this long after an agent's last action (the panel's).
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
let everLive = false;
let driveTimer = 0;
let focusAfter = ""; // "rail" or "open": the state whose button takes focus once the layout applies it
let switchAsked = false; // the rail's Sessions row asked for the framed switcher (no browser API) while this dock was not yet open
let paused = false; // agents paused session-wide (the helper's pause event)
let noHelperKnown = false; // the browser (or the host) said there is no helper to ask

const isHistory = (url) => /^chrome:\/\/history(\/|$)/.test(url || "");
// The activity page (ui/activity) as the browser shows its address.
const isActivityPage = (url) => isOwnTabPage("activity", url);
// The sessions page (ui/sessions) as the browser shows its address.
const isSessionsPage = (url) => isOwnTabPage("sessions", url);
// A tab that is not a web page the Browser row brings back.
const isOwnPage = (url) => isHistory(url) || isActivityPage(url) || isSessionsPage(url) || isProxiesPage(url);
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
const ROWS = ["nav-browser", "nav-sessions", "nav-history", "nav-activity", "nav-proxies"];
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
  for (const id of ["nav-history", "nav-proxies"]) if ($(id).disabled) $(id).title = `${$(id).querySelector(".label").textContent} · opens in the PairBrowse browser`;
}
// The open session as the row shows it: a kept session by its name ("default" as "Default"), a
// fresh one (the helper's temporary, deleted when the person switches away) marked as such; null
// before the helper said.
function sessionShown() {
  const name = typeof session?.name === "string" ? session.name.trim() : "";
  const fresh = session?.temporary === true;
  if (!fresh && !name) return null;
  const open = fresh ? { short: "Fresh", long: "Fresh session (temporary)" } : { short: name === "default" ? "Default" : name, long: name === "default" ? "Default" : name };
  // A named instance (several PairBrowse helpers on one computer) leads, so two windows differ.
  const instance = typeof session?.instance === "string" ? session.instance.trim().slice(0, 32) : "";
  return instance ? { short: `${instance} · ${open.short}`, long: `${open.long}, instance ${instance}` } : open;
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
  // The control that had the focus: the window narrowing or widening changes the state with no
  // click (the browser's narrow-window rule), and the focus must not fall to the page's body.
  const had = document.activeElement !== document.body ? document.activeElement : null;
  document.body.dataset.dock = state;
  const hidden = state === "hidden";
  for (const id of ["main", "settings", "dock-collapse", "dock-expand"]) $(id).inert = hidden;
  // The buttons show only once the layout is known (a host that cannot set it shows none).
  $("dock-collapse").hidden = !layout || state !== "open";
  $("dock-expand").hidden = !layout || state !== "rail";
  if (state !== "open") closeHint(false);
  else if (switchAsked) { switchAsked = false; caretAt(); switcher.open($("nav-sessions")); }
  // Open and rail swap the dock's content: it comes in with the sheet's motion, not a jump (the
  // first state, on load, is only placed).
  if (was && was !== state && state !== "hidden") for (const n of [$("main"), document.querySelector(".foot")]) enter(n, { axis: "fade" });
  if (hidden) switcher.close(false);
  // Nothing redraws rows nobody can see: the drive timer stops with the dock hidden.
  if (hidden) { clearTimeout(driveTimer); driveTimer = 0; } else armDrive();
  if (focusAfter && state !== was) {
    const wanted = focusAfter;
    focusAfter = "";
    if (wanted === state) $(state === "rail" ? "dock-expand" : "dock-collapse").focus();
  }
  // A focused control the new state no longer shows hands the focus to the dock's own button.
  if (had && state !== was && state !== "hidden" && (document.activeElement === had || document.activeElement === document.body) && !had.checkVisibility()) {
    $(state === "rail" ? "dock-expand" : "dock-collapse").focus();
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
  const log = !!active && isActivityPage(active.url);
  const sessions = !!pb && !!active && isSessionsPage(active.url);
  const proxies = !!active && isProxiesPage(active.url);
  setCurrent($("nav-history"), history);
  setCurrent($("nav-activity"), log);
  setCurrent($("nav-sessions"), sessions);
  setCurrent($("nav-proxies"), proxies);
  setCurrent($("nav-browser"), !history && !log && !sessions && !proxies);
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
    const face = avatar(name, color, { decorative: true }); // the initial's ink passes AA (B11)
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

// ---- activity: the agents' last actions (the list itself is the activity page's) ----
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
    e.drive ||= g.role === "drive" || g.role === "approve";
    e.approve ||= g.role === "approve";
    byName.set(g.label, e);
  }
  syncList($("guests"), [...byName].map(([label, { n, drive, approve, color }]) => {
    // "N online" on screen; the role stays in the row's title and, for readers, in words.
    const role = approve ? "can drive and approve" : drive ? "can drive" : "watching";
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
// The session switcher. In the browser (window.pairbrowse) the Sessions row opens the sessions
// page in the contents (below). Served without the browser's API (a plain browser, the pages'
// harness) the picker opens in a same-origin frame under the row, where it reads the extension's
// storage for the helper's address.
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
if (pb) {
  // A page in the contents, as History and Activity: the row controls no element of this page.
  $("nav-sessions").removeAttribute("aria-controls");
  $("nav-sessions").removeAttribute("aria-expanded");
}
$("nav-sessions").addEventListener("click", (e) => {
  if (pb) {
    // The sessions page (found or opened in this window), from the open dock and the rail alike;
    // never the frame, which gets no bindings in the browser. The dock's state stays.
    e.stopImmediatePropagation();
    findOrOpen(isSessionsPage, ownPage("sessions"));
    return;
  }
  if (dock() !== "rail") { if (!switcher.isOpen()) caretAt(); return; }
  // In the rail the framed switcher has no room (44 px): the row opens the dock first and the
  // switcher once the dock is open (Part H).
  e.stopImmediatePropagation();
  if (askDock({ pb, layout, base, side: "left", state: "open" })) switchAsked = true;
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
// Settings: its tab page's address, which a build with the engine settings' section (580) sends there.
const openSettings = () => { if (pb) findOrOpen(isSettingsPage, settingsPage()); };
// Proxies: the engine settings' Proxies page (pairbrowse://settings/proxies), found or opened in
// this window, from the open dock and the rail alike.
const openProxies = () => findOrOpen(isProxiesPage, PROXIES_PAGE);
function openBrowser() {
  if (pb && lastWebTab >= 0 && tabs.has(lastWebTab) && !tabs.get(lastWebTab).active) pb.tabs.activate(lastWebTab).catch(() => {});
}
// Activity: the session's activity page in the contents (pairbrowse://activity), found or opened
// in this window, from the open dock and the rail alike. Served without the browser's API, the
// page's file in a new tab (it reads the helper's address as this dock does).
function openActivity() {
  if (pb) { findOrOpen(isActivityPage, ownPage("activity")); return; }
  window.open("../activity/index.html", "_blank", "noopener");
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
  if (a && !isOwnPage(a.url)) lastWebTab = a.id;
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
      if (t && !isOwnPage(t.url)) lastWebTab = id;
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
// panel=1 always (stream.js): today's helper never counts the dock as a viewer (no screencast for
// it). One stream per address (helperConnection).
const connect = helperConnection({
  kind: "left",
  onState: (s) => {
    document.body.dataset.s = s;
    $("conn").hidden = s === "live";
    if (s === "live") everLive = true;
    // Before the first open the line keeps saying it is connecting.
    else if (s === "closed" || everLive) $("conn").textContent = s === "closed" ? "PairBrowse is closed" : "Reconnecting to PairBrowse…";
  },
}, (stream, url) => {
  base = url;
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
});
// No helper to ask (no browser API and no extension storage, or the browser has no helper
// address): no connection line (the strip's pill says Local, the right dock says what to do);
// the Agents section keeps only its label and its + button.
function noHelper() {
  if (base) return;
  noHelperKnown = true;
  document.body.dataset.s = "closed";
  $("conn").hidden = true;
}
// The helper's address (ui/helper.js), and each new one the extension's worker stores; the
// extension's storage without one yet waits for it.
followHelper({ connect, none: noHelper, wait: true });

// ---- wiring ----
$("nav-browser").addEventListener("click", openBrowser);
$("nav-history").addEventListener("click", openHistory);
$("nav-activity").addEventListener("click", openActivity);
$("nav-proxies").addEventListener("click", openProxies);
$("add-agent").addEventListener("click", toggleHint);
// The strip's logo is a brand mark: the Sessions row above is the one door to the switcher.
$("settings").addEventListener("click", openSettings);
const askLeft = (state) => { focusAfter = state; if (!askDock({ pb, layout, base, side: "left", state, onFail: () => { focusAfter = ""; } })) focusAfter = ""; };
$("dock-collapse").addEventListener("click", () => askLeft("rail"));
$("dock-expand").addEventListener("click", () => askLeft("open"));
if (!pb) {
  $("nav-browser").disabled = true; // it brings the last web tab forward: the browser's API only
  $("nav-history").disabled = true;
  $("nav-proxies").disabled = true;
  $("settings").disabled = true;
  $("settings").title = "Settings · opens in the PairBrowse browser";
}
drawCount();
drawNav();
drawAgents();
drawGuests();
