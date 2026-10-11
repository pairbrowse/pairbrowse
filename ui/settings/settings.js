// PairBrowse settings (pairbrowse://settings in the PairBrowse browser; the extension's
// settings/index.html in Chromium). It shows only what the helper reports today: sessions,
// passwords by name, remembered details, sharing and the timeline, through the live view's owner
// routes with the owner's key. The browser and timeline settings have no route yet, so the page
// says so and shows the config.json line. Nothing ticks: no timer, no observer, the one shared event stream (common.js).
import { $, el, ago, initialOf, devPanel, hostPanel, profilePanel, helperStream } from "../common.js";

// The host, a fact of the page (not a reading of the config): window.pairbrowse exists only in
// the PairBrowse browser.
const NATIVE = !!window.pairbrowse;
const HOST = NATIVE ? "The PairBrowse browser" : "Chromium with the PairBrowse extension";
document.body.dataset.host = NATIVE ? "pairbrowse" : "chromium";
$("browser-now").textContent = HOST;
$("about-host").textContent = HOST;

let base = null;
let stream = null; // the shared helper stream (common.js helperStream)

const say = (node, text, kind = "") => { node.textContent = text; node.dataset.kind = kind; };
function setConn(state, text) {
  document.body.dataset.s = state;
  $("conn").textContent = text;
}

// The live view's address with the owner's key: from the browser, or from the extension's
// session storage (in memory, never on disk), as the side panel gets it.
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

const drawDev = devPanel($("dev-asks"), $("devs"), $("dev"), () => base);
const drawHosts = hostPanel($("host-asks"), $("host-list"), $("hosts"), () => base);
const profile = profilePanel(() => base);

// Sessions, as sessions.json lists them: read only.
function sessionRow(s) {
  const name = s.name === "default" ? "Default" : String(s.name);
  const live = Array.isArray(s.live) ? s.live : [];
  const sites = Array.isArray(s.sites) ? s.sites : [];
  const face = el("span", { className: "avatar plain", textContent: initialOf(name) });
  face.setAttribute("aria-hidden", "true");
  const head = el("strong", {}, el("span", { className: "name", textContent: name, title: name }));
  if (s.current) head.append(el("em", { textContent: "Last used" }));
  if (live.length) head.append(el("em", { className: "live", textContent: `Live · ${live.length} ${live.length === 1 ? "other" : "others"}` }));
  const tabs = Number(s.tabs) || 0;
  const meta = [
    tabs ? `${tabs} ${tabs === 1 ? "tab" : "tabs"}${sites.length ? ` · ${sites.join(", ")}` : ""}` : "No saved tabs",
    s.used ? `used ${ago(new Date(s.used).toISOString())}` : "",
  ].filter(Boolean).join(" · ");
  return el("li", {}, face, head, el("small", { textContent: meta }));
}
async function loadSessions() {
  const r = await fetch(base + "sessions.json").then((x) => (x.ok ? x.json() : null)).catch(() => null);
  if (!r) return say($("sessions-msg"), "Couldn't reach PairBrowse.", "error");
  const list = Array.isArray(r.sessions) ? r.sessions : [];
  $("session-list").replaceChildren(...(list.length ? list.map(sessionRow) : [el("li", { className: "empty", textContent: "No sessions yet." })]));
  say($("sessions-msg"), "");
}

// The timeline: on (how many pictures), the helper's own sentence when it is off, or not there.
async function loadTimeline() {
  const r = await fetch(base + "timeline.json").catch(() => null);
  let text;
  if (!r) text = "Couldn't reach PairBrowse.";
  else if (r.ok) {
    const body = await r.json().catch(() => null);
    const n = Array.isArray(body?.cards) ? body.cards.length : 0;
    text = `On · ${n} ${n === 1 ? "picture" : "pictures"} kept`;
  } else {
    const t = (await r.text().catch(() => "")).trim();
    text = t && t !== String(r.status) ? t : "Not available from this PairBrowse: it keeps no timeline.";
  }
  $("timeline-state").textContent = text;
}

function connect(url) {
  if (!url || url === base) return;
  base = url;
  stream?.close();
  // The owner's stream without the page screencast (panel=1, no page kind), shared with the other pages (common.js).
  stream = helperStream(base, {
    onState: (s) => {
      if (s === "live") setConn("live", "");
      else if (s === "closed") setConn("closed", "Not connected to PairBrowse.");
      else setConn("connecting", "Connecting to PairBrowse…");
    },
    onOpen: () => { loadSessions(); profile.load(); loadTimeline(); },
  });
  const on = stream.on;
  on("profile", profile.draw);
  on("dev", (s) => { drawDev(s); $("dev-empty").hidden = !$("dev").hidden; });
  on("joinhost", (s) => { drawHosts(s); $("hosts-empty").hidden = !$("hosts").hidden; });
}

// "Switch session…": the session picker in a new tab (the side panel's route).
$("switch-btn").addEventListener("click", async (ev) => {
  if (!ev.isTrusted) return;
  if (!base) return say($("sessions-msg"), "Not connected to PairBrowse yet.", "error");
  const r = await fetch(base + "picker", { method: "POST" }).catch(() => null);
  if (r?.ok) say($("sessions-msg"), "The session picker opened in a new tab.", "ok");
  else say($("sessions-msg"), "Couldn't open the session picker.", "error");
});

// Copy: the exact config.json line.
for (const btn of document.querySelectorAll(".copy")) {
  btn.addEventListener("click", () => {
    const line = $(btn.dataset.for);
    const msg = btn.closest(".sec").querySelector(".msg");
    Promise.resolve().then(() => navigator.clipboard.writeText(line.textContent))
      .then(() => say(msg, "Copied.", "ok"))
      .catch(() => { getSelection()?.selectAllChildren(line); say(msg, "Select and press Ctrl/Cmd+C to copy.", "error"); });
  });
}

// Chromium's own settings, in a new tab.
$("chromium-settings").addEventListener("click", async (ev) => {
  if (!ev.isTrusted) return;
  try {
    if (NATIVE) await window.pairbrowse.tabs.create("chrome://settings", true);
    else if (globalThis.chrome?.tabs?.create) await chrome.tabs.create({ url: "chrome://settings" });
    else throw new Error("no tabs");
    say($("about-msg"), "");
  } catch {
    say($("about-msg"), "Type chrome://settings in the address bar.", "error");
  }
});

if (!NATIVE) {
  try { globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => { if (area === "session" && changes.view) connect(changes.view.newValue); }); } catch {}
}
helperBase().then((b) => (b ? connect(b) : setConn("closed", "Not connected to PairBrowse: open this page from the PairBrowse browser.")));
