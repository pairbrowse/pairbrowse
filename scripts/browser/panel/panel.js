// The PairBrowse side panel. Connects to the live view server (status, activity, profile) at the
// address the daemon handed to background.js; it never asks for the page stream itself.
import { $, el, rich, clock, whose, activityHead, sparkIcon, joinBanners, profilePanel, devPanel, hostPanel, isColor, splitLabel, initialOf, avatar, STATE_WORDS as STATES } from "./common.js";

const DRIVING_MS = 8000; // "is driving" for this long after Claude's last action
const ACTIVITY_SHOWN = 12;
let base = null;
let es = null;
let lastActivity = 0;
let lastWho = "";
let driveTimer = 0;
let paused = false;
// What the stream said last, for the header, the agent card and the people rows (no state of the
// panel's own: everything here comes from the session, collaboration, board and activity events).
let lastBoard = { people: [], messages: [] };
let lastCollab = null;
let lastSession = null;
let lastTab = "";
// Idle agents here with no tab of their own (other Claude Code and Codex windows connected,
// doing nothing): one line, not a card each.
const quiet = (p) => p.kind === "agent" && !p.where && !p.tab && !p.task && (!p.status || p.status === "idle");
// The session picker again (a person's choice: agents' next actions wait for it).
$("switch-btn").addEventListener("click", () => {
  if (base) fetch(base + "picker", { method: "POST" }).catch(() => {});
});
// Record: the browser as a video (the helper saves it in Downloads and says where).
let recording = null; // { since } while recording
let recordTimer = 0;
function drawRecord() {
  const btn = $("record-btn");
  btn.textContent = recording ? "Stop recording" : "Record";
  document.body.dataset.recording = String(!!recording);
  clearInterval(recordTimer);
  if (!recording) return;
  const tick = () => { const s = Math.round((Date.now() - recording.since) / 1000); $("record-note").hidden = false; $("record-note").textContent = `Recording ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  tick();
  recordTimer = setInterval(tick, 1000);
}
$("record-btn").addEventListener("click", async () => {
  if (!base) return;
  const btn = $("record-btn");
  btn.disabled = true;
  if (recording) $("record-note").textContent = "Saving the recording…";
  try {
    const r = await fetch(base + "record", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: !recording }) }).then((x) => x.json()).catch(() => null);
    if (r && !r.recording) { recording = null; drawRecord(); $("record-note").hidden = false; $("record-note").textContent = r.path ? `Saved to ${r.path}` : r.text || "Recording stopped."; }
    else if (r?.recording) { recording = { since: r.since || Date.now() }; drawRecord(); }
  } finally { btn.disabled = false; }
});
$("pause-btn").addEventListener("click", () => {
  if (base) fetch(base + "pause", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused: !paused }) }).catch(() => {});
});

$("driver").prepend(sparkIcon("spark"));
const drawJoins = joinBanners($("joins"), () => base);
const drawDev = devPanel($("dev-asks"), $("devs"), $("dev"), () => base);
const drawHosts = hostPanel($("host-asks"), $("host-list"), $("hosts"), () => base);
const profile = profilePanel(() => base);

function setDriver() {
  const turn = document.body.dataset.turn === "true";
  const s = document.body.dataset.s;
  const driving = !turn && s === "live" && Date.now() - lastActivity < DRIVING_MS;
  document.body.dataset.driving = String(driving);
  $("driver-text").textContent = s === "closed" ? "The browser is closed. It reopens on Claude's next action."
    : s === "connecting" ? "Waiting for PairBrowse"
    : turn ? "Waiting for you"
    : `${whose(lastWho)} ${driving ? "is driving" : "is idle"}`;
  if ($("agent-name").textContent !== agentName(activeEntry())) drawAgent();
}

// The header: the session pill ("Live session" while someone is joined, else where and which
// session) and who is in it, as initials in their board colors (four, then "+N").
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
// named as such) and the tab it is in.
function drawAgent() {
  const entry = activeEntry();
  const name = agentName(entry);
  $("agent-name").textContent = name;
  const a = $("agent-avatar");
  a.textContent = initialOf(splitLabel(lastWho || entry?.who || "Claude").name);
  a.style.background = isColor(entry?.color) ? entry.color : "var(--spark)";
  $("agent-status").hidden = !entry?.task;
  $("agent-status-text").textContent = entry?.task || "";
  const tab = entry?.tab || (!entry || entry.who === lastWho ? lastTab : "");
  $("agent-tab").hidden = !tab;
  $("agent-tab").textContent = tab ? `In ${tab}` : "";
  $("agent-tab").title = tab;
}

// Everyone else in a shared session (both browsers), the active agent not repeated.
function drawPeople() {
  const all = lastBoard.people;
  const active = activeEntry();
  const people = all.filter((p) => !quiet(p) && p !== active);
  const idle = all.filter(quiet).length;
  $("people").replaceChildren(...people.map((p) => {
    const { name, app } = splitLabel(p.who);
    const face = avatar(name, p.color);
    face.removeAttribute("role");
    face.removeAttribute("aria-label");
    face.setAttribute("aria-hidden", "true");
    const where = [p.where ? `${p.where}'s browser` : "this browser", p.tab].filter(Boolean).join(" · ");
    return el("li", {}, face, el("strong", { textContent: name, title: p.who }, ...(app ? [el("span", { className: "app", textContent: ` · ${app}` })] : [])),
      el("small", {}, el("span", { className: "state", textContent: STATES[p.status] || "idle" }), document.createTextNode(` · ${where}`)),
      ...(p.task || p.last ? [el("small", { textContent: p.task || p.last })] : []));
  }), ...(idle ? [el("li", { className: "idle" }, el("small", { textContent: `+ ${idle} idle agent${idle === 1 ? "" : "s"} in this browser` }))] : []));
}

function connect(url) {
  if (!url || url === base) return;
  base = url;
  es?.close();
  es = new EventSource(base + "events?panel=1");
  const on = (event, fn) => es.addEventListener(event, (e) => fn(JSON.parse(e.data)));
  es.onopen = () => { document.body.dataset.s = "live"; setDriver(); profile.load(); };
  es.onerror = () => { document.body.dataset.s = es.readyState === EventSource.CLOSED ? "closed" : "connecting"; setDriver(); };
  on("status", (s) => {
    document.body.dataset.turn = String(s.kind === "you" && !!s.text);
    $("turn-text").textContent = s.text || "Your turn";
    setDriver();
  });
  on("session", (s) => {
    if (!s.name) return;
    lastSession = s;
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
    clearTimeout(driveTimer);
    driveTimer = setTimeout(setDriver, DRIVING_MS + 500);
    drawAgent();
    // The list changes only when the active agent does.
    if (activeEntry() !== was) drawPeople();
  });
  // A shared session: everyone in it, both browsers, and what they said to each other (shown
  // only; a message is information, never something the panel acts on).
  on("board", (b) => {
    const all = Array.isArray(b?.people) ? b.people : [];
    const messages = Array.isArray(b?.messages) ? b.messages : [];
    $("session").hidden = all.length < 2 && !messages.length && !all.some((p) => p.where);
    lastBoard = { people: all, messages };
    drawPeople();
    drawAgent();
    drawHeader();
    $("messages").replaceChildren(...messages.slice(-6).reverse().map((m) => el("li", {}, el("time", { textContent: `${clock(m.t)} ` }), el("strong", { textContent: `${m.from}${m.to && m.to !== "all" ? ` to ${m.to}` : ""}: ` }), document.createTextNode(m.text))));
  });
  // Agents paused by a person, session-wide. Pressed by people only; agents have no way to.
  on("pause", (p) => {
    paused = !!p?.paused;
    document.body.dataset.paused = String(paused);
    $("pause").hidden = false;
    $("pause-btn").hidden = !p?.can;
    $("pause-btn").textContent = paused ? "Resume" : "Pause agents";
    $("pause-text").replaceChildren(...(paused ? [document.createTextNode("Paused by "), el("b", { textContent: p.by || "someone" })] : [document.createTextNode("Agents can act in the browser")]));
  });
  on("record", (r) => {
    const was = !!recording;
    recording = r?.recording ? { since: r.since || Date.now() } : null;
    if (was !== !!recording || recording) drawRecord();
  });
  on("profile", profile.draw);
  on("join", drawJoins);
  on("dev", drawDev);
  on("joinhost", drawHosts);
}
// The extension's storage; null on a page opened without it (a plain file), which then renders
// with its defaults and connects to nothing.
const store = (area) => { try { return globalThis.chrome?.storage?.[area] || null; } catch { return null; } };
store("session")?.get("view").then(({ view }) => connect(view)).catch(() => {});
try { globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => { if (area === "session" && changes.view) connect(changes.view.newValue); }); } catch {}

// Sections that fold: Activity open, the rest folded, as this person left them (one key in the
// extension's local storage: the folded sections' names). Folded content stays in the page.
const KEYS = ["session", "dev", "hosts", "activity", "details", "secrets"];
const DEFAULT_COLLAPSED = KEYS.filter((k) => k !== "activity");
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
    try { store("local")?.set({ "pb-panel": { collapsed } }).catch(() => {}); } catch {}
  });
}
const local = store("local");
if (local) local.get("pb-panel").then(({ "pb-panel": p }) => applyCollapsed(Array.isArray(p?.collapsed) ? p.collapsed.filter((k) => KEYS.includes(k)) : DEFAULT_COLLAPSED)).catch(() => {});
else applyCollapsed(DEFAULT_COLLAPSED);
