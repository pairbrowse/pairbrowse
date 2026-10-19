// The browser build's top strip (DESIGN.md B2). One document, three hosts by location hash: the
// tab row (no hash; 47 px since 580, 53 before), the nav fragments beside the native address bar
// (#nav-left, #nav-right) and at the nav row's end after the extensions button (#nav-end: the
// sparkle), and the Share card alone (#share) for the browser's Share bubble, which
// the row's slot cannot draw. The logo and wordmark are a static brand mark: the sessions' door is the left
// dock's Sessions row. Tabs, owners and the dock layout come from window.pairbrowse
// (the browser's own API); people and sharing from the helper's event stream, and the
// helper's agent-tabs, which this page writes into the browser's owners for its window's tabs (the
// owner dots of every page read those). Without window.pairbrowse the row shows the helper's tabs
// event, read only. Nothing here starts a timer,
// a frame loop or a DOM observer: observers of the browser API and the one shared helper stream
// (common.js helperStream) only. The nav fragments read no stream at all.
import { $, el, avatar, shareCard, isColor, helperStream, servedByBrowser, enter, leave, calm } from "../common.js";
import { isSettingsPage, settingsPage } from "../urls.js";
import { hasBubbles, anchorRect, reopenGuard } from "../bubbles.js";
import { pointersFor, createTabOrder, createOwnerSync } from "./sync.js";
import { helperAddress, onHelperAddress, postJson } from "../helper.js";

const pb = window.pairbrowse || null;
const mac = /mac/i.test(navigator.platform);
document.body.dataset.platform = mac ? "mac" : /linux/i.test(navigator.platform) ? "linux" : "other";
// The left dock's state (DockState: hidden, rail, open), for where the brand mark stands on Linux:
// over the dock's icons, which sit further in when the dock is open (strip.css).
const LEFT_DOCK = ["hidden", "rail", "open"];
const drawLeft = (left) => { document.body.dataset.left = typeof left === "string" ? left : LEFT_DOCK[left] || "rail"; };
document.body.dataset.native = String(!!pb);
// Served by the browser itself (chrome://pairbrowse.top-chrome), with or without the API.
const nativeHost = servedByBrowser();
// The browser's own host: its API, or served by it (strip.css lets the row end before the engine's ⋯).
document.body.dataset.host = pb || nativeHost ? "native" : "page";

// Back, forward and find come from the browser API when it has them (the active tab's history,
// the window's find bar); without it they show disabled, their shortcut in the name, never a
// state they don't have. The star is the engine's own in the address bar beside the nav-right
// fragment, so the fragment draws none in the browser.
const KEYS = mac
  ? { back: "Back (⌘[)", forward: "Forward (⌘])", reload: "Reload (⌘R)", find: "Find in page (⌘F)" }
  : { back: "Back (Alt+Left)", forward: "Forward (Alt+Right)", reload: "Reload (Ctrl+R)", find: "Find in page (Ctrl+F)" };
for (const id of ["back", "forward", "reload", "find"]) { $(id).setAttribute("aria-label", KEYS[id]); $(id).title = KEYS[id]; }

const tabsEl = $("tabs");
let base = null; // the helper's address, `${origin}/${key}/`; null: not connected
let myWindow = -1;
const tabs = new Map(); // id -> tab (this window's only)
const lis = new Map(); // id -> li
let owners = { agents: {}, colors: {} };
let rovingId = null; // the tab keyboard focus moved to with the arrows (else the active one)
// The active tab stays in view (inView below): the tab it last kept in view and the row's width then.
// It runs from slotControls at load, so its state and helpers are declared here, before that.
let shownActive = null, shownWidth = -1, wheelOn = false, revealed = false;
const SPARE = 24; // px kept clear beside the active tab: the edge fade's width

// ---- modes ----
const MODES = new Set(["row", "nav-left", "nav-right", "nav-end", "share"]);
const BUBBLES = new Set(["share"]);
let mode = "";
const bubble = () => BUBBLES.has(mode);
// The nav fragments open no stream: a page per window, and nothing on them reads the helper.
const navMode = () => mode === "nav-left" || mode === "nav-right" || mode === "nav-end";
let stream = null; // the shared helper stream (common.js), once start() has run outside a nav mode
let started = false, streamAsked = false;

// ---- Share: the side panel's card (common.js) ----
const share = shareCard({ btn: $("share-btn"), card: $("share-card"), base: () => base, dismissable: () => !bubble() });

// ---- the ⋯ menu: the browser's own app menu when it offers one (Bubbles kAppMenu, below), else
// this page's popover with PairBrowse settings ----
const menuBtn = $("menu-btn"), menu = $("menu");
const items = () => [...menu.querySelectorAll('[role="menuitem"]')].filter((b) => !b.disabled && !b.hidden);
const outsideMenu = (e) => { if (!menu.contains(e.target) && !menuBtn.contains(e.target)) closeMenu(false); };
function openMenu() {
  if (menu.hidden) {
    menu.hidden = false;
    menuBtn.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", outsideMenu, true);
  }
  items()[0]?.focus();
}
function closeMenu(refocus = true) {
  if (menu.hidden) return;
  menu.hidden = true;
  menuBtn.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", outsideMenu, true);
  if (refocus) menuBtn.focus();
}
// With the browser's app menu a click (Enter and Space are the button's own click) or ArrowDown
// opens it anchored to the button, and a second click closes it (toggleBubble, below).
menuBtn.addEventListener("click", () => {
  if (hasAppMenu()) { toggleBubble("menu"); return; }
  if (menu.hidden) openMenu(); else closeMenu();
});
menuBtn.addEventListener("keydown", (e) => {
  if (hasAppMenu()) {
    if (e.key === "ArrowDown" && !remote.menu) { e.preventDefault(); toggleBubble("menu"); }
    else if (e.key === "Escape" && remote.menu) { e.preventDefault(); toggleBubble("menu"); }
    return;
  }
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
// Part H: the menu holds what has no other door in a page host: PairBrowse settings (found if open,
// else a new tab). New window, Zoom (it maximized the window) and Record (one home: the agent
// panel's Tools) are gone; the browser's own menu and shortcuts do the window's.
menuItem("settings", async () => {
  if (!pb) return;
  try {
    const { tabs } = await pb.tabs.list();
    const open = (tabs || []).find((t) => t.window === myWindow && isSettingsPage(t.url));
    if (open) await pb.tabs.activate(open.id);
    else await pb.tabs.create(settingsPage(), true, myWindow);
  } catch {}
});
// Without the browser's API the menu has nothing to call.
if (!pb) menuBtn.hidden = true;

// ---- a page no taller than the row (the browser's tab-row slot, 47 or 53 px, which clips the rest):
// nothing can open under the row. With the browser's bubbles (530 E1, pairbrowse.bubbles) Share's
// card opens in a bubble of the window anchored to Share (B2): this page in its #share mode, framed
// by the browser, which owns its dismissal and says when it closed (OnClosed; by Escape, or closed
// by its own page, the focus comes back to Share). Without them (a build before 530) the card opens
// at the top of the agent panel, right under Share, with a caret at it (DESIGN.md Part I); the
// panel opens first if it is not. Share shows the card's state (pressed, aria-expanded) and a
// second click or Escape on it closes it. The ⋯, which the browser draws beside the slot, is not
// shown. Each runs in the capture phase, ahead of the card's own click handler, so no popover opens
// unseen and no focus moves into one. ----
const ROW_ONLY = 60; // px: taller than the row (47 or 53 px), shorter than any popover
// Without the browser API there is no dock to ask: the popovers open in place.
const inSlot = () => !!pb && !bubble() && mode === "row" && window.innerHeight <= ROW_ONLY;
const SHARE_CHANNEL = "pairbrowse-share";
const SHARE_SLOT_LABEL = "Share this session (opens under Share, in the agent panel)";
// The engine's own ⋯ (32 px, 16 px from the window's edge) sits after this page in the browser: the
// docks measure from the window's edge (native: B2).
const APP_MENU = nativeHost ? 48 : 0;
// What the dock or the browser's bubble said it shows for this window: Share's card, the app menu.
const remote = { share: false, menu: false };
// ---- the browser's bubbles (530 E1) ----
const KINDS = pb?.BubbleKind && Number.isInteger(pb.BubbleKind.kShare) ? pb.BubbleKind : { kSwitcher: 0, kShare: 1, kPicture: 2 };
// The browser's own app menu as a bubble kind (a newer browser): the ⋯ opens it, not the page's popover.
const hasAppMenu = () => Number.isInteger(pb?.BubbleKind?.kAppMenu) && hasBubbles(pb);
const BUBBLE_OF = { share: KINDS.kShare, menu: KINDS.kAppMenu };
const TRIGGER_OF = { share: "share-btn", menu: "menu-btn" };
const keyOfKind = (kind) => (kind === KINDS.kShare ? "share" : Number.isInteger(KINDS.kAppMenu) && kind === KINDS.kAppMenu ? "menu" : null);
// A click outside that lands on the bubble's own trigger is its close, not a new open (bubbles.js).
const guard = reopenGuard();
let bubblesObserved = false;
function observeBubbles() {
  if (bubblesObserved) return;
  bubblesObserved = true;
  pb.bubbles.addObserver({
    onClosed: (kind, byEscape) => {
      const key = keyOfKind(kind);
      if (!key) return;
      remote[key] = false;
      guard.closed(key, byEscape);
      slotControls();
      // Escape, a pick or the bubble's own x: the focus comes back to the trigger.
      if (byEscape) $(TRIGGER_OF[key]).focus();
    },
  });
}
async function toggleBubble(key) {
  observeBubbles();
  if (remote[key]) {
    remote[key] = false;
    guard.closing(key);
    slotControls();
    pb.bubbles.close(BUBBLE_OF[key]).catch(() => {});
    return;
  }
  if (guard.blocked(key)) return;
  let shown = false;
  try { ({ shown } = await pb.bubbles.open(BUBBLE_OF[key], anchorRect($(TRIGGER_OF[key])), "")); } catch {}
  // One bubble per window: opening one closed the other.
  for (const k of Object.keys(remote)) remote[k] = k === key && !!shown;
  slotControls();
}
function slotControls() {
  const slot = inSlot();
  const b = $("share-btn");
  // In the slot the card is in another page: its state shows here (pressed), never its id.
  if (slot) { b.setAttribute("aria-expanded", String(remote.share)); b.removeAttribute("aria-controls"); b.dataset.remote = String(remote.share); }
  else { b.setAttribute("aria-expanded", String(!$("share-card").hidden)); b.setAttribute("aria-controls", "share-card"); delete b.dataset.remote; }
  if (slot && hasBubbles(pb)) { b.removeAttribute("title"); b.setAttribute("aria-haspopup", "dialog"); }
  else if (slot) b.title = SHARE_SLOT_LABEL;
  else b.removeAttribute("title");
  menuBtn.hidden = slot || !pb;
  // The browser's app menu is its own: the ⋯ shows it open, never this page's #menu.
  if (hasAppMenu()) { menuBtn.setAttribute("aria-expanded", String(remote.menu)); menuBtn.removeAttribute("aria-controls"); }
  else { menuBtn.setAttribute("aria-expanded", String(!menu.hidden)); menuBtn.setAttribute("aria-controls", "menu"); }
  inView();
}
// Opens a dock (the right for Share) before it asks over the channel.
async function openDock(side) {
  if (!pb) return;
  try {
    const { state } = await pb.layout.get();
    if (state[side] !== pb.DockState.kOpen) await pb.layout.set({ ...state, [side]: pb.DockState.kOpen });
  } catch {}
}
const ask = (msg) => { try { shareChannel?.postMessage({ ...msg, window: myWindow }); } catch {} };
// Where Share is, so the dock puts its caret under it: its centre from the window's right edge.
function anchorOf(id) {
  const r = $(id).getBoundingClientRect();
  return { right: Math.round(window.innerWidth - r.right + r.width / 2 + APP_MENU) };
}
$("share-btn").addEventListener("click", async (e) => {
  if (!inSlot()) return;
  $("share-note").textContent = "";
  e.stopImmediatePropagation();
  if (hasBubbles(pb)) { toggleBubble("share"); return; }
  if (remote.share) { ask({ close: "share" }); return; }
  await openDock("right");
  // The card opens under Share in the agent panel: said only once the dock says it opened it (the
  // focus stays here); with no answer, what to do instead.
  clearTimeout(shareWait);
  shareWait = setTimeout(() => { shareWait = 0; $("share-note").textContent = "Open the agent panel (the sparkle beside the address bar) to share"; }, pb ? SHARE_WAIT_MS : 0);
  ask({ open: "share", anchor: anchorOf("share-btn") });
}, true);
// Escape on Share closes what it opened in the dock (the focus stays on Share).
$("share-btn").addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !inSlot() || !remote.share) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (hasBubbles(pb)) { toggleBubble("share"); return; }
  ask({ close: "share" });
}, true);
let shareChannel = null, shareWait = 0;
const SHARE_WAIT_MS = 1000;
try {
  shareChannel = new BroadcastChannel(SHARE_CHANNEL);
  shareChannel.onmessage = (e) => {
    if (e.data?.window !== myWindow || myWindow === -1) return;
    const opened = e.data?.opened, closed = e.data?.closed;
    if (opened === "share") { clearTimeout(shareWait); shareWait = 0; $("share-note").textContent = "Share card opened under Share, in the agent panel (F6)"; remote.share = true; }
    else if (closed === "share") remote.share = false;
    else return;
    slotControls();
  };
} catch {}

// ---- in the browser's own Share bubble (530 E2 B2): the card's x closes it; the browser then gives
// the focus back to Share. (B1, the switcher, is the picker page itself: ui/picker #bubble.) ----
const inNativeBubble = () => hasBubbles(pb) && mode === "share";
$("share-close").addEventListener("click", () => { if (inNativeBubble()) pb.bubbles.close(KINDS.kShare).catch(() => {}); });

// ---- hash modes (no reload: the hash only picks what shows) ----
function openBubble(m) {
  if (m === "share" && $("share-card").hidden) share.open();
}
function closeBubble(m) {
  if (m === "share" && !$("share-card").hidden) share.close(false);
}
function applyMode() {
  const given = location.hash.slice(1);
  const next = MODES.has(given) ? given : "row";
  if (next === mode) return;
  const was = mode;
  mode = next;
  if (BUBBLES.has(was)) closeBubble(was);
  document.body.dataset.mode = mode;
  // The browser frames the bubble modes (its corners, shadow and motion): the card fills the page.
  if (hasBubbles(pb) && BUBBLES.has(mode)) document.body.dataset.bubble = "native"; else delete document.body.dataset.bubble;
  $("share-close").hidden = !inNativeBubble() || mode !== "share";
  $("row").hidden = !(mode === "row" || BUBBLES.has(mode));
  $("nav-left").hidden = mode !== "nav-left";
  $("nav-right").hidden = mode !== "nav-right";
  $("nav-end").hidden = mode !== "nav-end";
  if (BUBBLES.has(mode)) openBubble(mode);
  slotControls();
  ensureStream();
}
// In the bubble the host owns dismissal: no outside-click listener is registered and Escape
// closes nothing (the share card's Escape paths check bubble()).
window.addEventListener("hashchange", applyMode);
window.addEventListener("resize", () => { if (mode === "row") slotControls(); });
applyMode();

// ---- the nav fragments ----
const activeId = () => { for (const t of tabs.values()) if (t.active) return t.id; return -1; };
const can = (iface, method) => typeof pb?.[iface]?.[method] === "function";
$("reload").disabled = !pb;
$("reload").addEventListener("click", () => { const id = activeId(); if (pb && id !== -1) pb.tabs.reload(id).catch(() => {}); });
$("back").addEventListener("click", () => { const id = activeId(); if (can("tabs", "goBack") && id !== -1) pb.tabs.goBack(id).catch(() => {}); });
$("forward").addEventListener("click", () => { const id = activeId(); if (can("tabs", "goForward") && id !== -1) pb.tabs.goForward(id).catch(() => {}); });
$("find").addEventListener("click", () => { if (can("windows", "find") && myWindow !== -1) pb.windows.find(myWindow).catch(() => {}); });
// Back and forward follow the active tab's history as the browser reports it.
function drawNav() {
  const t = tabs.get(activeId());
  $("back").disabled = !(can("tabs", "goBack") && t?.canGoBack === true);
  $("forward").disabled = !(can("tabs", "goForward") && t?.canGoForward === true);
  $("find").disabled = !(can("windows", "find") && myWindow !== -1);
}
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
// Shared: a dot sending waves (the browser is capturing the tab), drawn in the accent.
const sharedIcon = () => {
  const s = svg("0 0 16 16", "shared-mark", [["circle", { cx: "8", cy: "8", r: "1.75", fill: "currentColor" }], ["path", { d: "M5.2 5.2a4 4 0 0 0 0 5.6M10.8 5.2a4 4 0 0 1 0 5.6M3.1 3.1a7 7 0 0 0 0 9.8M12.9 3.1a7 7 0 0 1 0 9.8", ...line }]]);
  const tip = document.createElementNS(SVG, "title");
  tip.textContent = "Shared";
  s.prepend(tip);
  return s;
};
const closeIcon = () => svg("0 0 12 12", "", [["path", { d: "M3 3l6 6M9 3l-6 6", ...line }]]);
// A favicon the page may show under its CSP: data: images (the adapter's) or the browser's own.
const faviconOk = (u) => typeof u === "string" && /^(data:image\/|chrome:\/\/)/.test(u);
const loadingState = (t) => pb && (t.networkState === pb.NetworkState.kWaiting || t.networkState === pb.NetworkState.kLoading);
const titleOf = (t) => String(t.title || t.url || "New tab");

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
  const shared = t.capturing === true;
  li.classList.toggle("shared", shared);
  li.setAttribute("aria-label", `${title}${shared ? ", shared" : ""}${agent ? `, ${agent} is in this tab` : ""}${loading ? ", loading" : ""}${t.pinned ? ", pinned" : ""}`);
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
  // The Shared mark: the browser is capturing this tab (people in the session see it live, or a
  // recording takes it). A still glyph in the accent after the title; the words are in the tab's
  // name (", shared") and the glyph's tooltip.
  let mark = li.querySelector(".shared-mark");
  if (shared) {
    if (!mark) { mark = sharedIcon(); li.querySelector(".title").after(mark); }
  } else mark?.remove();
  // The agent dot: the owning agent's color, right after the title (strip.css), named in words too.
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
// The tabs on the row, without one that is folding away (a closed tab leaves in --t-close).
const shownTabs = () => [...tabsEl.children].filter((n) => !n.dataset.leaving);
let rendered = false; // start()'s first render places the tabs; a tab created later grows in (--t-open)
function render() {
  const focused = document.activeElement?.closest?.("#tabs li");
  const hadFocus = !!focused;
  const focusedId = focused ? Number(focused.dataset.id) : null;
  // A tab folding away or growing in changes the overflow once it is done: the edges again then.
  for (const [id, li] of lis) if (!tabs.has(id)) { lis.delete(id); leave(li, { axis: "inline", then: edges }); }
  ordered().forEach((t, i) => {
    const fresh = !lis.has(t.id);
    const li = drawTab(t);
    const kids = shownTabs();
    if (kids[i] !== li) tabsEl.insertBefore(li, kids[i] || null);
    if (fresh && rendered) enter(li, { axis: "inline" })?.finished.then(edges, () => {});
  });
  if (rovingId !== null && !lis.has(rovingId)) rovingId = null;
  roving();
  drawNav();
  // A tab moved in the DOM loses focus; a closed one hands it to the tab now active.
  // A closed tab folds away (inert): the focus leaves it for the tab now active.
  if (hadFocus && (!tabsEl.contains(document.activeElement) || document.activeElement.closest("[data-leaving]"))) (lis.get(focusedId) || lis.get(activeId()))?.focus({ preventScroll: true });
  inView();
}

// ---- the active tab stays in view (B2: tabs keep their 160 px minimum; past it the row scrolls) ----
// After a render where the active tab changed (or a tab was created active), and whenever the
// row's width changed, the active tab is scrolled fully into the row with 24 px to spare, the
// width of the edge fade; the same rule runs for a tab that takes the focus. #tabs only, never
// scrollIntoView (that also scrolls the body). Smooth (the browser's own scroll), instant under
// reduced motion and on the first render. Run by events only: renders, the window's resize, the
// right end's redraws, focus, a tab's entrance or exit ending; no timer and no observer.
function shownActiveLi() { return tabsEl.querySelector('li[aria-selected="true"]:not([data-leaving])'); }
function reveal(li, smooth) {
  const box = tabsEl.getBoundingClientRect();
  const w = tabsEl.clientWidth;
  if (!li || !w) return;
  const r = li.getBoundingClientRect();
  const left = r.left - box.left - tabsEl.clientLeft + tabsEl.scrollLeft;
  const right = left + r.width;
  const now = tabsEl.scrollLeft;
  let to = now;
  if (right > now + w - SPARE) to = right - w + SPARE;
  if (left < to + SPARE) to = left - SPARE; // a tab wider than the row shows its start
  to = Math.max(0, Math.min(to, tabsEl.scrollWidth - w));
  if (Math.abs(to - now) < 1) return;
  tabsEl.scrollTo({ left: to, behavior: smooth && !calm() && !document.hidden ? "smooth" : "instant" });
}
function inView() {
  const w = tabsEl.clientWidth;
  if (!w) return; // a nav fragment or a bubble: no row shown
  const li = shownActiveLi();
  const changed = li !== shownActive, resized = w !== shownWidth;
  shownActive = li;
  shownWidth = w;
  if (li && (changed || resized)) {
    reveal(li, revealed && changed);
    revealed = true;
    // A tab created active grows in (--t-open): once it has its width, the rule again.
    const growing = li.getAnimations?.() || [];
    for (const a of growing) a.finished.then(() => { if (shownActiveLi() === li) reveal(li, true); edges(); }, () => {});
  }
  edges();
}
// The row shows where tabs are hidden: a 24 px fade at each edge that has some (strip.css,
// static). The vertical wheel scrolls the row only while it overflows (passive otherwise).
function edges() {
  const over = tabsEl.scrollWidth - tabsEl.clientWidth;
  tabsEl.classList.toggle("fade-start", over > 0 && tabsEl.scrollLeft > 0.5);
  tabsEl.classList.toggle("fade-end", over > 0 && tabsEl.scrollLeft < over - 0.5);
  if (over > 0 !== wheelOn) {
    wheelOn = over > 0;
    if (wheelOn) tabsEl.addEventListener("wheel", wheel, { passive: false });
    else tabsEl.removeEventListener("wheel", wheel, { passive: false });
  }
}
function wheel(e) {
  if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // a pinch, or already sideways
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? tabsEl.clientWidth : 1;
  tabsEl.scrollBy({ left: e.deltaY * unit, behavior: "instant" });
}
tabsEl.addEventListener("scroll", edges, { passive: true });
tabsEl.addEventListener("focusin", (e) => { const li = e.target.closest?.('li[role="tab"]'); if (li && !li.dataset.leaving) reveal(li, !calm()); });

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
// Delete closes (Backspace does not: easy to press by accident); Cmd/Ctrl+Shift+Arrow moves the tab.
tabsEl.addEventListener("keydown", (e) => {
  const li = e.target.matches?.('li[role="tab"]') ? e.target : null;
  if (!li || !pb) return;
  const list = shownTabs();
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
  if (next) { e.preventDefault(); rovingId = idOf(next); roving(); next.focus({ preventScroll: true }); return; }
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pb.tabs.activate(id).catch(() => {}); }
  else if (e.key === "Delete") { e.preventDefault(); pb.tabs.close(id).catch(() => {}); }
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
  const order = shownTabs();
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
    const title = String(t?.title || "New tab");
    const li = el("li", { title, tabIndex: t?.shown ? 0 : -1 }, el("span", { className: "icon" }, genericIcon()), el("span", { className: "title", textContent: title }));
    li.setAttribute("role", "tab");
    li.setAttribute("aria-selected", String(!!t?.shown));
    li.setAttribute("aria-label", `${title}${t?.agent ? `, ${t.agent} is in this tab` : ""}`);
    return li;
  });
  tabsEl.replaceChildren(...rows);
  inView();
}

// ---- the helper's stream: the pill, the people ----
let lastSession = null, lastCollab = null, lastBoard = { people: [] }, everOpen = false;
const pill = $("pill");
// No helper (closed, or none to ask) is the normal resting state: "Local" with the muted dot, as
// when not sharing; --warn is for reconnecting only.
function drawPill() {
  const s = document.body.dataset.s;
  const offline = s === "closed" || s === "none" || (s === "connecting" && !everOpen); // never opened: no helper reached
  const state = s === "live" ? ((lastCollab?.guests || []).length ? "live" : "local") : offline ? "local"
    : everOpen && s === "connecting" ? "reconnecting" : "connecting";
  pill.dataset.state = state;
  $("pill-text").textContent = state === "live" ? "Live session" : offline ? "Local" : state === "local" ? String(lastSession?.where || "Local")
    : state === "reconnecting" ? "Reconnecting to PairBrowse" : "Connecting to PairBrowse";
  pill.title = offline ? "No agent connected" : lastSession?.name ? `${lastSession.where || "Local"} · ${lastSession.name}` : "";
  inView(); // the pill's width is the row's
}
// Who is in the session (the side panel's header): board people by name with their color, then
// guests; three shown (the mockup), then "+N".
const SHOWN = 3;
function drawAvatars() {
  const seen = new Set();
  const people = [];
  for (const p of lastBoard.people) if (p?.who && !seen.has(p.who)) { seen.add(p.who); people.push({ name: p.who, color: p.color }); }
  for (const g of lastCollab?.guests || []) if (g?.label && !seen.has(g.label)) { seen.add(g.label); people.push({ name: g.label, color: "" }); }
  const shown = people.slice(0, SHOWN).map((p) => el("li", {}, avatar(p.name, p.color)));
  if (people.length > SHOWN) {
    const more = el("span", { className: "avatar more", textContent: `+${people.length - SHOWN}` });
    more.setAttribute("role", "img");
    more.setAttribute("aria-label", `${people.length - SHOWN} more`);
    shown.push(el("li", {}, more));
  }
  $("avatars").replaceChildren(...shown);
  inView();
}

function connect(url) {
  if (!url) { stream?.close(); stream = null; base = null; document.body.dataset.s = "closed"; drawPill(); return; }
  if (url === base && stream) return;
  stream?.close();
  base = url;
  // panel=1 always (common.js): the strip is never a viewer, so it never starts the screencast.
  stream = helperStream(base, {
    kind: "strip",
    onState: (s) => { if (s === "live") everOpen = true; document.body.dataset.s = s; drawPill(); },
  });
  const on = stream.on;
  on("session", (s) => { lastSession = s && typeof s === "object" ? s : null; drawPill(); });
  on("collaboration", (c) => { lastCollab = c && typeof c === "object" ? c : null; drawPill(); drawAvatars(); });
  on("board", (b) => { lastBoard = { people: Array.isArray(b?.people) ? b.people : [] }; drawAvatars(); });
  if (!pb) {
    on("tabs", renderFallback);
    on("layout", (l) => { drawSparkle(l?.right === "open"); if (l?.left) drawLeft(l.left); });
  } else if (!bubble()) {
    // The row writes the owners and reports the order; a bubble's page (the same strip) does not.
    on("agent-tabs", ownerSync.apply);
    on("tab-order", (m) => { if (m?.op === "arrange" && Array.isArray(m.targets)) tabOrder.arrange(m.targets); });
    if (typeof pb.pointers?.show === "function") on("overlay-pointers", showPointers);
    tabOrder.report();
  }
}

function showPointers(list) {
  if (!pb || mode !== "row") return;
  pb.pointers.show(pointersFor(list)).catch(() => {});
}
// The tab order and the owners (sync.js), over this page's state.
const tabOrder = createTabOrder({ pb, base: () => base, windowId: () => myWindow, skip: () => bubble() });
const ownerSync = createOwnerSync({ pb, tabs, owners: () => owners, windowId: () => myWindow });
// Connects once, outside the nav modes; a nav mode reads no stream and keeps no state attribute.
// moved: a new address from the extension's worker (a helper restarted on a new key) once
// connected, which the stream moves to.
async function ensureStream(moved = null) {
  if (navMode()) {
    if (stream) { stream.close(); stream = null; base = null; streamAsked = false; }
    delete document.body.dataset.s;
    return;
  }
  if ((streamAsked && !moved) || !started) return;
  streamAsked = true;
  const url = moved || await helperAddress();
  if (navMode()) { streamAsked = false; return; }
  connect(url);
}
// The browser's helper keeps one address (ui/helper.js): only the extension's can move.
onHelperAddress((url) => { if (streamAsked) ensureStream(url); });

// ---- the browser API: this window's tabs, their owners, the dock layout ----
async function start() {
  if (pb) {
    try {
      const given = Number(new URLSearchParams(location.search).get("window"));
      if (Number.isInteger(given) && given > 0) myWindow = given;
      else {
        const { windows } = await pb.windows.list();
        myWindow = (windows.find((w) => w.current) || windows.find((w) => w.focused) || windows[0])?.id ?? -1;
      }
      pb.tabs.addObserver({
        onCreated: (t) => { tabOrder.report(); if (t.window === myWindow) { tabs.set(t.id, t); render(); ownerSync.remap(); } },
        onChanged: (t) => { if (tabs.has(t.id)) { tabs.set(t.id, t); render(); } },
        onRemoved: (id) => { tabOrder.report(); if (tabs.delete(id)) { render(); ownerSync.remap(); } },
        // The browser sends a move for every tab whose index changed (its tabs handler syncs the
        // whole window), so each tab's index here is the browser's own.
        onMoved: (id, index, w) => {
          tabOrder.report();
          if (w !== myWindow) tabs.delete(id);
          else if (tabs.has(id)) tabs.get(id).index = index;
          render();
          ownerSync.remap();
        },
        onActivated: (id, w) => { tabOrder.report(); if (w !== myWindow) return; for (const t of tabs.values()) t.active = t.id === id; render(); },
      });
      pb.windows.addObserver({ onFocusChanged: (id) => { tabOrder.focused(id); tabOrder.report(); } });
      pb.agent.addObserver({
        onOwnerChanged: (id, agent, color) => {
          const k = String(id);
          if (agent) { owners.agents[k] = agent; owners.colors[k] = color; }
          else { delete owners.agents[k]; delete owners.colors[k]; }
          render();
        },
      });
      pb.layout.addObserver({ onLayout: (s) => { drawSparkle(s?.right === pb.DockState.kOpen); drawLeft(s?.left); } });
      const [{ tabs: list }, got, { state }] = await Promise.all([pb.tabs.list(), pb.agent.getOwners(), pb.layout.get()]);
      owners = { agents: { ...(got?.agents || {}) }, colors: { ...(got?.colors || {}) } };
      for (const t of list) if (t.window === myWindow) tabs.set(t.id, t);
      drawSparkle(state?.right === pb.DockState.kOpen);
      drawLeft(state?.left);
      render();
    } catch {}
    rendered = true;
  }
  started = true;
  ensureStream();
}
start();
