// The session picker: the browser's first tab when it starts and nobody chose a session yet, and
// in the browser build also the session switcher (the same page in a same-origin frame of the
// browser's own strip). Web pages can't open, frame or script it. It talks to the helper through
// the live view with the owner's key: in the build from the browser's Session API
// (window.pairbrowse), in the extension from the side panel's worker (chrome.storage.session).
// The live view takes these requests only from the page's own origin.
import { $, el, avatar, initialOf, reportOffer, askSwitch, NO_AGENT, noAgentLine } from "../common.js";
import { JOIN_NAME_MAX } from "../limits.js";
import { followHelper, postJson } from "../helper.js";

// Framed: the switcher popover. No page chrome of its own, the list even when a session is open,
// and the parent told (same origin only) when to close; the pick itself goes only to the helper.
// In the browser's own switcher bubble (530 E2 B1, #bubble): the same popover, but a page of its
// own (a frame gets no bindings, so only a page reaches the helper), and the bubble is closed through
// the browser after a pick or on Escape (the browser then puts the focus back on the logo).
const pb = window.pairbrowse || null;
const bubbled = location.hash === "#bubble" && typeof pb?.bubbles?.close === "function";
const framed = window.top !== window || bubbled;
document.documentElement.dataset.host = framed ? "frame" : "page";
if (bubbled) document.documentElement.dataset.bubble = "native";
const SWITCHER = Number.isInteger(pb?.BubbleKind?.kSwitcher) ? pb.BubbleKind.kSwitcher : 0;
const notify = (op) => {
  if (bubbled) pb.bubbles.close(SWITCHER).catch(() => {});
  else if (framed) window.parent.postMessage({ source: "pairbrowse-picker", op }, location.origin);
};

let base = null;
let busy = false;
// The open address question's Cancel path (set while the card shows), for Escape.
let askCancel = null;
// The open switch question's Cancel path (agents at work: the helper's 428), for Escape.
let switchCancel = null;

const say = (text, kind = "") => { $("msg").textContent = text; $("msg").dataset.kind = kind; };
const QUESTION = "Which session?";
// The line under the question: what the helper said, never more. An agent waits only while the
// helper reports a pick pending (sessions.json `picking`).
const WAITS = "Your agent waits until you pick one.";
const SWITCH = "Switch to another session, or start one.";
const head = (title, sub) => {
  if ($("title").textContent !== title) $("title").textContent = title;
  if ($("sub").textContent !== sub) $("sub").textContent = sub;
};
// No helper to ask, or none reached: the resting state (DESIGN.md B4's words), muted, no list and
// no error. The list comes back on its own: the refresh below (visible only) or the address
// arriving reads sessions.json again.
function none() {
  document.body.dataset.s = "none";
  head(NO_AGENT, noAgentLine("Your sessions"));
  say("");
  drawn = "";
}
// A person's click or key press only, never a script's synthetic event.
const real = (ev) => ev.isTrusted;

async function send(op, label) {
  if (!base || busy) return;
  // Another choice while the switch question shows drops that question.
  if (switchCancel) { const c = switchCancel; switchCancel = null; c(); }
  busy = true;
  document.body.dataset.s = "picking";
  say(label);
  const r = await postJson(base + "pick", op)
    .then((x) => x.json(), () => ({ text: "Couldn't reach PairBrowse. Try again.", error: true }))
    .catch(() => ({ text: "Couldn't reach PairBrowse. Try again.", error: true }));
  busy = false;
  if (r.error) {
    document.body.dataset.s = "ready";
    // The code is fine but leads somewhere other than a PairBrowse address: the person decides.
    if (r.hostAsk?.id && r.hostAsk.host) { showHostAsk(r.hostAsk); say(""); return; }
    // Agents are at work in the open session (428): the person decides here, then the same pick
    // goes again with confirm: true.
    if (r.confirm && op.confirm !== true && (op.action === "use" || op.action === "new")) {
      say("");
      switchCancel = askSwitch($("switch-ask"), r, {
        yes: () => { switchCancel = null; send({ ...op, confirm: true }, label); },
        no: () => { switchCancel = null; say("Not switched."); },
      });
      return;
    }
    say(r.text || "That didn't work.", "error");
    // A refused pick: offer Report a problem when the helper relays reports (Part H).
    reportOffer(base).then((a) => { if (a && $("msg").dataset.kind === "error") $("msg").append(" ", a); });
    return;
  }
  // Switching sessions closes this window; joining keeps this tab with what happens next.
  document.body.dataset.s = "done";
  say(r.text || "Done.", "ok");
  notify("picked");
}

const TOP = 3; // sessions shown at once; the rest are under "More sessions"
const CHIPS = 3;
const GENERIC = /^(Claude|Codex|Agent)$/;
// "Mac · You", "Alice · Linux", "Bob · Codex": who, and their computer or app.
function chipText(p) {
  if (p.kind === "you") return `${p.computer || "This computer"} · You`;
  if (p.kind === "agent") return GENERIC.test(p.who) ? p.app || p.who : `${p.who} · ${p.app || "Agent"}`;
  return [p.who, p.computer || p.app].filter(Boolean).join(" · ");
}
// A steady color per name, from the side panel's palette.
const HUES = [215, 155, 45, 300, 25, 260];
const hue = (name) => HUES[[...String(name)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length];
// The name a person goes by on a chip or an avatar: "You", the app for a generic agent, else theirs.
const shownName = (p) => (p.kind === "you" ? "You" : GENERIC.test(p.who) ? p.app || p.who : p.who);
// The row's mark: whoever is in the session now, else who used it last, in their steady color;
// a session nobody used yet shows its own initial.
function rowAvatar(people, name) {
  if (!people.length) return avatar(name);
  const a = avatar(shownName(people[0]));
  a.classList.replace("plain", "hued");
  a.style.setProperty("--h", hue(people[0].who));
  return a;
}
function chip(p, live = false) {
  const text = chipText(p);
  const dot = el("i", { className: "avatar", textContent: initialOf(shownName(p)) });
  dot.setAttribute("aria-hidden", "true");
  dot.style.setProperty("--h", hue(p.who));
  // The words stay in the row's accessible text and the tooltip; the row shows the initial.
  return el("span", { className: live ? "chip live" : "chip", title: live ? `${text}, in this session now` : text }, dot, el("span", { className: "chip-text", textContent: text }));
}
function sessionRow(s) {
  const name = s.name === "default" ? "Default" : s.name;
  const live = Array.isArray(s.live) ? s.live : [];
  // Framed (the 360 px switcher), a row both Last used and Live has no room for two whole pills
  // and a readable name: Last used moves to the start of the meta line, Live keeps its pill.
  const foldLast = framed && s.current && live.length > 0;
  const meta = (foldLast ? "Last used · " : "") + (s.tabs ? `${s.tabs} ${s.tabs === 1 ? "tab" : "tabs"}${s.sites.length ? ` · ${s.sites.join(", ")}` : ""}` : "No saved tabs");
  const badges = [];
  if (s.current && !foldLast) badges.push(el("em", { textContent: "Last used" }));
  if (live.length) {
    const names = live.map((p) => [p.who, p.computer || p.app].filter(Boolean).join(" on ")).join(", ");
    const pill = el("em", { className: "live", textContent: `Live · ${live.length} ${live.length === 1 ? "other" : "others"}`, title: names });
    pill.dataset.live = "true";
    badges.push(pill);
  }
  // The people in it now first, then who used it before; at most CHIPS, then "+N".
  const seen = new Set(live.map(chipText));
  const people = [...live.map((p) => ({ ...p, live: true })), ...(s.people || []).filter((p) => !seen.has(chipText(p)))];
  // Framed (the 360 px switcher), a Live row shows only the people in it now and "+N", so the
  // name keeps its room beside the pills.
  const max = framed && live.length ? Math.min(live.length, CHIPS) : CHIPS;
  const chips = people.slice(0, max).map((p) => chip(p, p.live));
  if (people.length > max) chips.push(el("span", { className: "chip more-chip", textContent: `+${people.length - max}`, title: people.slice(max).map(chipText).join(", ") }));
  const button = el("button", { className: "choice", type: "button" },
    rowAvatar(people, name),
    el("span", { className: "text" }, el("strong", {}, el("span", { className: "name", textContent: name }), ...badges), el("small", { textContent: meta }),
      ...(chips.length ? [el("span", { className: "chips" }, ...chips)] : [])));
  button.addEventListener("click", (ev) => { if (real(ev)) send({ action: "use", name: s.name }, `Opening ${name}...`); });
  const li = el("li", {}, button);
  li.dataset.name = s.name.toLowerCase();
  return li;
}

let drawn = "";
async function load() {
  const state = await fetch(base + "sessions.json").then((r) => (r.ok ? r.json() : null), () => null);
  if (busy || document.body.dataset.s === "done" || document.body.dataset.s === "picking") return;
  if (!state) return none();
  // A session is open: the first tab's question is over; the switcher still lists them to switch
  // to. As a tab (a build without the switcher bubble, or the first tab once a session is chosen)
  // it offers "All sessions…" in place of a dead end: the sessions page, in this tab.
  if (!state.picking && !framed) {
    document.body.dataset.s = "open";
    head(QUESTION, "A session is already open.");
    $("all").hidden = false;
    return;
  }
  head(QUESTION, state.picking ? WAITS : SWITCH);
  // "All sessions…" only in the switcher, and not while an agent waits for this pick.
  $("all").hidden = !framed || !!state.picking;
  // Redrawn only when something changed (someone joined or left), keeping the filter.
  const sig = JSON.stringify(state.sessions);
  if (sig === drawn) return;
  drawn = sig;
  // Most recently used first (the helper's order); the rest behind "More sessions", with a filter.
  const sessions = state.sessions;
  $("sessions").replaceChildren(...sessions.slice(0, TOP).map(sessionRow));
  // No saved session to continue: no heading over an empty list, and no "Or" before the choices.
  $("continue-h").hidden = $("or-h").hidden = !sessions.length;
  // Opened, "More sessions" lists them all (with the filter) in place of the top ones.
  const rest = sessions.length - TOP;
  $("more").hidden = rest <= 0;
  $("more").dataset.count = String(rest);
  setMoreLabel();
  $("more-list").replaceChildren(...sessions.map(sessionRow));
  document.body.dataset.s = "ready";
  say("");
  $("filter").dispatchEvent(new Event("input"));
}

$("fresh").addEventListener("click", (ev) => { if (real(ev)) send({ action: "new" }, "Starting a fresh session..."); });
// "All sessions…", the switcher's last item: the sessions page in the contents (the full list, with
// rename and delete). Framed in a plain browser it opens as a new tab and the switcher closes. In
// the browser's bubble (Session and Bubbles only: no tab of its own to open) it asks the dock whose
// Sessions row opened it over the pairbrowse-sessions channel (this origin only); that dock holds the
// pairbrowse-switcher-opener lock while its bubble shows, so with no lock held nobody would answer
// and the item says so at once. A dock that holds it but never answers (gone mid-ask) gets
// OPENER_MS, then the item says so the same way and is clickable again. The bubble closes once the
// dock says the page is open.
const OPENER_LOCK = "pairbrowse-switcher-opener";
const OPENER_MS = 3000;
if (framed && !bubbled) { $("all").target = "_blank"; $("all").rel = "noopener"; }
$("all").addEventListener("click", async (ev) => {
  if (!framed) return;
  if (!bubbled) { notify("close"); return; }
  ev.preventDefault();
  if (!real(ev) || $("all").getAttribute("aria-busy") === "true") return;
  const failed = () => { $("all").removeAttribute("aria-busy"); say("Couldn't open the sessions list from here. Open pairbrowse://sessions in a tab.", "error"); };
  $("all").setAttribute("aria-busy", "true");
  const held = await Promise.resolve().then(() => navigator.locks.query()).then((s) => (s?.held || []).some((l) => l.name === OPENER_LOCK), () => false);
  let ch = null;
  try { ch = held ? new BroadcastChannel("pairbrowse-sessions") : null; } catch {}
  if (!ch) { failed(); return; }
  const late = setTimeout(() => { ch.close(); failed(); }, OPENER_MS);
  ch.onmessage = (e) => {
    if (e.data?.opened !== "sessions") return;
    clearTimeout(late);
    ch.close();
    $("all").removeAttribute("aria-busy");
    say("");
    notify("all");
  };
  ch.postMessage({ open: "sessions" });
});
// The code is only ever what the person typed or pasted here: nothing fills it in.
$("join-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (!ev.isTrusted) return;
  const code = $("code").value.trim();
  if (!/^pb-join:\S+$/.test(code)) { say("A join code starts with pb-join:", "error"); return; }
  send({ action: "join", code, joinName: $("join-name").value.trim().slice(0, JOIN_NAME_MAX) }, "Asking to join...");
});
$("join").addEventListener("toggle", () => { if ($("join").open) $("code").focus(); });
// The address question (the same one the side panel shows): Allow once, Always allow (kept in
// joinHosts) or Cancel, by a real click here; a yes starts the join with the code pasted above.
function showHostAsk({ id, host }) {
  const box = $("host-ask");
  const once = el("button", { className: "primary", type: "button", textContent: "Allow once" });
  const always = el("button", { className: "secondary", type: "button", textContent: "Always allow", title: "Remember this address in your config (joinHosts)." });
  const cancel = el("button", { className: "secondary", type: "button", textContent: "Cancel" });
  const buttons = [once, always, cancel];
  async function answer(op, label) {
    if (!base || busy) return;
    busy = true;
    for (const b of buttons) b.disabled = true;
    document.body.dataset.s = "picking";
    say(label);
    const r = await postJson(base + "joinhost", op)
      .then((x) => x.json(), () => ({ error: "Couldn't reach PairBrowse. Try again." }))
      .catch(() => ({ error: "Couldn't reach PairBrowse. Try again." }));
    busy = false;
    askCancel = null;
    box.hidden = true;
    box.replaceChildren();
    if (r.error || (op.op === "allow" && !r.joined)) { document.body.dataset.s = "ready"; say(r.error || r.text || "That didn't work.", "error"); return; }
    if (op.op === "cancel") { document.body.dataset.s = "ready"; say("Not joined.", ""); return; }
    document.body.dataset.s = "done";
    say(r.text || "Done.", "ok");
    notify("picked");
  }
  once.addEventListener("click", (ev) => { if (real(ev) && ev.detail > 0) answer({ op: "allow", id, always: false }, "Asking to join..."); });
  always.addEventListener("click", (ev) => { if (real(ev) && ev.detail > 0) answer({ op: "allow", id, always: true }, "Asking to join..."); });
  cancel.addEventListener("click", (ev) => { if (real(ev)) answer({ op: "cancel", id }, ""); });
  askCancel = () => answer({ op: "cancel", id }, "");
  const question = el("strong", {}, "This code leads to ", el("code", { className: "host", textContent: String(host) }), ", not a PairBrowse address. Join through it?");
  box.replaceChildren(question, el("span", { className: "buttons" }, ...buttons));
  box.hidden = false;
  once.focus();
}
function setMoreLabel() {
  const open = $("more").dataset.open === "true";
  $("more-label").textContent = open ? "Fewer sessions" : `More sessions (${$("more").dataset.count || 0})`;
  $("sessions").hidden = open;
}
$("more-btn").addEventListener("click", () => {
  const open = $("more").dataset.open !== "true";
  $("more").dataset.open = String(open);
  $("more-btn").setAttribute("aria-expanded", String(open));
  setMoreLabel();
  if (open) $("filter").focus();
});
$("filter").addEventListener("input", () => {
  const q = $("filter").value.trim().toLowerCase();
  let shown = 0;
  for (const li of $("more-list").children) { li.hidden = !!q && !li.dataset.name.includes(q); if (!li.hidden) shown++; }
  $("none").hidden = shown > 0;
});

// Escape closes the switcher; the first Escape in a filled search clears it, as the field does,
// and Escape on the address question cancels it.
document.addEventListener("keydown", (ev) => {
  if (!framed || !ev.isTrusted || ev.key !== "Escape") return;
  if (ev.target === $("filter") && $("filter").value) return;
  // A pick in flight finishes first; Escape on the address question is its Cancel, not a close.
  if (document.body.dataset.s === "picking") return;
  if (!$("host-ask").hidden && askCancel) { askCancel(); return; }
  if (switchCancel) { switchCancel(); return; }
  notify("close");
});

// Who is in the open session can change while the picker shows: a refresh every 4 s while the
// page is visible, none while hidden, and one at once on return.
let timer = null;
function start() { if (timer === null) timer = setInterval(() => { if (base) load(); }, 4000); }
function stop() { if (timer !== null) { clearInterval(timer); timer = null; } }
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stop();
  else if (base) { load(); start(); }
});
function connect(url) {
  if (!url || url === base) return;
  base = url;
  load();
  if (!document.hidden) start();
}
// The helper's address and key: the browser's Session API in the build, else the extension's.
// A frame whose parent knows there is no helper (#none, common.js pickerPopover) shows the resting
// state at once. A frame given no binding of its own while its parent has a helper (DESIGN.md
// H4.1) says it couldn't reach PairBrowse: the switcher the person opened failed (Part H).
const lost = () => { if (framed) say("Couldn't reach PairBrowse.", "error"); else none(); };
// The browser answers with no address when it was started without a helper: nothing to reach. The
// extension's storage without one yet: the page waits for the worker to store it (ui/helper.js).
if (framed && location.hash === "#none") none();
else followHelper({ connect, none, failed: lost, wait: true });
