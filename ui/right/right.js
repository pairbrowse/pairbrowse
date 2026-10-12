// The PairBrowse right dock: one page for two hosts. In the browser build (window.pairbrowse) it
// takes the helper's address and the dock state from the browser; as plain Chromium's side panel
// it reads the address the daemon handed to background.js. Either way it reads the live view
// server's owner stream (status, activity, profile) through the one shared stream per origin
// (common.js helperStream) and never asks for the page stream itself. The Tools tab's Hand-offs,
// Downloads, Recordings and Diagnostics live in tools.js (no timer there); this file wires them:
// the Record button and its clock stay here. The dock state stays the browser's (native) or none
// (served): a layout event only ever brings the tab to show (the left dock's Tools row).
import { $, el, rich, clock, ago, whose, activityHead, joinBanners, profilePanel, devPanel, hostPanel, isColor, splitLabel, initialOf, avatar, shareCard, checklistItems, checkState, askDock, helperStream, servedByBrowser } from "../common.js";
import { toolsPanel } from "./tools.js";

const pb = globalThis.pairbrowse || null;
// The browser build serves the dock itself (chrome://pairbrowse.top-chrome), with or without the
// API: no extension header there (the strip has the logo, the pill and the avatars).
document.documentElement.dataset.host = pb || servedByBrowser() ? "native" : "extension";

const DRIVING_MS = 8000; // "Working…" for this long after the agent's last action
const ACTIVITY_SHOWN = 12;
const PICTURE_ID = /^[0-9a-f]{12}$/;
let base = null;
let stream = null; // the shared helper stream (common.js helperStream)
let lastActivity = 0;
let lastWho = "";
let driveTimer = 0;
let paused = false;
let pauseInfo = null; // the last pause event, as the helper sent it
// What the stream said last, for the header, the agent card and the people rows (no state of the
// page's own: everything here comes from the session, collaboration, board and activity events).
let lastBoard = { people: [], messages: [] };
let lastCollab = null;
let lastSession = null;
let lastTab = "";
// Idle agents here with no tab of their own (other Claude Code and Codex windows connected,
// doing nothing): one line, not a card each.
const quiet = (p) => p.kind === "agent" && !p.where && !p.tab && !p.task && (!p.status || p.status === "idle");
// Nothing ticks while the page is hidden or, in the browser build, the dock is.
const asleep = () => document.hidden || document.documentElement.dataset.dock === "hidden";
// The checklist's re-read and the recording clock draw only in a pane: a rail shows none.
const unseen = () => asleep() || document.documentElement.dataset.dock === "rail";
// The agent card is on screen: the page and the dock shown, open (not a rail), on the Agent tab.
const agentShown = () => !unseen() && document.body.dataset.tab === "agent";
const post = (route, body) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ---- tabs: Agent, Page, Pictures, Tools (roving tabindex; arrows, Home and End move it) ----
const TABS = ["agent", "page", "pictures", "tools"];
function selectTab(name) {
  if (!TABS.includes(name)) return;
  document.body.dataset.tab = name;
  for (const t of TABS) {
    const tab = $(`tab-${t}`);
    tab.setAttribute("aria-selected", String(t === name));
    tab.tabIndex = t === name ? 0 : -1;
    $(`pane-${t}`).hidden = t !== name;
  }
  // The rail marks the tab that opens in a shape (an inset bar), not by color alone.
  for (const btn of document.querySelectorAll(".rail-btn")) {
    if (btn.dataset.tab === name) btn.setAttribute("aria-current", "true"); else btn.removeAttribute("aria-current");
  }
  countRequests();
  // The goal log is read only while the Agent tab is in front: another tab drops its pending read.
  if (name === "agent") { if (checklistStale) scheduleChecklist(); }
  else { clearTimeout(checklistTimer); checklistTimer = 0; checklistPending = false; }
  if (name === "pictures") showPictures();
  if (name === "tools") tools.show();
}
for (const t of TABS) $(`tab-${t}`).addEventListener("click", () => selectTab(t));
document.querySelector(".tabset").addEventListener("keydown", (e) => {
  const at = TABS.indexOf(document.body.dataset.tab);
  const to = { ArrowRight: (at + 1) % TABS.length, ArrowLeft: (at + TABS.length - 1) % TABS.length, Home: 0, End: TABS.length - 1 }[e.key];
  if (e.target.getAttribute("role") === "tab" && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); return selectTab(e.target.id.slice(4)); }
  if (to === undefined) return;
  e.preventDefault();
  selectTab(TABS[to]);
  $(`tab-${TABS[to]}`).focus();
});

// Open requests (joins, dev servers, join addresses) on the Agent tab's label while another tab
// is in front, and on the rail's Agent button whenever there are any (the rail shows no pane).
function countRequests() {
  const n = $("joins").children.length + $("dev-asks").children.length + $("host-asks").children.length;
  const words = `${n} request${n === 1 ? "" : "s"}`;
  const c = $("agent-count");
  c.hidden = !n || document.body.dataset.tab === "agent";
  c.textContent = n ? String(n) : "";
  c.setAttribute("aria-label", words);
  const r = $("rail-count");
  r.hidden = !n;
  r.textContent = n ? String(n) : "";
  $("rail-agent").setAttribute("aria-label", n ? `Agent, ${words}` : "Agent");
}

// ---- the dock state (the browser build only): open, a rail of four buttons, or hidden ----
// Collapse (in the open tab bar) asks for the rail and expand (the rail's top) for open; focus
// moves to the other button once the browser applies it. Hidden is on the shortcut only.
let lastLayout = null;
let focusAfter = ""; // "rail" or "open": the state whose button takes focus once the layout applies it
function applyDock(s) {
  const name = ["hidden", "rail", "open"][s?.right] || "open";
  const was = document.documentElement.dataset.dock;
  document.documentElement.dataset.dock = name;
  $("rail").hidden = name !== "rail";
  $("dock-collapse").hidden = name !== "open";
  $("dock-expand").hidden = name !== "rail";
  if (name === was) return;
  if (focusAfter) {
    const wanted = focusAfter;
    focusAfter = "";
    if (wanted === name) $(name === "rail" ? "dock-expand" : "dock-collapse").focus();
  }
  // A hidden dock or a rail runs no timer, whether or not its document reports hidden; open
  // again, each is re-armed from the state it left. Open on Pictures again: the newest picture.
  if (name === "hidden" || name === "rail") sleepTimers();
  else if (was === "hidden" || was === "rail") wakeTimers();
  else if (name === "open" && document.body.dataset.tab === "pictures") showPictures();
}
if (pb) {
  pb.layout.get().then(({ state }) => { lastLayout = state; applyDock(state); }).catch(() => {});
  pb.layout.addObserver({ onLayout: (state) => { lastLayout = state; applyDock(state); } });
  for (const btn of document.querySelectorAll(".rail-btn")) {
    btn.addEventListener("click", () => {
      if (lastLayout) pb.layout.set({ ...lastLayout, right: pb.DockState.kOpen }).catch(() => {});
      selectTab(btn.dataset.tab);
    });
  }
  const ask = (state) => { focusAfter = state; if (!askDock({ pb, layout: lastLayout, base: null, side: "right", state, onFail: () => { focusAfter = ""; } })) focusAfter = ""; };
  $("dock-collapse").addEventListener("click", () => ask("rail"));
  $("dock-expand").addEventListener("click", () => ask("open"));
}

// End session: the session picker again, after a confirm in the card itself (a dock slot in the
// browser build has no JavaScript dialogs, so confirm() would answer no at once). A person's
// choice: agents' next actions wait for it; nothing is deleted. A synthetic click ends nothing.
function endAsk(open, refocus) {
  $("end-confirm").hidden = !open;
  $("switch-btn").setAttribute("aria-expanded", String(open));
  if (open) $("end-no").focus(); else if (refocus) $("switch-btn").focus();
}
$("switch-btn").addEventListener("click", () => endAsk($("end-confirm").hidden, false));
$("end-yes").addEventListener("click", (ev) => {
  // A person's click or key press; a page's synthetic event does nothing. The focus lands on Keep,
  // so a second Enter on End session keeps the session.
  if (!ev.isTrusted) return;
  endAsk(false, false);
  if (base) fetch(base + "picker", { method: "POST" }).catch(() => {});
});
$("end-no").addEventListener("click", () => endAsk(false, true));
$("end-confirm").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); endAsk(false, true); } });
// Record: the browser as a video (the helper saves it in Downloads and says where).
let recording = null; // { since } while recording
let recordTimer = 0;
// The Tools tab's four sections (tools.js): read only while that tab is shown in the open dock.
const tools = toolsPanel({
  base: () => base,
  shown: () => !unseen() && document.body.dataset.tab === "tools",
  onRecording: (s) => { recording = s.on ? { since: s.since } : null; drawRecord(); },
});
function drawRecord() {
  const btn = $("record-btn");
  btn.textContent = recording ? "Stop recording" : "Record";
  document.body.dataset.recording = String(!!recording);
  clearInterval(recordTimer);
  if (!recording) return;
  const tick = () => { const s = Math.round((Date.now() - recording.since) / 1000); $("record-note").hidden = false; $("record-note").textContent = `Recording ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  tick();
  if (!unseen()) recordTimer = setInterval(tick, 1000);
}
$("record-btn").addEventListener("click", async () => {
  if (!base) return;
  const btn = $("record-btn");
  btn.disabled = true;
  if (recording) $("record-note").textContent = "Saving the recording…";
  try {
    const r = await post("record", { on: !recording }).then((x) => x.json()).catch(() => null);
    if (r && !r.recording) { recording = null; drawRecord(); $("record-note").hidden = false; $("record-note").textContent = r.path ? `Saved to ${r.path}` : r.text || "Recording stopped."; }
    else if (r?.recording) { recording = { since: r.since || Date.now() }; drawRecord(); }
  } finally { btn.disabled = false; }
});
$("pause-btn").addEventListener("click", () => {
  if (base) post("pause", { paused: !paused }).catch(() => {});
});

// The requests, then the count on the Agent tab.
const joins = joinBanners($("joins"), () => base);
const dev = devPanel($("dev-asks"), $("devs"), $("dev"), () => base);
const hosts = hostPanel($("host-asks"), $("host-list"), $("hosts"), () => base);
const drawJoins = (x) => { joins(x); countRequests(); };
const drawDev = (x) => { dev(x); countRequests(); };
const drawHosts = (x) => { hosts(x); countRequests(); };
const profile = profilePanel(() => base);
// Share: a join code or a watch link, made here with a click (the helper's own invite code).
shareCard({ btn: $("share-btn"), card: $("share-card"), base: () => base });

// The agent card folds to one line.
$("agent-fold").addEventListener("click", () => {
  const folded = $("agent").dataset.folded !== "true";
  $("agent").dataset.folded = String(folded);
  $("agent-fold").setAttribute("aria-expanded", String(!folded));
  $("agent-fold").setAttribute("aria-label", folded ? "Expand the agent card" : "Collapse the agent card");
});

// The agent card's Checklist: the goal log (the same journal.json as the live view's Timeline),
// read once when the Agent tab is shown and again while actions come in, at most once per
// CHECKLIST_MS through one pending timeout; nothing at all while another tab is in front, the
// page or the dock is hidden, or the dock is a rail. The same read gives the current task (the
// run's name) and when the run was last saved. Shown again (the tab, the page or the dock), it
// reads only when actions came in since the last read (stale). The chevron only folds the steps.
const CHECKLIST_MS = 5000;
let checklistOpen = true, checklistBusy = false, checklistPending = false, checklistAt = 0, checklistTimer = 0, checklistStale = true;
// The list itself isn't a live region (it is rebuilt on every refresh while the agent drives):
// readers hear one line with the counts, only when the counts change.
let checklistSaid = "";
const drawChecklist = (items) => {
  $("checklist-items").replaceChildren(...items);
  const n = (state) => items.filter((li) => li.dataset?.state === state).length;
  const line = items.some((li) => li.dataset?.state) ? `${n("done")} done, ${n("current")} under way, ${n("waiting")} waiting for you, ${n("pending")} pending` : "";
  if (line !== checklistSaid) { checklistSaid = line; $("checklist-said").textContent = line; }
};
async function loadChecklist() {
  if (!agentShown()) return;
  if (!base) return drawChecklist([el("li", { className: "empty", textContent: "Waiting for PairBrowse." })]);
  if (checklistBusy) { checklistPending = true; return; }
  checklistBusy = true;
  checklistStale = false;
  checklistAt = Date.now();
  const r = await fetch(base + "journal.json", { signal: AbortSignal.timeout(8000) }).then((x) => (x.ok ? x.json() : Promise.reject(x.status))).catch(() => undefined);
  checklistBusy = false;
  // Not reached: the next show of the Agent tab, page or dock reads once more.
  if (r === undefined) checklistStale = true;
  drawChecklist(r === undefined ? [el("li", { className: "empty", textContent: "Couldn't reach PairBrowse." })] : checklistItems(r, { driving: document.body.dataset.driving === "true" }));
  if (r && typeof r === "object") {
    $("task").hidden = !r.name;
    $("task-name").textContent = r.name || "";
    const saved = ago(r.updatedAt);
    $("session-saved").hidden = !saved;
    $("session-saved").textContent = saved ? `Saved ${saved}` : "";
  }
  if (checklistPending) { checklistPending = false; scheduleChecklist(); }
}
function scheduleChecklist() {
  if (checklistTimer || !agentShown()) return;
  checklistTimer = setTimeout(() => { checklistTimer = 0; loadChecklist(); }, Math.max(0, checklistAt + CHECKLIST_MS - Date.now()));
}
// The newest done row is "current" only while the agent drives: re-marked here, no fetch.
function markCurrent() {
  const rows = $("checklist-items").querySelectorAll('li[data-state="done"], li[data-state="current"]');
  if (rows.length) checkState(rows[rows.length - 1], document.body.dataset.driving === "true" ? "current" : "done");
}
$("agent-more").addEventListener("click", () => {
  checklistOpen = !checklistOpen;
  $("agent-more").setAttribute("aria-expanded", String(checklistOpen));
  $("checklist").hidden = !checklistOpen;
});

// The session card's Save and rename: shown only when the helper's session event says canSave or
// canRename; a 404 from the route hides the button again for this helper. A person's click or
// key press only: a synthetic event saves and renames nothing.
let canSave = false, canRename = false, editing = false, renaming = false;
const sessionSay = (text, kind = "") => { $("session-msg").textContent = text; $("session-msg").dataset.kind = kind; };
function drawSessionTools() {
  $("session-save").hidden = !canSave;
  $("session-rename").hidden = !canRename || editing;
}
function editName(open, refocus = false) {
  editing = open;
  const input = $("session-name-input");
  input.hidden = !open;
  $("session-line").hidden = open || !lastSession?.name;
  drawSessionTools();
  if (open) { input.value = $("session-name").textContent; input.focus(); input.select(); }
  else if (refocus && !$("session-rename").hidden) $("session-rename").focus();
}
function forgetSessionTools() {
  canSave = false; canRename = false;
  if (editing) editName(false);
  drawSessionTools();
  sessionSay("");
}
$("session-save").addEventListener("click", async (ev) => {
  if (!ev.isTrusted || !base || !canSave) return;
  sessionSay("");
  const res = await post("session", { op: "save" }).catch(() => null);
  if (res?.status === 404) {
    const had = document.activeElement === $("session-save");
    canSave = false;
    drawSessionTools();
    if (had) $("share-btn").focus();
    return;
  }
  const r = res ? await res.json().catch(() => null) : null;
  if (!r?.ok) return sessionSay(r?.error || "Couldn't reach PairBrowse.", "error");
  const when = typeof r.savedAt === "string" ? ago(r.savedAt) : "";
  if (when) { $("session-saved").hidden = false; $("session-saved").textContent = `Saved ${when}`; } else sessionSay("Saved.", "ok");
});
$("session-rename").addEventListener("click", () => { if (canRename) editName(true); });
$("session-name-input").addEventListener("keydown", async (ev) => {
  if (ev.key === "Escape") { ev.preventDefault(); return editName(false, true); }
  if (ev.key !== "Enter" || !ev.isTrusted || renaming) return;
  ev.preventDefault();
  const name = ev.target.value.trim();
  if (!name || !base) return editName(false, true);
  renaming = true;
  sessionSay("");
  const res = await post("session", { op: "rename", name }).catch(() => null);
  renaming = false;
  if (res?.status === 404) {
    const had = [$("session-name-input"), $("session-rename")].includes(document.activeElement);
    canRename = false;
    editName(false);
    if (had) $("share-btn").focus();
    return;
  }
  const r = res ? await res.json().catch(() => null) : null;
  if (!r?.ok) return sessionSay(r?.error || "Couldn't reach PairBrowse.", "error");
  if (typeof r.name === "string") $("session-name").textContent = r.name;
  editName(false, true);
});
$("session-name-input").addEventListener("blur", () => { if (editing && !renaming) editName(false); });
$("session-fold").addEventListener("click", () => {
  const fold = !$("session-actions").hidden;
  $("session-actions").hidden = fold;
  if (fold) endAsk(false, false);
  $("session-fold").setAttribute("aria-expanded", String(!fold));
  $("session-fold").setAttribute("aria-label", fold ? "Show the session buttons" : "Hide the session buttons");
});

// The state line, in words and a dot: only what the stream said.
function setDriver() {
  const turn = document.body.dataset.turn === "true";
  const s = document.body.dataset.s;
  const driving = !turn && !paused && s === "live" && Date.now() - lastActivity < DRIVING_MS;
  document.body.dataset.driving = String(driving);
  const [text, state] = s === "none" ? ["No agent connected", "closed"]
    : s === "closed" ? ["The browser is closed. It reopens on Claude's next action.", "closed"]
    : s === "connecting" ? ["Waiting for PairBrowse", "connecting"]
    : turn ? ["Waiting for you", "you"]
    : paused ? [pauseInfo?.by ? `Paused by ${pauseInfo.by}` : "Paused", "paused"]
    : driving ? ["Working…", "working"]
    : ["Idle", "idle"];
  $("driver-text").textContent = text;
  $("driver").dataset.state = state;
  // Where the card goes while no agent is named: no helper at all, or none in this session.
  $("agent-none-title").textContent = s === "none" ? "No agent connected" : "No agent in this session";
  $("status-live").hidden = !driving;
  if ($("agent-name").textContent !== agentName(activeEntry())) drawAgent();
  markCurrent();
}
// The one re-check after the last action, when "Working…" turns "Idle".
function armDrive() {
  clearTimeout(driveTimer);
  driveTimer = setTimeout(setDriver, DRIVING_MS + 500);
}

// The header (extension host): the session pill ("Live session" while someone is joined, else
// where and which session) and who is in it, as initials in their board colors (four, then "+N").
function drawHeader() {
  const w = $("where");
  const live = (lastCollab?.guests || []).length > 0;
  if (lastSession?.name) {
    w.dataset.clean = String(!!lastSession.temporary);
    w.title = `${lastSession.where} · ${lastSession.name}`;
  }
  w.dataset.live = String(live);
  w.hidden = !live && !lastSession?.name;
  if (live) w.replaceChildren(el("i", { ariaHidden: "true" }), document.createTextNode("Live session"));
  else if (lastSession?.name) w.replaceChildren(document.createTextNode(`${lastSession.where} · `), el("b", { textContent: lastSession.name }));
  const seen = new Set();
  const people = [];
  for (const p of lastBoard.people) if (p?.who && !seen.has(p.who)) { seen.add(p.who); people.push({ name: p.who, color: p.color }); }
  for (const g of lastCollab?.guests || []) if (g?.label && !seen.has(g.label)) { seen.add(g.label); people.push({ name: g.label, color: "" }); }
  const shown = people.slice(0, 4).map((p) => el("li", {}, avatar(p.name, p.color)));
  if (people.length > 4) {
    const more = el("span", { className: "avatar more", textContent: `+${people.length - 4}` });
    more.setAttribute("role", "img");
    more.setAttribute("aria-label", `${people.length - 4} more`);
    shown.push(el("li", {}, more));
  }
  $("avatars").replaceChildren(...shown);
}

// The agent the card is about: the one whose action is newest, else the first agent at work in
// this browser.
function activeEntry() {
  const agents = lastBoard.people.filter((p) => p?.kind === "agent");
  if (lastWho) return agents.find((p) => p.who === lastWho) || null;
  return agents.find((p) => !p.where && !quiet(p)) || null;
}
const agentName = (entry) => whose(lastWho || entry?.who || "");

// The active agent's card: avatar in its color, name, its own status text (pairbrowse_status,
// in the Status box) and the tab it is in (the name's title).
function drawAgent() {
  const entry = activeEntry();
  // No card for an agent nobody named: until the helper reports one (an action or the board),
  // the card is hidden and #agent-none says so.
  const named = !!(lastWho || entry || lastBoard.people.some((p) => p?.kind === "agent"));
  $("agent").hidden = !named;
  $("agent-none").hidden = named;
  const name = agentName(entry);
  $("agent-name").textContent = name;
  const a = $("agent-avatar");
  a.textContent = initialOf(splitLabel(lastWho || entry?.who || "Claude").name);
  a.style.background = isColor(entry?.color) ? entry.color : "var(--spark)";
  $("agent-status-text").textContent = entry?.task || "No status from the agent yet.";
  // The tab it is in: the name's tooltip, not a line of the Status box (#agent-tab stays, hidden
  // and empty: the side panel's ids are pinned).
  const tab = entry?.tab || (!entry || entry.who === lastWho ? lastTab : "");
  $("agent-name").title = tab ? `In ${tab}` : "";
  $("agent-tab").hidden = true;
  $("agent-tab").textContent = "";
  $("agent-tab").title = "";
}

// Everyone else in a shared session (both browsers), the active agent not repeated: one row
// each, a chevron to the board's task and last action, and "Pause this agent" only when the
// helper says it can pause one agent.
const openRows = new Set();
// The part someone plays, in words: an agent at work helps, an agent between actions observes, one
// waiting for its person says so; a person in the session is active.
const PARTS = { working: "helping", you: "waiting for their person", done: "done", idle: "observing" };
const partWord = (p) => (p.kind === "person" ? "active" : Object.hasOwn(PARTS, p.status) ? PARTS[p.status] : "observing");
const takeIcon = () => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 18 18", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "aria-hidden": "true" })) s.setAttribute(k, v);
  for (const d of ["M7.5 8.6a2.9 2.9 0 1 0 0-5.8 2.9 2.9 0 0 0 0 5.8z", "M2.2 15.6c.4-2.9 2.6-4.6 5.3-4.6s4.9 1.7 5.3 4.6z", "M14.4 3.4v4.2M12.3 5.5h4.2"]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    if (d.startsWith("M2.2") || d.startsWith("M7.5")) path.setAttribute("fill", "currentColor");
    s.append(path);
  }
  return s;
};
function drawPeople() {
  const all = lastBoard.people;
  const active = activeEntry();
  const people = all.filter((p) => !quiet(p) && p !== active);
  const idle = all.filter(quiet).length;
  const perAgent = !!(pauseInfo?.perAgent && pauseInfo?.can);
  $("people").replaceChildren(...people.map((p, i) => {
    const { name, app } = splitLabel(p.who);
    const face = avatar(name, p.color);
    face.removeAttribute("role");
    face.removeAttribute("aria-label");
    face.setAttribute("aria-hidden", "true");
    // Two lines: the name, then its part in the session in words (the mockup's "Observing",
    // "Helping", "Active") with what it does and whose browser; the tab stays in the title.
    const word = partWord(p);
    const rest = [p.task, p.where ? `${p.where}'s browser` : ""].filter(Boolean).join(" · ");
    const st = el("small", { className: "st", title: [word, p.task, p.tab, p.where ? `${p.where}'s browser` : ""].filter(Boolean).join(" · ") }, el("span", { className: "state", textContent: word }), ...(rest ? [document.createTextNode(` · ${rest}`)] : []));
    if (isColor(p.color)) st.style.setProperty("--who", p.color);
    const lines = [p.task, p.last].filter(Boolean);
    const acts = el("div", { className: "acts", id: `acts-${i}` }, ...lines.map((t) => el("small", { textContent: t })));
    acts.hidden = !openRows.has(p.who);
    const kids = [face, el("strong", { className: "name", textContent: name, title: p.who }, ...(app ? [el("span", { className: "app", textContent: ` · ${app}` })] : [])), st];
    if (p.kind === "agent" && perAgent) {
      const stop = el("button", { className: "pause-one", type: "button", title: `Pause ${name}: you take control` }, takeIcon(), "Take control");
      // A person's click or key press: a synthetic event pauses nothing.
      stop.addEventListener("click", (ev) => { if (ev.isTrusted && base) post("pause", { paused: true, who: p.who }).catch(() => {}); });
      kids.push(stop);
    }
    if (lines.length) {
      const chev = el("button", { className: "chev", type: "button" });
      chev.setAttribute("aria-expanded", String(!acts.hidden));
      chev.setAttribute("aria-label", `Show ${name}'s last actions`);
      chev.setAttribute("aria-controls", acts.id);
      chev.addEventListener("click", () => {
        acts.hidden = !acts.hidden;
        if (acts.hidden) openRows.delete(p.who); else openRows.add(p.who);
        chev.setAttribute("aria-expanded", String(!acts.hidden));
      });
      kids.push(chev);
    }
    kids.push(acts);
    const li = el("li", {}, ...kids);
    li.dataset.state = p.kind === "person" ? "active" : p.status || "idle";
    return li;
  }), ...(idle ? [el("li", { className: "idle" }, el("small", { textContent: `+ ${idle} idle agent${idle === 1 ? "" : "s"} in this browser` }))] : []));
}

// ---- Pictures: the picture last sent to the agent, fetched only while the tab is in front and
// the page is visible, held as a blob: URL until the next replaces it. ----
const known = new Map(); // id -> card, from timeline.json and the timeline events (newest 50)
let newest = null, shownId = null, pictureUrl = null, timelineKnown = false, timelineBusy = false, pictureSeq = 0;
const picturesShown = () => !document.hidden && document.body.dataset.tab === "pictures" && !["rail", "hidden"].includes(document.documentElement.dataset.dock);
const remember = (card) => {
  if (!card || !PICTURE_ID.test(card.id || "")) return;
  known.delete(card.id);
  known.set(card.id, card);
  if (known.size > 50) known.delete(known.keys().next().value);
};
async function showPictures() {
  if (!base || !picturesShown()) return;
  if (!timelineKnown) {
    if (timelineBusy) return;
    timelineBusy = true;
    const from = base;
    // null: no timeline (404, timeline off); undefined: not reached, asked again next time.
    const r = await fetch(base + "timeline.json", { signal: AbortSignal.timeout(8000) }).then((x) => (x.ok ? x.json() : x.status === 404 ? null : undefined)).catch(() => undefined);
    timelineBusy = false;
    if (from !== base || r === undefined) return;
    timelineKnown = true;
    const cards = Array.isArray(r?.cards) ? r.cards.filter((c) => c && c.note !== true && PICTURE_ID.test(c.id || "")) : [];
    for (const c of cards) remember(c);
    if (!newest && cards.length) newest = cards.reduce((a, b) => ((Number(b.t) || 0) >= (Number(a.t) || 0) ? b : a));
  }
  if (newest && newest.id !== shownId) drawPicture(newest);
}
function showCard(card) {
  if (!card || !PICTURE_ID.test(card.id || "")) return;
  newest = card;
  if (base && picturesShown()) drawPicture(card);
}
async function drawPicture(card) {
  if (!picturesShown()) return;
  const seq = ++pictureSeq;
  const blob = await fetch(`${base}timeline/${card.id}.jpg`, { signal: AbortSignal.timeout(8000) }).then((x) => (x.ok ? x.blob() : null)).catch(() => null);
  if (seq !== pictureSeq || !blob) return;
  const url = URL.createObjectURL(blob);
  const img = $("picture-img");
  img.src = url;
  img.alt = card.caption || "Picture sent to the agent";
  const t = Number(card.t);
  const time = $("picture-time");
  time.textContent = Number.isFinite(t) && t > 0 ? clock(t) : "";
  if (Number.isFinite(t) && t > 0) time.dateTime = new Date(t).toISOString(); else time.removeAttribute("datetime");
  $("picture-caption").textContent = card.caption || "";
  if (pictureUrl) URL.revokeObjectURL(pictureUrl);
  pictureUrl = url;
  shownId = card.id;
  $("picture").hidden = false;
  $("pictures-empty").hidden = true;
}

// Another helper: nothing of the last one's pictures stays on screen as if current.
function forgetPictures() {
  known.clear();
  newest = null;
  shownId = null;
  timelineKnown = false;
  pictureSeq++;
  if (pictureUrl) URL.revokeObjectURL(pictureUrl);
  pictureUrl = null;
  $("picture-img").removeAttribute("src");
  $("picture").hidden = true;
  $("pictures-empty").hidden = false;
}

function connect(url) {
  if (!url || url === base) return;
  if (base) { forgetPictures(); forgetSessionTools(); tools.forget(); }
  base = url;
  stream?.close();
  stream = helperStream(base, {
    kind: pb ? "right" : "",
    onState: (s) => { document.body.dataset.s = s; setDriver(); drawSessionCard(); },
    onOpen: () => { profile.load(); checklistStale = true; scheduleChecklist(); if (document.body.dataset.tab === "pictures") showPictures(); tools.stale(); },
  });
  const on = stream.on;
  on("status", (s) => {
    document.body.dataset.turn = String(s.kind === "you" && !!s.text);
    $("turn-text").textContent = s.text || "Your turn";
    setDriver();
  });
  on("session", (s) => {
    // Save and rename only when this helper says it has them (lane H's routes); never probed.
    canSave = s?.canSave === true;
    canRename = s?.canRename === true;
    drawSessionTools();
    if (!s.name) return;
    lastSession = s;
    $("session-name").textContent = s.name;
    $("session-line").hidden = editing;
    $("session-card").dataset.clean = String(!!s.temporary);
    $("session-card").title = `${s.where} · ${s.name}`;
    drawSessionCard();
    drawHeader();
  });
  on("collaboration", (c) => {
    const count = c.participants?.length || 0;
    const person = c.active?.label || c.owner?.label;
    $("collaboration").textContent = `${count} connected${person ? ` · ${person} has control` : ""}`;
    lastCollab = c;
    drawHeader();
  });
  on("activity", (list) => {
    const items = list.slice(-ACTIVITY_SHOWN).reverse();
    if (!items.length) return;
    lastActivity = Math.max(lastActivity, items[0].t);
    const was = activeEntry();
    lastWho = items[0].who || "";
    lastTab = items[0].tab || "";
    $("activity").replaceChildren(...items.map((a) => el("li", {}, el("time", { textContent: clock(a.t) }), el("span", {}, ...(activityHead(a) ? [el("strong", { textContent: `${activityHead(a)}: ` })] : []), rich(a.text)))));
    setDriver();
    if (!unseen()) armDrive();
    drawAgent();
    // The list changes only when the active agent does.
    if (activeEntry() !== was) drawPeople();
    checklistStale = true;
    scheduleChecklist();
  });
  // A shared session: everyone in it, both browsers, and what they said to each other (shown
  // only; a message is information, never something the page acts on).
  on("board", (b) => {
    const all = Array.isArray(b?.people) ? b.people : [];
    const messages = Array.isArray(b?.messages) ? b.messages : [];
    $("session").hidden = !messages.length;
    lastBoard = { people: all, messages };
    drawPeople();
    drawAgent();
    drawHeader();
    $("messages").replaceChildren(...messages.slice(-6).reverse().map((m) => el("li", {}, el("time", { textContent: `${clock(m.t)} ` }), el("strong", { textContent: `${m.from}${m.to && m.to !== "all" ? ` to ${m.to}` : ""}: ` }), document.createTextNode(m.text))));
  });
  // Agents paused by a person, session-wide. Pressed by people only; agents have no way to.
  on("pause", (p) => {
    pauseInfo = p || null;
    paused = !!p?.paused;
    document.body.dataset.paused = String(paused);
    $("pause").hidden = false;
    $("pause-btn").hidden = !p?.can;
    $("pause-btn").textContent = paused ? "Resume" : "Pause";
    $("pause-btn").setAttribute("aria-label", paused ? "Resume agents" : "Pause agents");
    $("pause-text").replaceChildren(...(paused ? [document.createTextNode("Paused by "), el("b", { textContent: p.by || "someone" })] : [document.createTextNode("Agents can act in the browser")]));
    setDriver();
    drawPeople();
  });
  on("record", (r) => {
    // A recording saved: its row first in Recordings; a state in the same event still applies.
    if (r?.op === "saved") tools.saved(r.item);
    // Only an event that says the state moves it: an op notice without `recording` leaves it.
    if (typeof r?.recording !== "boolean") return;
    const was = !!recording;
    recording = r?.recording ? { since: r.since || Date.now() } : null;
    if (was !== !!recording || recording) drawRecord();
  });
  // The timeline (pictures sent to the agent): a new card replaces the one shown; "show" brings
  // one to the front. Notes carry no picture.
  on("timeline", (e) => {
    if (e?.op === "add" && e.card && e.card.note !== true) { remember(e.card); showCard(e.card); }
    else if (e?.op === "show" && PICTURE_ID.test(e.id || "")) {
      const card = e.card || known.get(e.id) || { id: e.id, caption: "" };
      newest = card;
      // selectTab draws `newest` itself; fetch once, and not again for the card on screen.
      if (document.body.dataset.tab !== "pictures") selectTab("pictures");
      else if (shownId !== card.id) showCard(card);
    }
    // "remove": the picture shown stays until the next replaces it.
  });
  on("downloads", tools.downloads);
  on("handoffs", tools.handoffs);
  // The tab the left dock's Tools row asked for (POST layout's tab, relayed, never kept). The
  // sides are the browser's (native) or not this page's to show (served): never read here.
  on("layout", (l) => { if (typeof l?.tab === "string" && TABS.includes(l.tab)) selectTab(l.tab); });
  on("profile", profile.draw);
  on("join", drawJoins);
  on("dev", drawDev);
  on("joinhost", drawHosts);
}

// The session card (name, Save, Share, End session) only for a session the helper named, and
// not while there is no helper or its stream has closed: never controls for a session that is
// not there.
function drawSessionCard() {
  const s = document.body.dataset.s;
  $("session-card").hidden = !lastSession?.name || s === "none" || s === "closed";
}

// The helper's address: from the browser in the build, else from the extension's storage (null
// on a page opened without it, a plain file, which then renders with its defaults and connects
// to nothing).
const store = (area) => { try { return globalThis.chrome?.storage?.[area] || null; } catch { return null; } };
// No helper to ask (no browser API and no extension storage, or the browser has no helper
// address): the strip's words, not a wait for something that is not coming.
function noHelper() {
  if (base) return;
  document.body.dataset.s = "none";
  setDriver();
  drawSessionCard();
}
if (pb) pb.session.helper().then(({ origin, key }) => { if (origin && key) connect(`${origin}/${key}/`); else noHelper(); }).catch(noHelper);
else {
  const area = store("session");
  if (!area) noHelper();
  else area.get("view").then(({ view }) => connect(view)).catch(() => {});
  try { globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => { if (area === "session" && changes.view) connect(changes.view.newValue); }); } catch {}
}

// Hidden (the page, or the dock in the browser build): no timer runs (the driving re-check, the
// checklist's pending read, the recording clock); back in front, each is re-armed from the state
// it left.
function sleepTimers() {
  clearTimeout(driveTimer);
  clearTimeout(checklistTimer);
  checklistTimer = 0;
  clearInterval(recordTimer);
}
function wakeTimers() {
  if (unseen()) return;
  setDriver();
  if (Date.now() - lastActivity < DRIVING_MS) armDrive();
  if (checklistStale) scheduleChecklist();
  if (recording) drawRecord();
  if (document.body.dataset.tab === "pictures") showPictures();
  if (document.body.dataset.tab === "tools") tools.show();
}
document.addEventListener("visibilitychange", () => (document.hidden ? sleepTimers() : wakeTimers()));

// Sections that fold: Activity, Hand-offs, Downloads and Recordings open, the rest folded, as this
// person left them (one key in the extension's local storage: the folded sections' names).
// Diagnostics reads the helper when it opens, so it always starts folded and is never stored.
// Folded content stays in the page.
const KEYS = ["session", "dev", "hosts", "activity", "details", "secrets", "handoffs", "downloads", "recordings", "diagnostics"];
const OPEN = new Set(["activity", "handoffs", "downloads", "recordings"]);
const DEFAULT_COLLAPSED = KEYS.filter((k) => !OPEN.has(k));
let collapsed = DEFAULT_COLLAPSED;
function applyCollapsed(list) {
  collapsed = list;
  for (const sec of document.querySelectorAll("section.sec[data-key]")) {
    const shut = collapsed.includes(sec.dataset.key);
    const btn = sec.querySelector(".disclose");
    btn.setAttribute("aria-expanded", String(!shut));
    $(btn.getAttribute("aria-controls")).hidden = shut;
  }
}
for (const btn of document.querySelectorAll("section.sec[data-key] .disclose")) {
  btn.addEventListener("click", () => {
    const key = btn.closest("section").dataset.key;
    applyCollapsed(collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key]);
    if (key === "diagnostics" && !collapsed.includes(key)) tools.diagnostics();
    try { store("local")?.set({ "pb-panel": { collapsed: collapsed.filter((k) => k !== "diagnostics") } }).catch(() => {}); } catch {}
  });
}
const local = store("local");
if (local) local.get("pb-panel").then(({ "pb-panel": p }) => applyCollapsed(Array.isArray(p?.collapsed) ? [...p.collapsed.filter((k) => KEYS.includes(k) && k !== "diagnostics"), "diagnostics"] : DEFAULT_COLLAPSED)).catch(() => {});
else applyCollapsed(DEFAULT_COLLAPSED);
