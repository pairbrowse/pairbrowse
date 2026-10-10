// The session picker: the browser's first tab when it starts and nobody chose a session yet.
// An extension page, so web pages can't open, frame or script it. It talks to the helper through
// the live view with the owner's key, which the side panel's worker holds in memory; the live view
// takes these requests only from this extension's origin.
import { $, el } from "./common.js";

let base = null;
let busy = false;

const say = (text, kind = "") => { $("msg").textContent = text; $("msg").dataset.kind = kind; };
// A person's click or key press only, never a script's synthetic event.
const real = (ev) => ev.isTrusted;

async function send(op, label) {
  if (!base || busy) return;
  busy = true;
  document.body.dataset.s = "picking";
  say(label);
  const r = await fetch(base + "pick", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(op) })
    .then((x) => x.json(), () => ({ text: "Couldn't reach PairBrowse. Try again.", error: true }))
    .catch(() => ({ text: "Couldn't reach PairBrowse. Try again.", error: true }));
  busy = false;
  if (r.error) {
    document.body.dataset.s = "ready";
    // The code is fine but leads somewhere other than a PairBrowse address: the person decides.
    if (r.hostAsk?.id && r.hostAsk.host) { showHostAsk(r.hostAsk); say(""); return; }
    say(r.text || "That didn't work.", "error");
    return;
  }
  // Switching sessions closes this window; joining keeps this tab with what happens next.
  document.body.dataset.s = "done";
  say(r.text || "Done.", "ok");
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
function chip(p, live = false) {
  const text = chipText(p);
  const dot = el("i", { textContent: (p.kind === "you" ? "Y" : (GENERIC.test(p.who) ? p.app || p.who : p.who)).slice(0, 1).toUpperCase() });
  dot.style.setProperty("--h", hue(p.who));
  return el("span", { className: live ? "chip live" : "chip", title: live ? `${text}, in this session now` : text }, dot, el("span", { textContent: text }));
}
function sessionRow(s) {
  const name = s.name === "default" ? "Default" : s.name;
  const meta = s.tabs ? `${s.tabs} ${s.tabs === 1 ? "tab" : "tabs"}${s.sites.length ? ` · ${s.sites.join(", ")}` : ""}` : "No saved tabs";
  const live = Array.isArray(s.live) ? s.live : [];
  const badges = [];
  if (s.current) badges.push(el("em", { textContent: "Last used" }));
  if (live.length) {
    const names = live.map((p) => [p.who, p.computer || p.app].filter(Boolean).join(" on ")).join(", ");
    badges.push(el("em", { className: "live", textContent: `Live · ${live.length} ${live.length === 1 ? "other" : "others"}`, title: names }));
  }
  // The people in it now first, then who used it before; at most CHIPS, then "+N".
  const seen = new Set(live.map(chipText));
  const people = [...live.map((p) => ({ ...p, live: true })), ...(s.people || []).filter((p) => !seen.has(chipText(p)))];
  const chips = people.slice(0, CHIPS).map((p) => chip(p, p.live));
  if (people.length > CHIPS) chips.push(el("span", { className: "chip more-chip", textContent: `+${people.length - CHIPS}`, title: people.slice(CHIPS).map(chipText).join(", ") }));
  const button = el("button", { className: "choice", type: "button" },
    el("span", { className: "icon session", textContent: name.slice(0, 1).toUpperCase(), ariaHidden: "true" }),
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
  if (!state) { document.body.dataset.s = "connecting"; say("Couldn't reach PairBrowse.", "error"); return; }
  if (!state.picking) {
    document.body.dataset.s = "done";
    if (!$("msg").textContent) say("A session is already open. You can close this tab.", "ok");
    return;
  }
  // Redrawn only when something changed (someone joined or left), keeping the filter.
  const sig = JSON.stringify(state.sessions);
  if (sig === drawn) return;
  drawn = sig;
  // Most recently used first (the helper's order); the rest behind "More sessions", with a filter.
  const sessions = state.sessions;
  $("sessions").replaceChildren(...sessions.slice(0, TOP).map(sessionRow));
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
// The code is only ever what the person typed or pasted here: nothing fills it in.
$("join-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (!ev.isTrusted) return;
  const code = $("code").value.trim();
  if (!/^pb-join:\S+$/.test(code)) { say("A join code starts with pb-join:", "error"); return; }
  send({ action: "join", code, joinName: $("join-name").value.trim().slice(0, 40) }, "Asking to join...");
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
    const r = await fetch(base + "joinhost", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(op) })
      .then((x) => x.json(), () => ({ error: "Couldn't reach PairBrowse. Try again." }))
      .catch(() => ({ error: "Couldn't reach PairBrowse. Try again." }));
    busy = false;
    box.hidden = true;
    box.replaceChildren();
    if (r.error || (op.op === "allow" && !r.joined)) { document.body.dataset.s = "ready"; say(r.error || r.text || "That didn't work.", "error"); return; }
    if (op.op === "cancel") { document.body.dataset.s = "ready"; say("Not joined.", ""); return; }
    document.body.dataset.s = "done";
    say(r.text || "Done.", "ok");
  }
  once.addEventListener("click", (ev) => { if (real(ev) && ev.detail > 0) answer({ op: "allow", id, always: false }, "Asking to join..."); });
  always.addEventListener("click", (ev) => { if (real(ev) && ev.detail > 0) answer({ op: "allow", id, always: true }, "Asking to join..."); });
  cancel.addEventListener("click", (ev) => { if (real(ev)) answer({ op: "cancel", id }, ""); });
  box.replaceChildren(el("strong", { textContent: `This code leads to ${String(host)}, not a PairBrowse address. Join through it?` }), el("span", { className: "buttons" }, ...buttons));
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

function connect(url) {
  if (!url || url === base) return;
  base = url;
  load();
}
// Who is in the open session can change while the picker shows.
setInterval(() => { if (base && !document.hidden) load(); }, 4000);
chrome.storage.session.get("view").then(({ view }) => connect(view));
chrome.storage.onChanged.addListener((changes, area) => { if (area === "session" && changes.view) connect(changes.view.newValue); });
