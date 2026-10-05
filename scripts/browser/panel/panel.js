// The PairBrowse side panel. Connects to the live view server (status, activity, profile) at the
// address the daemon handed to background.js; it never asks for the page stream itself.
import { $, el, rich, clock, whose, activityHead, sparkIcon, joinBanners, profilePanel, devPanel } from "./common.js";

const DRIVING_MS = 8000; // "is driving" for this long after Claude's last action
const ACTIVITY_SHOWN = 12;
let base = null;
let es = null;
let lastActivity = 0;
let lastWho = "";
let driveTimer = 0;
let paused = false;
// The session picker again (a person's choice: agents' next actions wait for it).
$("switch-btn").addEventListener("click", () => {
  if (base) fetch(base + "picker", { method: "POST" }).catch(() => {});
});
$("pause-btn").addEventListener("click", () => {
  if (base) fetch(base + "pause", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused: !paused }) }).catch(() => {});
});

$("driver").prepend(sparkIcon("spark"));
const drawJoins = joinBanners($("joins"), () => base);
const drawDev = devPanel($("dev-asks"), $("devs"), $("dev"), () => base);
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
    const w = $("where");
    w.hidden = false;
    w.dataset.clean = String(!!s.temporary);
    w.replaceChildren(document.createTextNode(`${s.where} · `), el("b", { textContent: s.name }));
  });
  on("collaboration", (c) => {
    const count = c.participants?.length || 0;
    const person = c.active?.label || c.owner?.label;
    $("collaboration").textContent = `${count} connected${person ? ` · ${person} has control` : ""}`;
  });
  on("activity", (list) => {
    const items = list.slice(-ACTIVITY_SHOWN).reverse();
    if (!items.length) return;
    lastActivity = Math.max(lastActivity, items[0].t);
    lastWho = items[0].who || "";
    $("activity").replaceChildren(...items.map((a) => el("li", {}, el("time", { textContent: clock(a.t) }), el("span", {}, ...(activityHead(a) ? [el("strong", { textContent: `${activityHead(a)}: ` })] : []), rich(a.text)))));
    setDriver();
    clearTimeout(driveTimer);
    driveTimer = setTimeout(setDriver, DRIVING_MS + 500);
  });
  // A shared session: everyone in it, both browsers, and what they said to each other (shown
  // only; a message is information, never something the panel acts on).
  on("board", (b) => {
    const all = Array.isArray(b?.people) ? b.people : [];
    const messages = Array.isArray(b?.messages) ? b.messages : [];
    $("session").hidden = all.length < 2 && !messages.length && !all.some((p) => p.where);
    // Idle agents here with no tab of their own (other Claude Code and Codex windows connected,
    // doing nothing): one line, not a card each. People, agents at work and the other side's show.
    const quiet = (p) => p.kind === "agent" && !p.where && !p.tab && !p.task && (!p.status || p.status === "idle");
    const people = all.filter((p) => !quiet(p));
    const idle = all.length - people.length;
    const STATES = { working: "working", you: "waiting for their person", done: "done", idle: "idle" };
    $("people").replaceChildren(...people.map((p) => {
      const dot = el("i");
      if (/^#[0-9a-f]{6}$/i.test(p.color || "")) dot.style.background = p.color;
      const where = [p.where ? `${p.where}'s browser` : "this browser", p.tab].filter(Boolean).join(" · ");
      return el("li", {}, dot, el("strong", { textContent: p.who }), el("small", {}, el("span", { className: "state", textContent: STATES[p.status] || "idle" }), document.createTextNode(` · ${where}`)),
        ...(p.task || p.last ? [el("small", { textContent: p.task || p.last })] : []));
    }), ...(idle ? [el("li", { className: "idle" }, el("small", { textContent: `+ ${idle} idle agent${idle === 1 ? "" : "s"} in this browser` }))] : []));
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
  on("profile", profile.draw);
  on("join", drawJoins);
  on("dev", drawDev);
}
chrome.storage.session.get("view").then(({ view }) => connect(view));
chrome.storage.onChanged.addListener((changes, area) => { if (area === "session" && changes.view) connect(changes.view.newValue); });
