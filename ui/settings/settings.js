// PairBrowse Settings (pairbrowse://settings in the PairBrowse browser; settings/index.html, the
// extension's options page, in Chromium). Organized by what people come for (DESIGN.md Part H):
// General, Agents and approvals, Sharing, Your data, About and diagnostics, and one link to the
// browser's own settings. Every control reads the helper's current value and writes through a real
// owner route with the owner's key: config.json / config (the browser, the docks at a session's
// start, the timeline, the session question at start, downloads, pictures with results, cookie
// banners, open tabs, your name), profile.json / profile (passwords, remembered details), the
// joinhost event / joinhost (join addresses), sessions.json / pick { action: "delete" } (saved
// sessions), invites.json / invite { op: "revoke" } (invites out now), diagnostics.json and
// diagnostics/report, and report (Report a problem; shown only while the helper says it relays
// reports). The config, sessions and invites events keep them current. This is a tab page: in the browser only window.pairbrowse.session exists here, so the
// page never calls another interface. Nothing ticks: no timer, no observer; one shared event stream.
import { $, el, ago, initialOf, hostPanel, profilePanel, helperStream, reportPayload, sendReport, NO_AGENT, noAgentLine } from "../common.js";

const NATIVE = !!window.pairbrowse;
const HOST = NATIVE ? "The PairBrowse browser" : "Chromium with the PairBrowse extension";
document.body.dataset.host = NATIVE ? "pairbrowse" : "chromium";
$("about-host").textContent = HOST;
if (!NATIVE) {
  // The extension's side panel holds Tools and Share; the window's docks are not there.
  $("invites-text").textContent = "Make a join code or a watch link with Share in the PairBrowse side panel. Each one asks you before anyone gets in.";
  $("dev-note").textContent = "Share a dev server from the side panel's Tools while people are in your session.";
  $("agents-who-text").textContent = "Pause stops every agent at once; Take control stops one. Both are in the PairBrowse side panel.";
  $("asks-where").textContent = "You answer in the agent's app. The first answer counts.";
}

let base = null;
let stream = null;
let conn = "connecting";
let config = null; // GET config.json, null until read (or the helper has no such route)
let diag = null; // GET diagnostics.json

const say = (node, text, kind = "") => { node.textContent = text; node.dataset.kind = kind; };
const getJson = (path) => fetch(base + path).then(async (r) => ({ status: r.status, body: r.ok ? await r.json().catch(() => null) : await r.text().catch(() => "") })).catch(() => ({ status: 0, body: null }));
const postJson = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) })).catch(() => ({ status: 0, body: null }));

// ---- connection ------------------------------------------------------------------------------
const CONN_TEXT = { live: "Connected", connecting: "Connecting…", closed: NO_AGENT };
// No helper to ask, or it went away: the resting state in every page's words, muted (not an error).
const NO_HELPER = `${NO_AGENT}. ${noAgentLine("Your settings")}`;
function setConn(state, text) {
  conn = state;
  document.body.dataset.s = state;
  $("conn").textContent = text;
  const c = $("about-conn");
  c.dataset.s = state;
  c.textContent = CONN_TEXT[state] || state;
  // Nothing writes while the helper is away; what was read stays on screen.
  for (const f of document.querySelectorAll("main fieldset, main form")) f.toggleAttribute("disabled", state !== "live");
  for (const b of document.querySelectorAll("#tl-on, #ask-on, #pics-on, #dl-reset, #diag-copy, #report-open, .needs-live")) b.disabled = state !== "live";
}

// The live view's address with the owner's key: from the browser, or from the extension's session
// storage (in memory, never on disk), as the side panel gets it.
function helperBase() {
  if (NATIVE) {
    return Promise.resolve().then(() => window.pairbrowse.session.helper())
      .then((h) => (h && h.origin && h.key ? `${h.origin}/${h.key}/` : null)).catch(() => null);
  }
  try {
    const store = globalThis.chrome?.storage?.session;
    if (!store) return Promise.resolve(null);
    return store.get("view").then((r) => r?.view || null).catch(() => null);
  } catch { return Promise.resolve(null); }
}

// ---- General: the browser, the docks (config.json / config) ----------------------------------
function drawConfig(c) {
  config = c && typeof c === "object" ? c : null;
  const have = !!config;
  // The docks are the PairBrowse browser's window; the extension's Chromium has none.
  // An item for a field this helper doesn't answer with (an older helper) stays off the page.
  for (const n of document.querySelectorAll(".cfg-item")) n.hidden = !have || (!NATIVE && n.classList.contains("native-only")) || (!!n.dataset.field && !(n.dataset.field in config));
  for (const n of document.querySelectorAll(".cfg-missing")) n.hidden = have;
  if (!have) { applySearch(); return; }
  // The browser.
  const b = String(config.browser || "");
  const which = b === "pairbrowse" || b === "chromium" ? b : b ? "path" : "";
  for (const r of document.querySelectorAll("input[name=browser]")) r.checked = r.value === which;
  const pbRadio = document.querySelector("input[name=browser][value=pairbrowse]");
  pbRadio.disabled = !config.native && b !== "pairbrowse";
  $("choice-pairbrowse").classList.toggle("off", pbRadio.disabled);
  $("pairbrowse-small").textContent = pbRadio.disabled ? "Not built for this computer yet" : "Docks, timeline and approvals in the window";
  $("path-form").hidden = which !== "path";
  if (which === "path" && document.activeElement !== $("path")) $("path").value = b;
  // The docks a session starts with.
  for (const side of ["left", "right"]) {
    for (const r of document.querySelectorAll(`input[name=dock-${side}]`)) r.checked = r.value === config.layout?.[side];
  }
  // The timeline.
  const on = config.timeline?.on !== false;
  $("tl-on").setAttribute("aria-checked", String(on));
  if (document.activeElement !== $("tl-cap")) $("tl-cap").value = String(config.timeline?.cap ?? 200);
  $("cap-form").hidden = !on;
  $("cap-save").hidden = true;
  // The session question at start, downloads, pictures with results, cookie banners, open tabs, your name.
  $("ask-on").setAttribute("aria-checked", String(config.askSession !== false));
  const dl = typeof config.downloads === "string" && config.downloads ? config.downloads : null;
  $("dl-where").textContent = dl || "your Downloads folder";
  $("dl-where").classList.toggle("mono", !!dl);
  $("dl-acts").hidden = !dl;
  if (document.activeElement !== $("dl-path")) $("dl-path").value = dl || "";
  $("pics-on").setAttribute("aria-checked", String(config.pictures !== false));
  for (const r of document.querySelectorAll("input[name=cookies]")) r.checked = r.value === (config.cookies === "reject" ? "reject" : "accept");
  if (document.activeElement !== $("max-tabs")) $("max-tabs").value = String(config.maxTabs ?? 20);
  $("tabs-save").hidden = true;
  if (document.activeElement !== $("your-name-field")) $("your-name-field").value = typeof config.name === "string" ? config.name : "";
  // Report a problem: only while the helper relays reports.
  $("report-open").hidden = config.report !== true;
  applySearch();
}
async function loadConfig() {
  const r = await getJson("config.json");
  drawConfig(r.status === 200 ? r.body : null);
}
// One write; the answer is the whole settings again. -> the error text, or "".
async function writeConfig(body, msg) {
  if (!base || conn !== "live") { say(msg, "Not connected to PairBrowse.", "error"); return "offline"; }
  say(msg, "Saving…");
  const r = await postJson("config", body);
  if (r.status === 200 && r.body) {
    drawConfig(r.body);
    return "";
  }
  const text = r.body?.error || (r.status === 0 ? "Couldn't reach PairBrowse." : "That didn't save.");
  say(msg, text, "error");
  drawConfig(config); // back to the value the helper holds
  return text;
}

for (const r of document.querySelectorAll("input[name=browser]")) {
  r.addEventListener("change", async () => {
    if (!r.checked) return;
    if (r.value === "path") {
      $("path-form").hidden = false;
      $("path").focus();
      say($("browser-msg"), "Enter the path to a Chromium-based browser, then Use this browser.");
      return;
    }
    $("path-form").hidden = true;
    if (await writeConfig({ browser: r.value }, $("browser-msg"))) return;
    say($("browser-msg"), config?.restart ? "Saved. PairBrowse uses it from the browser's next start." : "Saved.", "ok");
  });
}
$("path-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const p = $("path").value.trim();
  if (!p) return say($("browser-msg"), "Enter the full path to the browser's program.", "error");
  if (await writeConfig({ browser: p }, $("browser-msg"))) { $("path-form").hidden = false; document.querySelector("input[name=browser][value=path]").checked = true; return; }
  say($("browser-msg"), config?.restart ? "Saved. PairBrowse uses it from the browser's next start." : "Saved.", "ok");
});
for (const seg of document.querySelectorAll(".seg")) {
  for (const r of seg.querySelectorAll("input")) {
    r.addEventListener("change", async () => {
      if (!r.checked) return;
      if (await writeConfig({ layout: { [seg.dataset.side]: r.value } }, $("docks-msg"))) return;
      say($("docks-msg"), "Saved. New sessions start this way.", "ok");
    });
  }
}

// ---- Your data: pictures (timeline on/off and cap) -------------------------------------------
$("tl-on").addEventListener("click", async () => {
  const on = $("tl-on").getAttribute("aria-checked") !== "true";
  if (await writeConfig({ timeline: { on } }, $("pictures-msg"))) return;
  say($("pictures-msg"), on ? "Pictures are kept from now on." : "Off. No new pictures are kept; the kept ones stay until you delete them or the session.", "ok");
  loadTimelineCount();
});
$("tl-cap").addEventListener("input", () => { $("cap-save").hidden = String(config?.timeline?.cap ?? "") === $("tl-cap").value; });
$("cap-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const cap = Number($("tl-cap").value);
  if (!Number.isInteger(cap) || cap < 1 || cap > 200) return say($("pictures-msg"), "Enter a whole number from 1 to 200.", "error");
  if (await writeConfig({ timeline: { cap } }, $("pictures-msg"))) return;
  say($("pictures-msg"), `Saved. At most ${cap} ${cap === 1 ? "picture" : "pictures"} per session.`, "ok");
});
// ---- General: the session question at start, downloads ---------------------------------------
$("ask-on").addEventListener("click", async () => {
  const on = $("ask-on").getAttribute("aria-checked") !== "true";
  if (await writeConfig({ askSession: on }, $("ask-msg"))) return;
  say($("ask-msg"), on ? "Saved. The browser asks which session from PairBrowse's next start." : "Saved. From PairBrowse's next start your agent asks you in the chat instead.", "ok");
});
$("dl-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const p = $("dl-path").value.trim();
  if (!p) return say($("dl-msg"), "Enter the full path to a folder, or use your Downloads folder.", "error");
  if (await writeConfig({ downloads: p }, $("dl-msg"))) { $("dl-path").value = p; return; }
  say($("dl-msg"), "Saved. Downloads go there from now on.", "ok");
});
$("dl-reset").addEventListener("click", async () => {
  if (await writeConfig({ downloads: null }, $("dl-msg"))) return;
  say($("dl-msg"), "Saved. Downloads go to your Downloads folder.", "ok");
});

// ---- Agents: pictures with results, cookie banners, open tabs ---------------------------------
$("pics-on").addEventListener("click", async () => {
  const on = $("pics-on").getAttribute("aria-checked") !== "true";
  if (await writeConfig({ pictures: on }, $("pics-msg"))) return;
  say($("pics-msg"), on ? "Saved. Each result carries a picture of the page." : "Saved. Agents get text only.", "ok");
});
for (const r of document.querySelectorAll("input[name=cookies]")) {
  r.addEventListener("change", async () => {
    if (!r.checked) return;
    if (await writeConfig({ cookies: r.value }, $("cookies-msg"))) return;
    say($("cookies-msg"), r.value === "reject" ? "Saved. Cookie banners get Reject." : "Saved. Cookie banners get Accept.", "ok");
  });
}
$("max-tabs").addEventListener("input", () => { $("tabs-save").hidden = String(config?.maxTabs ?? "") === $("max-tabs").value; });
$("tabs-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const n = Number($("max-tabs").value);
  if (!Number.isInteger(n) || n < 2 || n > 50) return say($("tabs-msg"), "Enter a whole number from 2 to 50.", "error");
  if (await writeConfig({ maxTabs: n }, $("tabs-msg"))) return;
  say($("tabs-msg"), `Saved. At most ${n} tabs stay open.`, "ok");
});

// ---- Sharing: your name -------------------------------------------------------------------------
$("name-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("your-name-field").value.trim().replace(/\s+/g, " ");
  if (name.length > 40) return say($("name-msg"), "Up to 40 characters.", "error");
  if (await writeConfig({ name }, $("name-msg"))) { $("your-name-field").value = name; return; }
  say($("name-msg"), name ? `Saved. People see you as ${name} when you join; your label here changes at PairBrowse's next start.` : "Saved. Joins ask your name again.", "ok");
});

async function loadTimelineCount() {
  const r = await getJson("timeline.json");
  const off = config && config.timeline?.on === false;
  let text;
  if (r.status === 200) {
    const n = Array.isArray(r.body?.cards) ? r.body.cards.filter((c) => c && c.note !== true).length : 0;
    text = `${n} ${n === 1 ? "picture" : "pictures"} kept in this session`;
  } else if (off) text = "Off";
  else if (r.status === 0) text = "Couldn't reach PairBrowse.";
  else text = "This PairBrowse keeps no timeline.";
  $("tl-state").textContent = text;
}

// ---- Sharing: join addresses (the joinhost event; Remove posts joinhost) ----------------------
// The asks themselves have one home, the agent panel (DESIGN.md Part G): here only the list.
const drawHosts = hostPanel(document.createElement("div"), $("host-list"), $("join-addresses"), () => base);
function hostsChanged(s) {
  drawHosts(s);
  $("join-addresses").hidden = false; // the section stays; its list or the empty line says it
  $("hosts-empty").hidden = $("host-list").children.length > 0;
  applySearch();
}

// ---- Your data: passwords and remembered details (profile.json / profile) ----------------------
const profile = profilePanel(() => base);

// ---- Your data: saved sessions (sessions.json, the sessions event; Delete posts pick) -----------
// Delete only for a saved session that isn't open and isn't "default" (the helper refuses those
// too), after a question in the row: pages in a window slot get no confirm() dialog.
async function deleteSession(name, shown) {
  if (!base || conn !== "live") return say($("sessions-msg"), "Not connected to PairBrowse.", "error");
  say($("sessions-msg"), `Deleting ${shown}…`);
  const r = await postJson("pick", { action: "delete", name });
  if (r.status === 200 && r.body && !r.body.error) {
    say($("sessions-msg"), r.body.text || `Deleted ${shown}.`, "ok");
    loadSessions(false);
    return true;
  }
  say($("sessions-msg"), r.body?.text || r.body?.error || (r.status === 0 ? "Couldn't reach PairBrowse." : "That didn't work."), "error");
  return false;
}
function sessionRow(s) {
  const name = s.name === "default" ? "Default" : String(s.name);
  const live = Array.isArray(s.live) ? s.live : [];
  const sites = Array.isArray(s.sites) ? s.sites : [];
  const face = el("span", { className: "avatar plain", textContent: initialOf(name) });
  face.setAttribute("aria-hidden", "true");
  const head = el("strong", {}, el("span", { className: "name", textContent: name, title: name }));
  if (s.current) head.append(el("em", { textContent: "This session" }));
  if (live.length) head.append(el("em", { className: "live", textContent: `Live · ${live.length} ${live.length === 1 ? "other" : "others"}` }));
  const tabs = Number(s.tabs) || 0;
  const meta = [
    tabs ? `${tabs} ${tabs === 1 ? "tab" : "tabs"}${sites.length ? ` · ${sites.join(", ")}` : ""}` : "No saved tabs",
    s.used ? `used ${ago(new Date(s.used).toISOString())}` : "",
  ].filter(Boolean).join(" · ");
  const li = el("li", {}, face, head, el("small", { textContent: meta }));
  li.dataset.name = String(s.name);
  if (s.current || s.name === "default") return li;
  const del = el("button", { className: "mini needs-live", type: "button", textContent: "Delete", ariaLabel: `Delete session ${name}`, disabled: conn !== "live" });
  const acts = el("span", { className: "acts-row" }, del);
  del.addEventListener("click", (ev) => {
    if (!ev.isTrusted) return;
    const yes = el("button", { className: "mini bad needs-live", type: "button", textContent: "Delete", ariaLabel: `Yes, delete session ${name}` });
    const keep = el("button", { className: "mini", type: "button", textContent: "Keep" });
    const back = () => { acts.replaceChildren(del); del.focus(); };
    keep.addEventListener("click", back);
    yes.addEventListener("click", async (e) => {
      if (!e.isTrusted) return;
      yes.disabled = keep.disabled = true;
      if (!(await deleteSession(s.name, name)) && acts.isConnected) back();
    });
    acts.replaceChildren(el("small", { className: "ask", textContent: "Delete it with its logins?" }), yes, keep);
    keep.focus();
  });
  li.append(acts);
  li.classList.add("has-acts");
  return li;
}
function drawSessions(state) {
  if (!state || typeof state !== "object") return;
  const list = Array.isArray(state.sessions) ? state.sessions.filter((s) => s && typeof s.name === "string" && s.name) : [];
  // A row asking its question keeps it while the list redraws for something else.
  const asking = [...$("session-list").querySelectorAll("li")].find((li) => li.querySelector(".ask"))?.dataset.name;
  const rows = list.map(sessionRow);
  if (asking) {
    const i = rows.findIndex((li) => li.dataset.name === asking);
    const old = [...$("session-list").children].find((li) => li.dataset.name === asking);
    if (i >= 0 && old) rows[i] = old;
  }
  $("session-list").replaceChildren(...(rows.length ? rows : [el("li", { className: "empty", textContent: "No saved sessions yet." })]));
  applySearch();
}
async function loadSessions(clear = true) {
  const r = await getJson("sessions.json");
  if (r.status !== 200 || !r.body) {
    $("session-list").replaceChildren();
    // Not reached at all: the banner says so and the list loads again on the next open; no red.
    if (r.status === 0) return say($("sessions-msg"), "");
    return say($("sessions-msg"), r.status === 404 ? "This PairBrowse doesn't list sessions." : "Couldn't read the sessions. They load again when PairBrowse reconnects.", "error");
  }
  drawSessions(r.body);
  if (clear) say($("sessions-msg"), "");
}

// ---- Sharing: invites out now (invites.json, the invites event; Revoke posts invite) ----------
const INVITE_ID = /^[0-9a-f]{8}$/;
function endsIn(at, now = Date.now()) {
  const ms = Number(at) - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 60_000) return "ends in a minute";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `ends in ${min} min`;
  const h = Math.round(min / 60);
  // An invite lasts 7 days at most: a later end is no time worth showing.
  return h < 48 ? `ends in ${h} h` : h <= 8 * 24 ? `ends in ${Math.round(h / 24)} days` : "";
}
async function revokeInvite(id, shown) {
  if (!base || conn !== "live") return say($("invites-msg"), "Not connected to PairBrowse.", "error");
  const r = await postJson("invite", { op: "revoke", id });
  if (r.status === 200 && r.body?.ok) {
    say($("invites-msg"), `Revoked ${shown}. Anyone using it is out.`, "ok");
    loadInvites();
    return true;
  }
  if (r.status === 404) { say($("invites-msg"), r.body?.error || "That invite had already ended.", "error"); loadInvites(); return true; }
  say($("invites-msg"), r.body?.error || (r.status === 0 ? "Couldn't reach PairBrowse." : "That didn't work."), "error");
  return false;
}
function inviteRow(i) {
  const shown = i.label ? String(i.label) : i.role === "watch" ? "a watch invite" : "a drive invite";
  const kind = i.share === "code" ? "Join code" : "Link";
  const rights = i.role === "watch" ? "can watch" : "can drive";
  const face = el("span", { className: "avatar plain", textContent: initialOf(i.label || kind) });
  face.setAttribute("aria-hidden", "true");
  const head = el("strong", {}, el("span", { className: "name", textContent: i.label ? String(i.label) : kind, title: i.label ? String(i.label) : kind }));
  const meta = [kind, rights, endsIn(i.expires)].filter(Boolean).join(" · ");
  const li = el("li", { className: "has-acts" }, face, head, el("small", { textContent: meta }));
  li.dataset.id = i.id;
  const revoke = el("button", { className: "mini needs-live", type: "button", textContent: "Revoke", ariaLabel: `Revoke ${shown}`, disabled: conn !== "live" });
  const acts = el("span", { className: "acts-row" }, revoke);
  revoke.addEventListener("click", (ev) => {
    if (!ev.isTrusted) return;
    const yes = el("button", { className: "mini bad needs-live", type: "button", textContent: "Revoke", ariaLabel: `Yes, revoke ${shown}` });
    const keep = el("button", { className: "mini", type: "button", textContent: "Keep" });
    const back = () => { acts.replaceChildren(revoke); revoke.focus(); };
    keep.addEventListener("click", back);
    yes.addEventListener("click", async (e) => {
      if (!e.isTrusted) return;
      yes.disabled = keep.disabled = true;
      if (!(await revokeInvite(i.id, shown)) && acts.isConnected) back();
    });
    acts.replaceChildren(el("small", { className: "ask", textContent: "Revoke it? Anyone using it is out." }), yes, keep);
    keep.focus();
  });
  li.append(acts);
  return li;
}
function drawInvites(body) {
  const items = Array.isArray(body?.items) ? body.items.filter((i) => i && typeof i.id === "string" && INVITE_ID.test(i.id)) : [];
  const asking = [...$("invite-list").querySelectorAll("li")].find((li) => li.querySelector(".ask"))?.dataset.id;
  const rows = items.map(inviteRow);
  if (asking) {
    const k = rows.findIndex((li) => li.dataset.id === asking);
    const old = [...$("invite-list").children].find((li) => li.dataset.id === asking);
    if (k >= 0 && old) rows[k] = old;
  }
  $("invite-list").replaceChildren(...rows);
  $("invite-list").hidden = !rows.length;
  $("invites-empty").hidden = !!rows.length;
  applySearch();
}
async function loadInvites() {
  const r = await getJson("invites.json");
  if (r.status === 200) return drawInvites(r.body);
  // An older helper without the route: the help line alone, as before.
  $("invite-list").replaceChildren();
  $("invite-list").hidden = true;
  $("invites-empty").hidden = true;
  if (r.status !== 404 && r.status !== 0) say($("invites-msg"), "Couldn't read the invites. They load again when PairBrowse reconnects.", "error");
}

// ---- About and diagnostics (diagnostics.json, diagnostics/report) ------------------------------
function drawDiag(d) {
  diag = d && typeof d === "object" ? d : null;
  const h = diag?.helper || {}, b = diag?.browser || {}, c = diag?.connections || {};
  $("about-helper").textContent = h.version ? `${h.version}${h.node ? ` · Node ${h.node}` : ""}` : "Not reported";
  $("about-browser").textContent = b.engine ? [b.engine === "pairbrowse" ? "PairBrowse" : b.engine === "chromium" ? "Chromium" : String(b.engine), b.version, b.build ? `build ${b.build}` : ""].filter(Boolean).join(" ") : "Not reported";
  const n = (k, one, many) => { const v = Number(c[k]) || 0; return `${v} ${v === 1 ? one : many}`; };
  $("about-agents").textContent = diag ? [n("agents", "agent", "agents"), n("joiners", "person joined", "people joined"), n("viewers", "viewer", "viewers")].join(" · ") : "Not reported";
  const errors = Array.isArray(diag?.errors) ? diag.errors.slice(-5).reverse() : [];
  $("errors").replaceChildren(...errors.map((e) => el("li", {},
    el("time", { textContent: e.at ? new Date(e.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "" }),
    el("span", { textContent: `${e.where ? `${e.where}: ` : ""}${e.text || ""}` }))));
  $("errors").hidden = !errors.length;
  $("errors-empty").hidden = !!errors.length;
  $("errors-empty").textContent = diag ? "No errors logged." : "This PairBrowse doesn't offer diagnostics yet.";
  $("diag-copy").hidden = !diag;
}
async function loadDiag() {
  const r = await getJson("diagnostics.json");
  if (r.status === 200) return drawDiag(r.body);
  drawDiag(null);
  if (r.status !== 404 && r.status !== 0) say($("diag-msg"), "Couldn't read diagnostics. They load again when PairBrowse reconnects.", "error");
}
async function reportText() {
  const r = await postJson("diagnostics/report", null);
  return r.status === 200 && typeof r.body?.text === "string" ? r.body.text : null;
}
async function copy(text, msg, done) {
  try {
    await navigator.clipboard.writeText(text);
    say(msg, done, "ok");
    return true;
  } catch {
    say(msg, "Couldn't copy: select the text and press Ctrl or Cmd+C.", "error");
    return false;
  }
}
$("diag-copy").addEventListener("click", async () => {
  const text = await reportText();
  if (text === null) return say($("diag-msg"), "Couldn't make the report. Try again once PairBrowse is connected.", "error");
  copy(text, $("diag-msg"), "Copied the diagnostics report.");
});

// ---- Report a problem --------------------------------------------------------------------------
// The review screen shows exactly the JSON that goes out (common.js reportPayload): the person's
// words, versions, platform, the helper's state and the diagnostics report; the address of the tab
// in front only when ticked, without its query or fragment. Send posts it to the helper's report
// route, which relays it to the PairBrowse server set in its config; no key or token is anywhere
// in the page. Copy instead is the fallback.
const dlg = $("report");
let reportDiag = "";
let frontTab = null; // { url } of the tab in front: origin and path only
function payload() {
  return reportPayload({
    what: $("report-what").value,
    host: document.body.dataset.host,
    page: "settings",
    connection: conn,
    diag,
    report: reportDiag,
    tab: $("report-tab").checked && frontTab ? frontTab.url : null,
  });
}
const preview = () => { $("report-preview").textContent = JSON.stringify(payload(), null, 2); };
async function openReport() {
  say($("report-msg"), "");
  $("report-send").disabled = false;
  $("report-send").textContent = "Send";
  reportDiag = (await reportText()) || "";
  frontTab = null;
  const t = await getJson("tabs.json");
  if (t.status === 200 && Array.isArray(t.body)) {
    const front = t.body.find((x) => x && x.active && !x.personal && /^https?:/.test(String(x.url || "")));
    if (front) {
      try { const u = new URL(front.url); frontTab = { url: u.origin + u.pathname }; } catch {}
    }
  }
  $("report-tab-row").hidden = !frontTab;
  $("report-tab").checked = false;
  $("report-tab-url").textContent = frontTab?.url || "";
  preview();
  if (!dlg.open) dlg.showModal();
  $("report-what").focus();
}
$("report-open").addEventListener("click", openReport);
$("report-what").addEventListener("input", preview);
$("report-tab").addEventListener("change", preview);
$("report-cancel").addEventListener("click", () => dlg.close());
$("report-copy").addEventListener("click", () => copy(JSON.stringify(payload(), null, 2), $("report-msg"), "Copied. Paste it into an email to the PairBrowse team."));
$("report-send").addEventListener("click", async () => {
  if (!$("report-what").value.trim()) {
    say($("report-msg"), "Say in a few words what happened first.", "error");
    return $("report-what").focus();
  }
  const btn = $("report-send");
  btn.disabled = true;
  btn.textContent = "Sending…";
  say($("report-msg"), "Sending…");
  const r = await sendReport(base, payload());
  if (r.ok) {
    btn.textContent = "Sent";
    say($("report-msg"), r.id ? `Sent. Your reference is ${r.id}.` : "Sent. Thank you.", "ok");
    return;
  }
  btn.disabled = false;
  btn.textContent = "Try again";
  say($("report-msg"), `Not sent: ${r.error} Copy it instead and email it to the PairBrowse team.`, "error");
});
dlg.addEventListener("close", () => { if (location.hash === "#report") history.replaceState(null, "", location.pathname + location.search); $("report-open").focus(); });

// ---- Browser settings: one link to the browser's own (chrome://settings) ----------------------
// In the browser this tab page follows the link itself; the extension opens it with chrome.tabs.
for (const a of document.querySelectorAll("#browser-settings, [data-browser-settings]")) {
  a.addEventListener("click", (ev) => {
    if (NATIVE) return; // the link itself
    ev.preventDefault();
    try {
      if (globalThis.chrome?.tabs?.create) chrome.tabs.create({ url: "chrome://settings" });
      else throw new Error("no tabs");
    } catch {
      say($("diag-msg"), "Type chrome://settings in the address bar to open the browser's settings.", "error");
      $("about").scrollIntoView();
    }
  });
}

// ---- Search, the section nav and the keyboard --------------------------------------------------
const items = [...document.querySelectorAll("main .item")];
function applySearch() {
  const q = $("search").value.trim().toLowerCase();
  let shown = 0;
  for (const it of items) {
    const text = q ? `${it.dataset.k || ""} ${it.textContent}`.toLowerCase() : "";
    const hit = !q || q.split(/\s+/).every((w) => text.includes(w));
    it.classList.toggle("miss", !hit);
    if (hit && !it.hidden && !it.closest("[hidden]")) shown++;
  }
  for (const sec of document.querySelectorAll("main .sec")) {
    const any = [...sec.querySelectorAll(".item")].some((it) => !it.classList.contains("miss") && !it.hidden);
    sec.classList.toggle("miss", !!q && !any);
    const link = document.querySelector(`.nav a[data-sec="${sec.id}"]`);
    if (link) link.classList.toggle("miss", !!q && !any);
  }
  const none = !!q && shown === 0;
  $("no-match").hidden = !none;
  $("no-match").textContent = none ? `No settings match “${$("search").value.trim()}”. Browser-wide settings are in Browser settings.` : "";
}
$("search").addEventListener("input", applySearch);
$("search").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("search").value) { e.preventDefault(); $("search").value = ""; applySearch(); }
  else if (e.key === "Enter") {
    e.preventDefault();
    const first = items.find((it) => !it.classList.contains("miss") && !it.hidden);
    if (first) { first.scrollIntoView({ block: "start" }); first.querySelector("input, button, select, textarea, a, [tabindex]")?.focus({ preventScroll: true }); }
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || dlg.open) return;
  const t = e.target;
  if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  e.preventDefault();
  $("search").focus();
  $("search").select();
});
// The nav: the section a link or the address names is marked current; arrows move between links.
const navLinks = [...document.querySelectorAll(".nav a")];
function markCurrent() {
  const id = (location.hash || "#general").slice(1);
  const sec = document.getElementById(id)?.closest(".sec")?.id || "general";
  for (const a of navLinks) {
    if (a.dataset.sec === sec) a.setAttribute("aria-current", "true");
    else a.removeAttribute("aria-current");
  }
}
window.addEventListener("hashchange", () => { markCurrent(); if (location.hash === "#report") openReport(); });
markCurrent();
document.querySelector(".nav").addEventListener("keydown", (e) => {
  const i = navLinks.indexOf(document.activeElement);
  if (i < 0) return;
  const visible = navLinks.filter((a) => !a.classList.contains("miss"));
  const j = visible.indexOf(navLinks[i]);
  let next = null;
  if (e.key === "ArrowDown") next = visible[(j + 1) % visible.length];
  else if (e.key === "ArrowUp") next = visible[(j - 1 + visible.length) % visible.length];
  else if (e.key === "Home") next = visible[0];
  else if (e.key === "End") next = visible[visible.length - 1];
  if (next) { e.preventDefault(); next.focus(); }
});

// ---- the helper stream -------------------------------------------------------------------------
function connect(url) {
  if (!url || url === base) return;
  base = url;
  stream?.close();
  // The owner's stream without the page screencast (panel=1, no page kind), shared with the other pages.
  stream = helperStream(base, {
    onState: (s) => {
      if (s === "live") setConn("live", "");
      else if (s === "closed") setConn("closed", NO_HELPER);
      else setConn("connecting", "Connecting to PairBrowse…");
    },
    onOpen: async () => {
      await loadConfig();
      loadSessions(); loadInvites(); profile.load(); loadTimelineCount(); loadDiag();
      if (location.hash === "#report" && config?.report === true) openReport();
    },
  });
  const on = stream.on;
  on("profile", profile.draw);
  on("joinhost", hostsChanged);
  on("config", (c) => { const { restart, ...rest } = c || {}; drawConfig({ ...rest, ...(restart !== undefined ? { restart } : {}) }); });
  on("timeline", () => loadTimelineCount());
  on("sessions", drawSessions);
  on("invites", drawInvites);
}

setConn("connecting", "Connecting to PairBrowse…");
drawDiag(null);
$("errors-empty").textContent = "Checking…";
if (!NATIVE) {
  try { globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => { if (area === "session" && changes.view) connect(changes.view.newValue); }); } catch {}
}
helperBase().then((b) => (b ? connect(b) : setConn("closed", NO_HELPER)));
