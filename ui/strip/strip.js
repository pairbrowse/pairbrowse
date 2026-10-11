// The browser build's top strip (DESIGN.md B2). One document, three hosts by location hash: the
// 44 px tab row (no hash), the nav fragments beside the native address bar (#nav-left,
// #nav-right), and each popover alone (#switcher, #share, #menu) for the shell's bubbles, which
// cannot draw outside a 44 px slot. Tabs, owners and the dock layout come from window.pairbrowse
// (the browser's own API); people, sharing and recording from the helper's event stream. Without
// window.pairbrowse the row shows the helper's tabs event, read only. Nothing here starts a timer,
// a frame loop or a DOM observer: observers of the browser API and one EventSource only.
import { $, el, avatar, shareCard, isColor, pickerPopover } from "../common.js";

const pb = window.pairbrowse || null;
const mac = /mac/i.test(navigator.platform);
document.body.dataset.platform = mac ? "mac" : "other";
document.body.dataset.native = String(!!pb);

// Controls the browser API has no surface for yet (back, forward, bookmark, find, new window):
// shown disabled, their shortcut in the name, never a state they don't have.
const KEYS = mac
  ? { back: "Back (⌘[)", forward: "Forward (⌘])", reload: "Reload (⌘R)", star: "Bookmark this page (⌘D)", find: "Find in page (⌘F)", newWindow: "⌘N" }
  : { back: "Back (Alt+Left)", forward: "Forward (Alt+Right)", reload: "Reload (Ctrl+R)", star: "Bookmark this page (Ctrl+D)", find: "Find in page (Ctrl+F)", newWindow: "Ctrl+N" };
for (const id of ["back", "forward", "reload", "star", "find"]) { $(id).setAttribute("aria-label", KEYS[id]); $(id).title = KEYS[id]; }
$("new-window-key").textContent = KEYS.newWindow;
$("new-window").title = `Not available yet: use ${KEYS.newWindow}`;

const postJson = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const tabsEl = $("tabs");
let base = null; // the helper's address, `${origin}/${key}/`; null: not connected
let myWindow = -1;
const tabs = new Map(); // id -> tab (this window's only)
const lis = new Map(); // id -> li
let owners = { agents: {}, colors: {} };
let rovingId = null; // the tab keyboard focus moved to with the arrows (else the active one)
let recording = false;

// ---- modes ----
const MODES = new Set(["row", "nav-left", "nav-right", "switcher", "share", "menu"]);
const BUBBLES = new Set(["switcher", "share", "menu"]);
let mode = "";
const bubble = () => BUBBLES.has(mode);

// ---- the switcher: the session picker in a same-origin iframe, loaded only while open
// (common.js pickerPopover); in the #switcher bubble the host owns dismissal ----
const switcher = pickerPopover({ pop: $("switcher"), frame: $("picker"), openers: [$("switch")], dismissable: () => !bubble() });

// ---- Share: the side panel's card (common.js) ----
const share = shareCard({ btn: $("share-btn"), card: $("share-card"), base: () => base, dismissable: () => !bubble() });

// ---- the ⋯ menu ----
const menuBtn = $("menu-btn"), menu = $("menu");
const items = () => [...menu.querySelectorAll('[role="menuitem"]')].filter((b) => !b.disabled && !b.hidden);
const outsideMenu = (e) => { if (!menu.contains(e.target) && !menuBtn.contains(e.target)) closeMenu(false); };
function openMenu() {
  if (menu.hidden) {
    menu.hidden = false;
    menuBtn.setAttribute("aria-expanded", "true");
    if (!bubble()) document.addEventListener("pointerdown", outsideMenu, true);
  }
  items()[0]?.focus();
}
function closeMenu(refocus = true, force = false) {
  if (menu.hidden || (bubble() && mode === "menu" && !force)) return;
  menu.hidden = true;
  menuBtn.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", outsideMenu, true);
  if (refocus) menuBtn.focus();
}
menuBtn.addEventListener("click", () => (menu.hidden ? openMenu() : closeMenu()));
menuBtn.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" && menu.hidden) { e.preventDefault(); openMenu(); }
  else if (e.key === "Escape" && !menu.hidden) { e.preventDefault(); closeMenu(); }
});
menu.addEventListener("keydown", (e) => {
  const list = items();
  const at = list.indexOf(document.activeElement);
  const go = (i) => { e.preventDefault(); list[(i + list.length) % list.length]?.focus(); };
  if (e.key === "ArrowDown") go(at + 1);
  else if (e.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(-1);
  else if (e.key === "Escape") { e.preventDefault(); closeMenu(); }
});
menu.addEventListener("focusout", (e) => { if (e.relatedTarget && !menu.contains(e.relatedTarget) && e.relatedTarget !== menuBtn) closeMenu(false); });
const menuItem = (id, fn) => $(id).addEventListener("click", () => { closeMenu(); fn(); });
menuItem("zoom", () => pb?.windows.zoom(myWindow).catch(() => {}));
menuItem("settings", () => pb?.tabs.create("pairbrowse://settings", true, myWindow).catch(() => {}));
menuItem("about", () => pb?.tabs.create("pairbrowse://settings#about", true, myWindow).catch(() => {}));
menuItem("record", async () => {
  if (!base) return;
  const r = await postJson(base + "record", { on: !recording }).then((x) => x.json()).catch(() => null);
  if (r && typeof r.recording === "boolean") drawRecord(r.recording);
});
function drawRecord(on) {
  recording = !!on;
  $("record-text").textContent = recording ? "Stop recording" : "Record";
}
// The browser API's items have nothing to call without it.
if (!pb) for (const id of ["zoom", "settings", "about", "new-window"]) $(id).hidden = true;

// ---- hash modes (no reload: the hash only picks what shows) ----
function openBubble(m) {
  if (m === "switcher") switcher.open($("switch"));
  else if (m === "share") { if ($("share-card").hidden) share.open(); }
  else if (m === "menu") openMenu();
}
function closeBubble(m) {
  if (m === "switcher") switcher.close(false);
  else if (m === "share") { if (!$("share-card").hidden) share.close(false); }
  else if (m === "menu") closeMenu(false, true);
}
function applyMode() {
  const given = location.hash.slice(1);
  const next = MODES.has(given) ? given : "row";
  if (next === mode) return;
  const was = mode;
  mode = next;
  if (BUBBLES.has(was)) closeBubble(was);
  document.body.dataset.mode = mode;
  $("row").hidden = !(mode === "row" || BUBBLES.has(mode));
  $("nav-left").hidden = mode !== "nav-left";
  $("nav-right").hidden = mode !== "nav-right";
  if (BUBBLES.has(mode)) openBubble(mode);
}
// In a bubble the host owns dismissal: no outside-click listener is registered and Escape
// closes nothing (the switcher, the menu, the share card and their Escape paths check bubble()).
window.addEventListener("hashchange", applyMode);
applyMode();

// ---- the nav fragments ----
const activeId = () => { for (const t of tabs.values()) if (t.active) return t.id; return -1; };
$("reload").disabled = !pb;
$("reload").addEventListener("click", () => { const id = activeId(); if (pb && id !== -1) pb.tabs.reload(id).catch(() => {}); });
const sparkle = $("sparkle");
sparkle.addEventListener("click", async () => {
  if (pb) {
    try {
      const { state } = await pb.layout.get();
      await pb.layout.set({ ...state, right: state.right === pb.DockState.kOpen ? pb.DockState.kHidden : pb.DockState.kOpen });
    } catch {}
  } else if (base) {
    postJson(base + "layout", { right: sparkle.getAttribute("aria-pressed") === "true" ? "hidden" : "open" }).catch(() => {});
  }
});
const drawSparkle = (open) => sparkle.setAttribute("aria-pressed", String(!!open));

// ---- the tab row ----
const SVG = "http://www.w3.org/2000/svg";
function svg(viewBox, className, build) {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("viewBox", viewBox);
  if (className) s.setAttribute("class", className);
  s.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of build) {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    s.append(n);
  }
  return s;
}
const line = { fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round" };
const genericIcon = () => svg("0 0 16 16", "generic", [["circle", { cx: "8", cy: "8", r: "6", ...line }], ["path", { d: "M2 8h12M8 2c2 2 2.6 4 2.6 6S10 12 8 14C6 12 5.4 10 5.4 8S6 4 8 2", ...line }]]);
const closeIcon = () => svg("0 0 12 12", "", [["path", { d: "M3 3l6 6M9 3l-6 6", ...line }]]);
// A favicon the page may show under its CSP: data: images (the adapter's) or the browser's own.
const faviconOk = (u) => typeof u === "string" && /^(data:image\/|chrome:\/\/)/.test(u);
const loadingState = (t) => pb && (t.networkState === pb.NetworkState.kWaiting || t.networkState === pb.NetworkState.kLoading);
const titleOf = (t) => String(t.title || t.url || "New Tab");

// One tab: the icon slot (its data-key, "img:", "generic" or "ring", picks the tile in strip.css), the
// title, the agent dot and a close button. Every unpinned tab shows its close; Tab still reaches only
// the active tab's close (roving below), and Delete closes the focused tab.
function drawTab(t) {
  let li = lis.get(t.id);
  if (!li) {
    const close = el("button", { className: "close", type: "button" }, closeIcon());
    li = el("li", {}, el("span", { className: "icon" }), el("span", { className: "title" }), close);
    li.setAttribute("role", "tab");
    li.dataset.id = String(t.id);
    lis.set(t.id, li);
  }
  const title = titleOf(t);
  const loading = loadingState(t);
  const agent = owners.agents?.[String(t.id)] || "";
  const color = owners.colors?.[String(t.id)] || "";
  li.setAttribute("aria-selected", String(!!t.active));
  li.classList.toggle("pinned", !!t.pinned);
  li.title = title;
  li.setAttribute("aria-label", `${title}${agent ? `, ${agent} is in this tab` : ""}${loading ? ", loading" : ""}${t.pinned ? ", pinned" : ""}`);
  // The icon slot: a loading ring, the favicon, or a generic globe; redrawn only when it changes.
  const icon = li.querySelector(".icon");
  const iconKey = loading ? "ring" : faviconOk(t.favicon) && !t.defaultFavicon ? `img:${t.favicon}` : "generic";
  if (icon.dataset.key !== iconKey) {
    icon.dataset.key = iconKey;
    if (iconKey === "ring") {
      const ring = el("span", { className: "ring" });
      ring.setAttribute("role", "img");
      ring.setAttribute("aria-label", "Loading");
      icon.replaceChildren(ring);
    } else if (iconKey === "generic") icon.replaceChildren(genericIcon());
    else icon.replaceChildren(el("img", { src: t.favicon, alt: "", width: 16, height: 16 }));
  }
  li.querySelector(".title").textContent = title;
  // The agent dot: the owning agent's color, 4 px left of the close, named in words too.
  let dot = li.querySelector(".agent");
  if (agent) {
    if (!dot) { dot = el("span", { className: "agent" }, el("span", { className: "sr" })); li.querySelector(".close").before(dot); }
    dot.style.background = isColor(color) ? color : "var(--spark)";
    dot.title = `${agent} is in this tab`;
    dot.firstChild.textContent = dot.title;
  } else dot?.remove();
  li.querySelector(".close").setAttribute("aria-label", `Close ${title}`);
  return li;
}

const ordered = () => [...tabs.values()].sort((a, b) => a.index - b.index);
// Roving focus: one tab in the Tab order (the one the arrows reached, else the active one), and
// only the active tab's close.
function roving() {
  const act = activeId();
  const focusId = rovingId !== null && lis.has(rovingId) ? rovingId : act;
  for (const [id, li] of lis) {
    li.tabIndex = id === focusId ? 0 : -1;
    li.querySelector(".close").tabIndex = id === act ? 0 : -1;
  }
}
function render() {
  const focused = document.activeElement?.closest?.("#tabs li");
  const hadFocus = !!focused;
  const focusedId = focused ? Number(focused.dataset.id) : null;
  for (const [id, li] of lis) if (!tabs.has(id)) { li.remove(); lis.delete(id); }
  ordered().forEach((t, i) => {
    const li = drawTab(t);
    if (tabsEl.children[i] !== li) tabsEl.insertBefore(li, tabsEl.children[i] || null);
  });
  if (rovingId !== null && !lis.has(rovingId)) rovingId = null;
  roving();
  // A tab moved in the DOM loses focus; a closed one hands it to the tab now active.
  if (hadFocus && !tabsEl.contains(document.activeElement)) (lis.get(focusedId) || lis.get(activeId()))?.focus();
}

// Clicks: a tab activates, its close closes it, a middle click closes it.
let suppressClick = false;
const liOf = (e) => e.target.closest?.('#tabs li[role="tab"]') || null;
const idOf = (li) => Number(li.dataset.id);
tabsEl.addEventListener("click", (e) => {
  const li = liOf(e);
  if (!li || !pb) return;
  if (suppressClick) { suppressClick = false; return; }
  if (e.target.closest(".close")) { e.stopPropagation(); pb.tabs.close(idOf(li)).catch(() => {}); return; }
  pb.tabs.activate(idOf(li)).catch(() => {});
});
tabsEl.addEventListener("auxclick", (e) => { const li = liOf(e); if (li && pb && e.button === 1) { e.preventDefault(); pb.tabs.close(idOf(li)).catch(() => {}); } });

// Keyboard: arrows, Home and End move focus (not the selection); Enter or Space activates;
// Delete or Backspace closes; Cmd/Ctrl+Shift+Arrow moves the tab.
tabsEl.addEventListener("keydown", (e) => {
  const li = e.target.matches?.('li[role="tab"]') ? e.target : null;
  if (!li || !pb) return;
  const list = [...tabsEl.children];
  const at = list.indexOf(li);
  const id = idOf(li);
  const t = tabs.get(id);
  const arrow = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
  if (arrow && (e.metaKey || e.ctrlKey) && e.shiftKey) {
    e.preventDefault();
    const to = t.index + arrow;
    const other = list[at + arrow];
    if (!other || other.classList.contains("pinned") !== li.classList.contains("pinned")) return;
    pb.tabs.move(id, to, -1).then((r) => { if (r && r.ok === false) render(); }).catch(() => {});
    return;
  }
  let next = null;
  if (arrow) next = list[(at + arrow + list.length) % list.length];
  else if (e.key === "Home") next = list[0];
  else if (e.key === "End") next = list.at(-1);
  if (next) { e.preventDefault(); rovingId = idOf(next); roving(); next.focus(); return; }
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pb.tabs.activate(id).catch(() => {}); }
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); pb.tabs.close(id).catch(() => {}); }
});
tabsEl.addEventListener("focusout", (e) => { if (!tabsEl.contains(e.relatedTarget) && rovingId !== null) { rovingId = null; roving(); } });

// Drag to reorder: pointer events and CSS transitions (the siblings slide in 160 ms); one
// tabs.move on drop, the order then confirmed by onMoved.
let drag = null;
tabsEl.addEventListener("pointerdown", (e) => {
  suppressClick = false;
  if (e.button === 1) { e.preventDefault(); return; } // a middle click closes, never autoscrolls
  const li = liOf(e);
  if (e.button !== 0 || !pb || !li || li.classList.contains("pinned") || e.target.closest(".close")) return;
  const order = [...tabsEl.children];
  drag = { li, id: idOf(li), x0: e.clientX, pointer: e.pointerId, on: false, order, rects: order.map((n) => n.getBoundingClientRect()), from: order.indexOf(li), target: order.indexOf(li) };
});
tabsEl.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.pointer) return;
  const dx = e.clientX - drag.x0;
  if (!drag.on) {
    if (Math.abs(dx) < 4) return;
    drag.on = true;
    try { drag.li.setPointerCapture(e.pointerId); } catch {}
    document.body.dataset.dragging = "true";
    drag.li.classList.add("drag");
  }
  drag.li.style.transform = `translateX(${dx}px)`;
  const r = drag.rects[drag.from];
  const center = r.left + r.width / 2 + dx;
  const shift = r.width + 8;
  let target = drag.from;
  drag.order.forEach((n, i) => {
    if (n === drag.li) return;
    const c = drag.rects[i].left + drag.rects[i].width / 2;
    let to = "";
    if (!n.classList.contains("pinned")) {
      if (i < drag.from && center < c) { to = `translateX(${shift}px)`; target--; }
      else if (i > drag.from && center > c) { to = `translateX(${-shift}px)`; target++; }
    }
    n.style.transform = to;
  });
  drag.target = target;
});
function endDrag(e, cancel) {
  if (!drag || e.pointerId !== drag.pointer) return;
  const d = drag;
  drag = null;
  if (!d.on) return;
  suppressClick = !cancel;
  delete document.body.dataset.dragging; // the transitions go first, so nothing slides back
  d.li.classList.remove("drag");
  for (const n of d.order) n.style.transform = "";
  if (cancel || d.target === d.from) return;
  const to = ordered()[d.target]?.index;
  if (to === undefined) return;
  // Where the person dropped it, until the browser's onMoved confirms (or render() puts it back).
  tabsEl.insertBefore(d.li, d.order[d.target + (d.target > d.from ? 1 : 0)] || null);
  if (document.activeElement === document.body) d.li.focus();
  // Reconcile either way: render() is keyed, and onMoved has updated `tabs` by now.
  pb.tabs.move(d.id, to, -1).then(() => render()).catch(() => render());
}
tabsEl.addEventListener("pointerup", (e) => endDrag(e, false));
tabsEl.addEventListener("pointercancel", (e) => endDrag(e, true));

$("new").addEventListener("click", () => { if (pb) pb.tabs.create("", true, myWindow).catch(() => {}); });
$("new").hidden = !pb;

// Without the browser API: the helper's tabs event, read only (title, icon, the one shown).
function renderFallback(list) {
  const rows = (Array.isArray(list) ? list : []).map((t) => {
    const title = String(t?.title || "New Tab");
    const li = el("li", { title, tabIndex: t?.shown ? 0 : -1 }, el("span", { className: "icon" }, genericIcon()), el("span", { className: "title", textContent: title }));
    li.setAttribute("role", "tab");
    li.setAttribute("aria-selected", String(!!t?.shown));
    li.setAttribute("aria-label", `${title}${t?.agent ? `, ${t.agent} is in this tab` : ""}`);
    return li;
  });
  tabsEl.replaceChildren(...rows);
}

// ---- the helper's stream: the pill, the people, recording ----
let lastSession = null, lastCollab = null, lastBoard = { people: [] }, everOpen = false;
const pill = $("pill");
function drawPill() {
  const s = document.body.dataset.s;
  const state = s === "live" ? ((lastCollab?.guests || []).length ? "live" : "local") : everOpen && s === "connecting" ? "reconnecting" : "connecting";
  pill.dataset.state = state;
  $("pill-text").textContent = state === "live" ? "Live session" : state === "local" ? String(lastSession?.where || "Local")
    : state === "reconnecting" ? "Reconnecting to PairBrowse" : s === "closed" ? "Not connected to PairBrowse" : "Connecting to PairBrowse";
  pill.title = lastSession?.name ? `${lastSession.where || "Local"} · ${lastSession.name}` : "";
}
// Who is in the session (the side panel's header): board people by name with their color, then
// guests; four shown, then "+N".
function drawAvatars() {
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

function connect(url) {
  if (!url) { document.body.dataset.s = "closed"; drawPill(); return; }
  base = url;
  // panel: the helper's "no page stream" flag (liveview.mjs events): the strip is never a viewer, so it never starts the screencast.
  const es = new EventSource(base + "events?page=strip&panel=1");
  const on = (event, fn) => es.addEventListener(event, (e) => { let v; try { v = JSON.parse(e.data); } catch { return; } fn(v); });
  es.onopen = () => { everOpen = true; document.body.dataset.s = "live"; drawPill(); };
  es.onerror = () => { document.body.dataset.s = es.readyState === EventSource.CLOSED ? "closed" : "connecting"; drawPill(); };
  on("session", (s) => { lastSession = s && typeof s === "object" ? s : null; drawPill(); });
  on("collaboration", (c) => { lastCollab = c && typeof c === "object" ? c : null; drawPill(); drawAvatars(); });
  on("board", (b) => { lastBoard = { people: Array.isArray(b?.people) ? b.people : [] }; drawAvatars(); });
  on("record", (r) => drawRecord(r?.recording));
  if (!pb) {
    on("tabs", renderFallback);
    on("layout", (l) => drawSparkle(l?.right === "open"));
  }
}
async function helperBase() {
  if (pb) {
    try { const { origin, key } = await pb.session.helper(); return origin && key ? `${origin}/${key}/` : null; } catch { return null; }
  }
  try { return (await globalThis.chrome?.storage?.session?.get("view"))?.view || null; } catch { return null; }
}

// ---- the browser API: this window's tabs, their owners, the dock layout ----
async function start() {
  if (pb) {
    try {
      const given = Number(new URLSearchParams(location.search).get("window"));
      if (Number.isInteger(given) && given > 0) myWindow = given;
      else {
        const { windows } = await pb.windows.list();
        myWindow = (windows.find((w) => w.focused) || windows[0])?.id ?? -1;
      }
      pb.tabs.addObserver({
        onCreated: (t) => { if (t.window === myWindow) { tabs.set(t.id, t); render(); } },
        onChanged: (t) => { if (tabs.has(t.id)) { tabs.set(t.id, t); render(); } },
        onRemoved: (id) => { if (tabs.delete(id)) render(); },
        onMoved: (id, index, w) => {
          if (w !== myWindow) tabs.delete(id);
          else if (tabs.has(id)) tabs.get(id).index = index;
          render();
        },
        onActivated: (id, w) => { if (w !== myWindow) return; for (const t of tabs.values()) t.active = t.id === id; render(); },
      });
      pb.agent.addObserver({
        onOwnerChanged: (id, agent, color) => {
          const k = String(id);
          if (agent) { owners.agents[k] = agent; owners.colors[k] = color; }
          else { delete owners.agents[k]; delete owners.colors[k]; }
          render();
        },
      });
      pb.layout.addObserver({ onLayout: (s) => drawSparkle(s?.right === pb.DockState.kOpen) });
      const [{ tabs: list }, got, { state }] = await Promise.all([pb.tabs.list(), pb.agent.getOwners(), pb.layout.get()]);
      owners = { agents: { ...(got?.agents || {}) }, colors: { ...(got?.colors || {}) } };
      for (const t of list) if (t.window === myWindow) tabs.set(t.id, t);
      drawSparkle(state?.right === pb.DockState.kOpen);
      render();
    } catch {}
  }
  connect(await helperBase());
}
start();
