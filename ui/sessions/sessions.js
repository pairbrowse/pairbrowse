// All sessions (pairbrowse://sessions in the PairBrowse browser, opened from the switcher's "All
// sessions…"; sessions/index.html in the extension): every saved session with when it was last used,
// and what the helper honours for each (DESIGN.md Part H: nothing else is offered).
// - Switch: POST pick { action: "use", name } (428 while agents are at work: asked here, then sent
//   again with confirm: true). Not on the open session.
// - Rename: POST session { op: "rename", name } on the open session (the helper reopens the browser
//   on it), and { op: "rename", name, from } on a saved one that isn't open (renamed in place,
//   nothing restarts), only while the helper's session event says it takes from (canRenameSaved:
//   an older helper would rename the open one instead). Never "default", never a fresh session.
// - Delete: POST pick { action: "delete", name }, after a question in the row; never the open session
//   or "default" (the helper refuses those too).
// - Start a fresh session (POST pick { action: "new" }) and Join a shared session (POST pick
//   { action: "join", code, joinName }, its address question through POST joinhost).
// A tab page: in the browser only window.pairbrowse.session exists here, so nothing else is called.
// The list is GET sessions.json on every (re)connect, then the helper's sessions and session events:
// no timer, no poll, no observer.
import { $, el, ago, initialOf, helperStream, askSwitch, reportOffer, NO_AGENT, noAgentLine } from "../common.js";

const NATIVE = !!window.pairbrowse;
const FILTER_FROM = 6; // the search shows from this many saved sessions
const NAME = /^[A-Za-z0-9_-]{1,40}$/; // the helper's session names (scripts/sessions.mjs validName)
const NO_REACH = "Couldn't reach PairBrowse. Try again.";

let base = null;
let stream = null;
let session = null; // the helper's session event: { name, temporary, canRename, ... }
let state = null; // the last sessions.json / sessions event
let busy = false;
let switchCancel = null; // the open switch question's Cancel path (Escape)
let askCancel = null; // the open address question's Cancel path (Escape)

const say = (text, kind = "") => { $("msg").textContent = text; $("msg").dataset.kind = kind; };
const real = (ev) => ev.isTrusted;
const shownName = (name) => (name === "default" ? "Default" : String(name));
const postJson = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }), () => ({ status: 0, body: null }));

// ---- the line under the title: the open session, as the helper says it ----
function drawSub() {
  if (document.body.dataset.s === "none") return;
  const name = typeof session?.name === "string" ? session.name.trim() : "";
  $("sub").textContent = session?.temporary === true ? "You're in a fresh session: it's deleted when you switch away."
    : name ? `You're in ${shownName(name)}.` : "";
}

// ---- the list ----
function meta(s) {
  const tabs = Number(s.tabs) || 0;
  const sites = Array.isArray(s.sites) ? s.sites.filter((x) => typeof x === "string") : [];
  const used = Number(s.used) > 0 ? `Last used ${ago(new Date(Number(s.used)).toISOString())}` : "Not used yet";
  return [used, tabs ? `${tabs} ${tabs === 1 ? "tab" : "tabs"}${sites.length ? ` · ${sites.join(", ")}` : ""}` : "No saved tabs"].join(" · ");
}
function row(s) {
  const name = shownName(s.name);
  const live = Array.isArray(s.live) ? s.live : [];
  const face = el("span", { className: "avatar", textContent: initialOf(name) });
  face.setAttribute("aria-hidden", "true");
  const head = el("strong", {}, el("span", { className: "name", textContent: name, title: name }));
  if (s.current) head.append(el("em", { className: "open", textContent: "Open now" }));
  if (live.length) head.append(el("em", { className: "live", textContent: `Live · ${live.length} ${live.length === 1 ? "other" : "others"}` }));
  const text = el("span", { className: "text" }, head, el("small", { textContent: meta(s) }));
  const acts = el("span", { className: "acts" });
  const li = el("li", {}, face, text, acts);
  li.dataset.name = String(s.name);
  const buttons = [];
  if (!s.current) {
    const sw = el("button", { className: "secondary", type: "button", textContent: "Switch", ariaLabel: `Switch to ${name}` });
    sw.addEventListener("click", (ev) => { if (real(ev)) send({ action: "use", name: s.name }, `Opening ${name}…`); });
    buttons.push(sw);
  }
  // Rename: the open session while the helper allows it (its session event's canRename); another
  // saved session while the helper takes from (canRenameSaved). Never "default".
  const renames = s.name !== "default" && (s.current ? session?.temporary !== true && session?.canRename !== false : session?.canRenameSaved === true);
  if (renames) {
    const rn = el("button", { className: "secondary", type: "button", textContent: "Rename", ariaLabel: `Rename ${name}` });
    rn.addEventListener("click", (ev) => { if (real(ev)) renameIn(li, s.name, !!s.current); });
    buttons.push(rn);
  }
  if (!s.current && s.name !== "default") {
    const del = el("button", { className: "secondary danger", type: "button", textContent: "Delete", ariaLabel: `Delete session ${name}` });
    del.addEventListener("click", (ev) => { if (real(ev)) askDelete(li, acts, buttons, s.name); });
    buttons.push(del);
  }
  acts.append(...buttons);
  return li;
}
// A row asking its question (delete, rename) keeps it while the list redraws for something else.
const asking = () => [...$("list").children].find((li) => li.dataset.asking === "true");
function draw(next) {
  if (!next || typeof next !== "object") return;
  state = next;
  const list = Array.isArray(next.sessions) ? next.sessions.filter((s) => s && typeof s.name === "string" && s.name) : [];
  const keep = asking();
  const focused = keep?.contains(document.activeElement) ? document.activeElement : null;
  const rows = list.map((s) => (keep && keep.dataset.name === s.name ? keep : row(s)));
  $("list").replaceChildren(...(rows.length ? rows : [el("li", { className: "empty", textContent: "No saved sessions yet." })]));
  // Moving the asking row puts it back as it was, the focus too.
  if (focused?.isConnected) focused.focus();
  $("filter").hidden = list.length < FILTER_FROM;
  if ($("filter").hidden) $("filter").value = "";
  filter();
}
function filter() {
  const q = $("filter").value.trim().toLowerCase();
  let shown = 0, total = 0;
  for (const li of $("list").children) {
    if (!li.dataset.name) continue;
    total++;
    li.hidden = !!q && !li.dataset.name.toLowerCase().includes(q) && !shownName(li.dataset.name).toLowerCase().includes(q);
    if (!li.hidden) shown++;
  }
  $("none").hidden = !total || shown > 0;
}
async function load() {
  const r = await fetch(base + "sessions.json").then(async (x) => ({ status: x.status, body: x.ok ? await x.json().catch(() => null) : null }), () => ({ status: 0, body: null }));
  if (r.status === 404) { $("list").replaceChildren(el("li", { className: "empty", textContent: "This PairBrowse doesn't list sessions." })); return; }
  if (r.body) draw(r.body);
}

// ---- delete, asked in the row (a tab page may get no confirm() dialog in a slot; one style for all) ----
function askDelete(li, acts, buttons, name) {
  const shown = shownName(name);
  const yes = el("button", { className: "primary danger", type: "button", textContent: "Delete", ariaLabel: `Yes, delete session ${shown}` });
  const keep = el("button", { className: "secondary", type: "button", textContent: "Keep" });
  const back = () => { li.dataset.asking = "false"; acts.replaceChildren(...buttons); buttons.at(-1).focus(); };
  keep.addEventListener("click", back);
  yes.addEventListener("click", async (ev) => {
    if (!real(ev) || !base) return;
    yes.disabled = keep.disabled = true;
    yes.setAttribute("aria-busy", "true");
    say(`Deleting ${shown}…`);
    const r = await postJson("pick", { action: "delete", name });
    li.dataset.asking = "false";
    if (r.status === 200 && r.body && !r.body.error) { say(r.body.text || `Deleted ${shown}.`, "ok"); load(); return; }
    say(r.body?.text || r.body?.error || (r.status === 0 ? NO_REACH : "That didn't work."), "error");
    if (li.isConnected) back();
  });
  li.dataset.asking = "true";
  acts.replaceChildren(el("small", { className: "question", textContent: "Delete it with its logins?" }), yes, keep);
  keep.focus();
}

// ---- rename, in the row (the open session: the helper reopens the browser on the new name; a
// saved one that isn't open: renamed in place) ----
function renameIn(li, name, open) {
  const text = li.querySelector(".text"), acts = li.querySelector(".acts");
  const before = [...acts.children];
  const input = el("input", { type: "text", value: name, maxLength: 40, ariaLabel: `New name for ${shownName(name)}`, spellcheck: false, autocomplete: "off" });
  const save = el("button", { className: "primary", type: "submit", textContent: "Save" });
  const cancel = el("button", { className: "secondary", type: "button", textContent: "Cancel" });
  const form = el("form", { className: "rename" }, input, save, cancel);
  const back = () => { li.dataset.asking = "false"; form.replaceWith(text); acts.replaceChildren(...before); acts.hidden = false; before[before.length - 1]?.focus(); };
  cancel.addEventListener("click", back);
  form.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); back(); } });
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!ev.isTrusted || !base) return;
    const to = input.value.trim();
    if (to === name) { back(); return; }
    if (!NAME.test(to)) { say("Session names use letters, numbers, - and _ (up to 40).", "error"); input.focus(); return; }
    save.disabled = cancel.disabled = input.disabled = true;
    save.setAttribute("aria-busy", "true");
    say(`Renaming to ${to}…`);
    const r = await postJson("session", open ? { op: "rename", name: to } : { op: "rename", name: to, from: name });
    if (r.status === 200 && r.body?.ok) {
      say(r.body.restarting ? `Renamed to ${r.body.name || to}. The browser reopens on it.` : `Renamed to ${r.body.name || to}.`, "ok");
      li.dataset.asking = "false";
      load();
      return;
    }
    save.disabled = cancel.disabled = input.disabled = false;
    save.removeAttribute("aria-busy");
    say(r.body?.error || r.body?.text || (r.status === 0 ? NO_REACH : "That didn't work."), "error");
    input.focus();
  });
  li.dataset.asking = "true";
  text.replaceWith(form);
  acts.hidden = true;
  input.focus();
  input.select();
}

// ---- switch, start fresh, join (POST pick, as the picker sends them) ----
async function send(op, label) {
  if (!base || busy) return;
  if (switchCancel) { const c = switchCancel; switchCancel = null; c(); }
  busy = true;
  document.body.dataset.s = "picking";
  say(label);
  const r = await postJson("pick", op);
  busy = false;
  document.body.dataset.s = "live";
  const body = r.body || { text: NO_REACH, error: true };
  if (body.error || r.status !== 200) {
    if (body.hostAsk?.id && body.hostAsk.host) { showHostAsk(body.hostAsk); say(""); return; }
    if (body.confirm && op.confirm !== true && (op.action === "use" || op.action === "new")) {
      say("");
      switchCancel = askSwitch($("switch-ask"), body, {
        yes: () => { switchCancel = null; send({ ...op, confirm: true }, label); },
        no: () => { switchCancel = null; say("Not switched."); },
      });
      return;
    }
    say(body.text || "That didn't work.", "error");
    reportOffer(base).then((a) => { if (a && $("msg").dataset.kind === "error") $("msg").append(" ", a); });
    return;
  }
  say(body.text || "Done.", "ok");
}
$("fresh").addEventListener("click", (ev) => { if (real(ev)) send({ action: "new" }, "Starting a fresh session…"); });
$("join-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (!ev.isTrusted) return;
  const code = $("code").value.trim();
  if (!/^pb-join:\S+$/.test(code)) { say("A join code starts with pb-join:", "error"); return; }
  send({ action: "join", code, joinName: $("join-name").value.trim().slice(0, 40) }, "Asking to join…");
});
$("join").addEventListener("toggle", () => { if ($("join").open) $("code").focus(); });
// The address question (the picker's): Allow once, Always allow or Cancel, by a person's click.
function showHostAsk({ id, host }) {
  const box = $("host-ask");
  const once = el("button", { className: "primary", type: "button", textContent: "Allow once" });
  const always = el("button", { className: "secondary", type: "button", textContent: "Always allow", title: "Remember this address in your config (joinHosts)." });
  const cancel = el("button", { className: "secondary", type: "button", textContent: "Cancel" });
  const all = [once, always, cancel];
  async function answer(op, label) {
    if (!base || busy) return;
    busy = true;
    for (const b of all) b.disabled = true;
    say(label);
    const r = await postJson("joinhost", op);
    busy = false;
    askCancel = null;
    box.hidden = true;
    box.replaceChildren();
    const body = r.body || { error: NO_REACH };
    if (body.error || (op.op === "allow" && !body.joined)) { say(body.error || body.text || "That didn't work.", "error"); return; }
    if (op.op === "cancel") { say("Not joined."); return; }
    say(body.text || "Done.", "ok");
  }
  once.addEventListener("click", (ev) => { if (real(ev) && ev.detail > 0) answer({ op: "allow", id, always: false }, "Asking to join…"); });
  always.addEventListener("click", (ev) => { if (real(ev) && ev.detail > 0) answer({ op: "allow", id, always: true }, "Asking to join…"); });
  cancel.addEventListener("click", (ev) => { if (real(ev)) answer({ op: "cancel", id }, ""); });
  askCancel = () => answer({ op: "cancel", id }, "");
  box.replaceChildren(el("strong", {}, "This code leads to ", el("code", { className: "host", textContent: String(host) }), ", not a PairBrowse address. Join through it?"), el("span", { className: "buttons" }, ...all));
  box.hidden = false;
  once.focus();
}
$("filter").addEventListener("input", filter);
// Escape answers the open question with its Cancel; a filled search clears first, as the field does.
document.addEventListener("keydown", (ev) => {
  if (!ev.isTrusted || ev.key !== "Escape" || busy) return;
  if (ev.target === $("filter") && $("filter").value) return;
  if (askCancel) { askCancel(); return; }
  if (switchCancel) { const c = switchCancel; switchCancel = null; c(); }
});

// ---- the helper ----
function none() {
  document.body.dataset.s = "none";
  $("sub").textContent = `${NO_AGENT}. ${noAgentLine("Your sessions")}`;
}
function connect(url) {
  if (!url || url === base) return;
  base = url;
  stream?.close();
  stream = helperStream(base, {
    onState: (s) => {
      if (s === "live") { if (!busy) document.body.dataset.s = "live"; drawSub(); }
      else if (s === "closed") none();
      else if (document.body.dataset.s !== "none") document.body.dataset.s = "connecting";
    },
    onOpen: load,
  });
  stream.on("sessions", draw);
  stream.on("session", (s) => {
    session = s && typeof s === "object" ? s : null;
    drawSub();
    if (state) draw(state); // Rename follows canRename and the open session
  });
}
function helperBase() {
  if (NATIVE) {
    return Promise.resolve().then(() => window.pairbrowse.session.helper())
      .then((h) => (h && h.origin && h.key ? `${h.origin}/${h.key}/` : null)).catch(() => null);
  }
  try {
    const store = globalThis.chrome?.storage?.session;
    if (!store) return Promise.resolve(null);
    try { globalThis.chrome.storage.onChanged.addListener((changes, area) => { if (area === "session" && changes.view) connect(changes.view.newValue); }); } catch {}
    return store.get("view").then((r) => r?.view || null).catch(() => null);
  } catch { return Promise.resolve(null); }
}
helperBase().then((b) => (b ? connect(b) : none()));
