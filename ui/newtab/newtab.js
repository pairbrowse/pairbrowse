// The new tab page. The field, "Type a URL" as the omnibox: a web address (http or https) opens;
// anything else stays and the line under it says so (no search engine, as the omnibox's default). The chips: your other recent sessions from the helper's sessions.json, one press
// switches (POST pick; while agents are at work the helper asks first, and the page asks the
// person in the page before the same pick goes again with confirm: true). One source for two hosts: in the browser build window.pairbrowse gives the helper's
// address (session.helper()); as the extension page it is chrome.storage.session "view", as in the
// session picker. One fetch at load; no timer, observer or poll.
import { $, el, addressToUrl, askSwitch } from "../common.js";

$("search").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("q").value;
  if (!text.trim()) return;
  const url = addressToUrl(text, { search: false });
  // Web pages only: words, file:, chrome: and javascript: open nothing.
  if (!url || !/^https?:\/\//i.test(url)) { say(NOT_AN_ADDRESS, "error"); return; }
  location.href = url;
});
$("q").addEventListener("input", () => { if ($("msg").textContent === NOT_AN_ADDRESS) say(""); });

// A person's click or key press only, never a script's synthetic event.
const real = (ev) => ev.isTrusted;
const CHIPS = 3;
const UNREACHABLE = { text: "Couldn't reach PairBrowse. Try again.", error: true };
const NOT_AN_ADDRESS = "Type a web address, like example.com.";
let busy = false;
let askCancel = null; // the open switch question's Cancel path

const say = (text, kind = "") => { $("msg").textContent = text; $("msg").dataset.kind = kind; };

// The helper's address with its key, or null when PairBrowse is not running.
async function helperBase() {
  const build = globalThis.window?.pairbrowse?.session;
  if (build && typeof build.helper === "function") {
    document.body.dataset.host = "build";
    const h = await Promise.resolve().then(() => build.helper()).catch(() => null);
    return h && typeof h.origin === "string" && h.origin && typeof h.key === "string" && h.key ? `${h.origin}/${h.key}/` : null;
  }
  const store = globalThis.chrome?.storage?.session;
  if (!store) return null;
  document.body.dataset.host = "extension";
  const got = await Promise.resolve().then(() => store.get("view")).catch(() => null);
  return typeof got?.view === "string" && got.view ? got.view : null;
}

const post = (base, route, body) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then((x) => x.json(), () => UNREACHABLE)
  .catch(() => UNREACHABLE);

// One press: the pick itself (the helper switches with a session open). Agents at work: 428
// { confirm, agents }, asked here; Switch anyway sends the same pick with confirm: true.
async function open(base, op, label) {
  if (busy || document.body.dataset.s === "done") return;
  if (askCancel) { const c = askCancel; askCancel = null; c(); }
  busy = true;
  document.body.dataset.s = "picking";
  say(`Opening ${label}...`);
  const r = await post(base, "pick", op);
  busy = false;
  if (r?.confirm && op.confirm !== true) {
    document.body.dataset.s = "ready";
    say("");
    askCancel = askSwitch($("ask"), r, {
      yes: () => { askCancel = null; open(base, { ...op, confirm: true }, label); },
      no: () => { askCancel = null; say("Not switched."); },
    });
    return;
  }
  if (!r || r.error) {
    document.body.dataset.s = "ready";
    say(r?.text || "That didn't work.", "error");
    return;
  }
  document.body.dataset.s = "done";
  say(r.text || "Done.", "ok");
}

function chip(base, s) {
  const name = s.name === "default" ? "Default" : s.name;
  const meta = s.tabs ? `${s.tabs} ${s.tabs === 1 ? "tab" : "tabs"}` : "No saved tabs";
  const button = el("button", { className: "chip", type: "button" },
    el("span", { className: "name", textContent: name }), document.createTextNode(" · "), el("span", { className: "meta", textContent: meta }));
  button.dataset.name = s.name;
  button.addEventListener("click", (ev) => { if (real(ev)) open(base, { action: "use", name: s.name }, name); });
  return button;
}

// The helper's own order (most recently used first), the session you are in left out, at most three.
export async function boot() {
  const base = await helperBase();
  if (!base) return false;
  const state = await fetch(base + "sessions.json").then((r) => (r.ok ? r.json() : null), () => null).catch(() => null);
  const list = Array.isArray(state?.sessions) ? state.sessions.filter((s) => s && typeof s.name === "string" && s.name && !s.current).slice(0, CHIPS) : [];
  $("sessions").replaceChildren(...list.map((s) => chip(base, s)));
  $("sessions").hidden = !list.length;
  return true;
}

boot().then((found) => {
  // The extension before the side panel's worker has stored the address: once, when it does.
  if (found || window.pairbrowse || !globalThis.chrome?.storage?.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => { if (area === "session" && changes.view) boot(); });
});
