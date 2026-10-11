// The PairBrowse left dock (DESIGN.md B3). One source for two hosts: in the browser build
// window.pairbrowse (the mojom) gives the layout, the tabs and the tab owners; served without it,
// the helper's layout, tabs and agent-tabs events do. Both read the helper's stream for the
// agents (board), the activity, who it is shared with and the session. The page only reflects
// the dock's state: it sets it only from Tools (the right dock opens), from Activity in the rail
// and from the collapse and expand buttons. Nothing here is invented: every row is what the helper or
// the browser reported. Storage is PairBrowse Pro's (its cloud storage): no row until then (see
// the comment in index.html), whatever the session event carries.
import { $, el, rich, clock, activityHead, isColor, splitLabel, initialOf, pickerPopover, askDock, shareCard, helperStream } from "../common.js";

const pb = window.pairbrowse ?? null;
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
let lastWebTab = -1; // the last active tab that is not History
let base = null;
let stream = null; // the shared helper stream (common.js helperStream)
let everLive = false;
let driveTimer = 0;
let focusAfter = ""; // "rail" or "open": the state whose button takes focus once the layout applies it

const isHistory = (url) => /^chrome:\/\/history(\/|$)/.test(url || "");
const isSettings = (url) => /^(pairbrowse:\/\/|chrome:\/\/pairbrowse\/)settings(\/|$)/.test(url || "");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
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
const ROWS = ["nav-browser", "nav-sessions", "nav-history", "nav-activity", "nav-tools"];
function railTitles() {
  const rail = dock() === "rail";
  for (const id of ROWS) {
    const row = $(id);
    const label = row.querySelector(".label").textContent;
    if (!rail) row.removeAttribute("title");
    else row.title = id === "nav-browser" ? `${label} · ${$("tab-count-words").textContent}` : label;
  }
  // A disabled row keeps saying why, in either state.
  for (const id of ["nav-history"]) if ($(id).disabled) $(id).title = `${$(id).querySelector(".label").textContent} · opens in the PairBrowse browser`;
  $("workspace").title = rail ? "Workspace: switch session" : session?.name ? `Switch session (now: ${session.name})` : "Switch session";
}
function setDock(name) {
  const state = DOCK.includes(name) ? name : "open";
  const was = dock();
  document.body.dataset.dock = state;
  const hidden = state === "hidden";
  for (const id of ["main", "workspace", "settings", "dock-collapse", "dock-expand"]) $(id).inert = hidden;
  // The buttons show only once the layout is known (a host that cannot set it shows none).
  $("dock-collapse").hidden = !layout || state !== "open";
  $("dock-expand").hidden = !layout || state !== "rail";
  if (state !== "open") { closeHint(false); setActivity(false); }
  if (hidden) switcher.close(false);
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

// ---- agents: the board's people, then every agent that owns a tab and is not on it ----
function drawAgents() {
  // The native host keys owners and tabs by the browser's tab id, so a closed tab never counts;
  // the served host's agent-tabs list replaces owners whole and its tabs are keyed by index.
  const tabCount = (who) => [...owners].filter(([id, o]) => o.agent === who && (!pb || tabs.has(id))).length;
  const colorOf = (who) => [...owners.values()].find((o) => o.agent === who && isColor(o.color))?.color || "";
  const seen = new Set();
  const rows = [];
  for (const p of board.people) {
    if (!p?.who || seen.has(p.who) || (p.kind !== "agent" && p.kind !== "person")) continue;
    seen.add(p.who);
    rows.push(p);
  }
  for (const o of owners.values()) if (o.agent && !seen.has(o.agent)) { seen.add(o.agent); rows.push({ who: o.agent, kind: "agent" }); }
  const newest = activity.at(-1);
  const items = rows.map((p) => {
    let state, words;
    if (p.kind === "person") { state = "online"; words = "Online"; }
    else {
      const n = tabCount(p.who);
      const driving = !!newest && newest.who === p.who && Date.now() - newest.t < DRIVING_MS;
      state = p.status === "you" ? "waiting" : p.status === "working" || driving ? "working" : n > 0 ? "active" : "idle";
      words = { waiting: "Waiting for you", working: n ? `Working · ${plural(n, "tab")}` : "Working", active: `Active · ${plural(n, "tab")}`, idle: "Idle" }[state];
    }
    const { name, app } = splitLabel(p.who);
    const color = isColor(p.color) ? p.color : colorOf(p.who);
    const face = el("span", { className: "avatar", textContent: initialOf(name) });
    face.setAttribute("aria-hidden", "true");
    if (color) face.style.background = color;
    else face.classList.add("plain");
    face.append(el("i", { className: "dot" }));
    const li = el("li", { title: `${p.who} · ${words}` }, face,
      el("strong", { textContent: name }, ...(app ? [el("span", { className: "app", textContent: ` · ${app}` })] : [])),
      el("small", { textContent: words }));
    li.dataset.state = state;
    return li;
  });
  $("agents").replaceChildren(...(items.length ? items : [el("li", { className: "empty", textContent: "No agent yet" })]));
}

// ---- activity ----
function drawActivity() {
  const items = activity.slice(-ACTIVITY_SHOWN).reverse();
  $("activity-list").replaceChildren(...(items.length ? items.map((a) => el("li", {}, el("time", { textContent: clock(a.t) }),
    el("span", {}, ...(activityHead(a) ? [el("strong", { textContent: `${activityHead(a)}: ` })] : []), rich(a.text)))) : [el("li", { className: "empty", textContent: "Nothing yet" })]));
}
// One one-shot timer: an agent stops "working" DRIVING_MS after its last action. Armed only by
// an activity event, never while hidden.
function armDrive() {
  clearTimeout(driveTimer);
  driveTimer = 0;
  const newest = activity.at(-1);
  if (!newest || document.hidden || dock() === "hidden") return;
  const left = DRIVING_MS + 500 - (Date.now() - newest.t);
  if (left > 0) driveTimer = setTimeout(() => { driveTimer = 0; drawAgents(); }, left);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { clearTimeout(driveTimer); driveTimer = 0; }
  else { drawAgents(); armDrive(); }
});

// ---- shared with: the joined people, one row per name ----
// A filled avatar per name: the helper's color when it sends one, else a participant color picked
// from the name (scripts/daemon/hud.mjs SPARK_COLORS without Claude Code's spark; dark ink on each is
// AA, test/tokens.test.mjs), so a name keeps its color across draws.
const GUEST_COLORS = ["#7088f0", "#4fd1e8", "#4ade80", "#a78bfa", "#f472b6"];
const guestColor = (label) => { let h = 0; for (const ch of label) h = (h * 31 + ch.codePointAt(0)) >>> 0; return GUEST_COLORS[h % GUEST_COLORS.length]; };
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
  $("guests").replaceChildren(...[...byName].map(([label, { n, drive, color }]) => {
    // "N online" on screen; the role stays in the row's title and, for readers, in words.
    const role = drive ? "can drive" : "watching";
    const face = el("span", { className: "avatar guest" }, icon("i-people"));
    face.setAttribute("aria-hidden", "true");
    face.style.background = color || guestColor(label);
    const li = el("li", { title: `${label} · ${n} online · ${role}` }, face, el("strong", { textContent: label }), el("small", { textContent: `${n} online` }), el("span", { className: "sr", textContent: `, ${role}` }));
    li.dataset.state = "online";
    return li;
  }));
  // The section stays (its "+" is how you share): a line says so while nobody has joined.
  $("guests-empty").hidden = byName.size > 0;
}

// ---- actions ----
// The session switcher: the picker in a same-origin frame under the header, opened by the
// Workspace header and the Sessions row (common.js pickerPopover wires both).
const switcher = pickerPopover({ pop: $("switcher"), frame: $("picker"), openers: [$("workspace"), $("nav-sessions")] });
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
// Tools lives in the right dock: open it (no channel names the tab to show yet).
function openTools() {
  askDock({ pb, layout, base, side: "right", state: "open" });
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
function tabsFrom(list) {
  tabs.clear();
  for (const t of list) tabs.set(t.id, t);
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
  pb.tabs.list().then(({ tabs: list }) => tabsFrom(list || [])).catch(() => {});
  pb.tabs.addObserver({
    onCreated: (t) => { tabs.set(t.id, t); drawCount(); drawNav(); },
    onChanged: (t) => { tabs.set(t.id, t); drawNav(); },
    onRemoved: (id) => { tabs.delete(id); owners.delete(id); if (lastWebTab === id) lastWebTab = -1; drawCount(); drawNav(); drawAgents(); },
    onActivated: (id) => {
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
  on("session", (s) => { session = s && typeof s === "object" ? s : null; railTitles(); });
  on("collaboration", (c) => { guests = Array.isArray(c?.guests) ? c.guests : []; drawGuests(); });
  on("activity", (list) => {
    activity = Array.isArray(list) ? list.filter((a) => a && Number.isFinite(a.t)) : [];
    if ($("nav-activity").getAttribute("aria-expanded") === "true") drawActivity();
    drawAgents();
    armDrive();
  });
  on("board", (b) => { board = { people: Array.isArray(b?.people) ? b.people : [], messages: [] }; drawAgents(); });
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
if (pb) pb.session.helper().then(({ origin, key }) => { if (origin && key) connect(`${origin}/${key}/`); }).catch(() => {});
else {
  // The extension's storage (the bridge period); null on a page opened without it.
  try { globalThis.chrome?.storage?.session?.get("view").then(({ view }) => connect(view)).catch(() => {}); } catch {}
  try { globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => { if (area === "session" && changes.view) connect(changes.view.newValue); }); } catch {}
}

// ---- wiring ----
$("nav-browser").addEventListener("click", openBrowser);
$("nav-history").addEventListener("click", openHistory);
$("nav-activity").addEventListener("click", toggleActivity);
$("nav-tools").addEventListener("click", openTools);
$("add-agent").addEventListener("click", toggleHint);
// Share: a join code or a watch link, made here with a person's click (the helper's own invite).
shareCard({ btn: $("share-add"), card: $("share-card"), base: () => base });
$("settings").addEventListener("click", openSettings);
const askLeft = (state) => { focusAfter = state; if (!askDock({ pb, layout, base, side: "left", state, onFail: () => { focusAfter = ""; } })) focusAfter = ""; };
$("dock-collapse").addEventListener("click", () => askLeft("rail"));
$("dock-expand").addEventListener("click", () => askLeft("open"));
if (!pb) {
  $("nav-history").disabled = true;
  $("settings").disabled = true;
  $("settings").title = "Settings · opens in the PairBrowse browser";
}
drawCount();
drawNav();
drawAgents();
drawGuests();
