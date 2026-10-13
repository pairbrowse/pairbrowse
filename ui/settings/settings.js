// PairBrowse Settings (pairbrowse://settings in the PairBrowse browser; settings/index.html, the
// extension's options page, in Chromium). Organized by what people come for (DESIGN.md Part H):
// General, Agents and approvals, Sharing, Your data, About and diagnostics, and one link to the
// browser's own settings. Every control reads the helper's current value and writes through a real
// owner route with the owner's key: config.json / config (the browser, the docks at a session's
// start, the timeline), profile.json / profile (passwords, remembered details), the joinhost event /
// joinhost (join addresses), sessions.json (saved sessions), diagnostics.json and
// diagnostics/report, and report (Report a problem; shown only while the helper says it relays
// reports). This is a tab page: in the browser only window.pairbrowse.session exists here, so the
// page never calls another interface. Nothing ticks: no timer, no observer; one shared event stream.
import { $, el, ago, initialOf, hostPanel, profilePanel, helperStream, reportPayload, sendReport } from "../common.js";

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
const CONN_TEXT = { live: "Connected", connecting: "Connecting…", closed: "Not connected" };
function setConn(state, text) {
  conn = state;
  document.body.dataset.s = state;
  $("conn").textContent = text;
  const c = $("about-conn");
  c.dataset.s = state;
  c.textContent = CONN_TEXT[state] || state;
  // Nothing writes while the helper is away; what was read stays on screen.
  for (const f of document.querySelectorAll("main fieldset, main form")) f.toggleAttribute("disabled", state !== "live");
  for (const b of document.querySelectorAll("#tl-on, #diag-copy, #report-open")) b.disabled = state !== "live";
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
  for (const n of document.querySelectorAll(".cfg-item")) n.hidden = !have || (!NATIVE && n.classList.contains("native-only"));
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

// ---- Your data: saved sessions (sessions.json), read only -------------------------------------
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
  return el("li", {}, face, head, el("small", { textContent: meta }));
}
async function loadSessions() {
  const r = await getJson("sessions.json");
  if (r.status !== 200 || !r.body) {
    $("session-list").replaceChildren();
    return say($("sessions-msg"), r.status === 404 ? "This PairBrowse doesn't list sessions." : "Couldn't read the sessions. They load again when PairBrowse reconnects.", "error");
  }
  const list = Array.isArray(r.body.sessions) ? r.body.sessions : [];
  $("session-list").replaceChildren(...(list.length ? list.map(sessionRow) : [el("li", { className: "empty", textContent: "No saved sessions yet." })]));
  say($("sessions-msg"), "");
  applySearch();
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
  if (r.status !== 404) say($("diag-msg"), "Couldn't read diagnostics. They load again when PairBrowse reconnects.", "error");
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
      else if (s === "closed") setConn("closed", "Not connected to PairBrowse. Settings load again when it's back.");
      else setConn("connecting", "Connecting to PairBrowse…");
    },
    onOpen: async () => {
      await loadConfig();
      loadSessions(); profile.load(); loadTimelineCount(); loadDiag();
      if (location.hash === "#report" && config?.report === true) openReport();
    },
  });
  const on = stream.on;
  on("profile", profile.draw);
  on("joinhost", hostsChanged);
  on("config", (c) => { const { restart, ...rest } = c || {}; drawConfig({ ...rest, ...(restart !== undefined ? { restart } : {}) }); });
  on("timeline", () => loadTimelineCount());
}

setConn("connecting", "Connecting to PairBrowse…");
drawDiag(null);
$("errors-empty").textContent = "Checking…";
if (!NATIVE) {
  try { globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => { if (area === "session" && changes.view) connect(changes.view.newValue); }); } catch {}
}
helperBase().then((b) => (b ? connect(b) : setConn("closed", NATIVE ? "Not connected to PairBrowse. Settings show once an agent starts PairBrowse." : "Not connected to PairBrowse: start it from Claude Code or Codex, then reopen this page.")));
