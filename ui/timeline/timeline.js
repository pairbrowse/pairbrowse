// The session timeline (DESIGN.md B7): the pictures the helper sent to agents, the current picture
// first, then the history oldest to newest, then Add note, from the helper's owner routes (timeline.json, timeline/<id>.jpg, DELETE timeline/<id>,
// POST timeline/note and timeline/<id>/pin) and the owner stream's `timeline` event. The page
// never toggles itself. A card's click shows its picture large: with the browser's bubbles (530 E1,
// pairbrowse.bubbles) in a bubble above the card (B3: this page again, in its #picture=<id> mode),
// else in the agent panel, which it opens when it is a rail or hidden (Part H). Nothing runs before
// the page is first visible; while hidden it fetches nothing and holds no picture.
import { $, el, shortClock, helperStream, enter, leave, busy } from "../common.js";

const PITCH = 114; // a card (104 px) and its gap (10 px)
const PAD = 15; // the strip's left padding
const DRIVING_MS = 8000; // "is driving" for this long after the agent's last action (as the side panel)
const FETCH_MARGIN = 3; // pictures fetched this many cards beyond the visible ones
const RELEASE_MARGIN = 10; // and released beyond this many
const ID = /^[0-9a-f]{12}$/;
const OFF_LINE = "The timeline is off";

let base = null;
let stream = null; // the shared helper stream (common.js helperStream)
let cards = []; // newest last, only what timeline.json, the stream and the route replies said
const nodes = new Map(); // id -> <li>
const held = new Map(); // id -> blob: URL
const loading = new Set(); // ids whose picture is on its way
const missing = new Set(); // ids the helper had no picture for (asked again after a reload or a new card)
let stale = false;
let started = false;
let lastActivity = 0;
let driveTimer = 0;
let focusId = null; // the card that takes Tab (roving tabindex)
let menuFor = null; // the card id whose menu is open
let drawn = false; // the first draw of a list places its cards; later ones grow in
let shownId = null; // the card last shown large in the agent panel (marked here, with a note under it)

// The picture bubble's own page (530 E2 B3): #picture=<the card's id>.
const PICTURE = /^#picture=([0-9a-f]{12})$/.exec(location.hash)?.[1] || null;
if (PICTURE) { document.body.dataset.mode = "picture"; $("picture").hidden = false; }

const strip = $("strip"), list = $("cards"), addLi = $("add"), addBtn = $("add-btn"), form = $("note-form"), note = $("note"), menu = $("menu");
const visible = () => document.visibilityState === "visible";
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const say = (text) => { $("said").textContent = text; };

// ---- what the helper says ----

// A card exactly as the helper writes it, or null.
function valid(c) {
  if (!c || typeof c !== "object" || typeof c.id !== "string" || !ID.test(c.id) || !Number.isFinite(c.t)) return null;
  if (typeof c.caption !== "string" || typeof c.who !== "string" || typeof c.pinned !== "boolean" || typeof c.note !== "boolean") return null;
  if (c.step !== null && !(c.step && typeof c.step === "object" && typeof c.step.url === "string" && typeof c.step.title === "string")) return null;
  return { id: c.id, t: c.t, caption: c.caption, step: c.step ? { url: c.step.url, title: c.step.title } : null, who: c.who, pinned: c.pinned, note: c.note };
}

function showLine(text, more = "") {
  $("line").classList.remove("toast");
  $("line-text").textContent = text;
  $("line-more").textContent = more;
  $("line").hidden = !text;
}

async function load() {
  if (!base) return;
  missing.clear();
  const r = await fetch(base + "timeline.json", { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (r?.status === 404) {
    const text = await r.text().catch(() => "");
    // The helper's own sentence when it says why (the config switch); a bare 404 is an older
    // helper without the store, and we don't claim why.
    const why = text.includes("config.json") ? text.trim().replace(new RegExp(`^${OFF_LINE}\\s*`), "").replace(/\.$/, "") : "";
    return off(why);
  }
  const body = r?.ok ? await r.json().catch(() => null) : null;
  // The helper not reached while its stream is not up (none running, or it went away): the resting
  // line, not an error; the stream's next open reads again.
  if (!r && document.body.dataset.s !== "live") { stale = true; addLi.hidden = true; showLine(NO_HELPER); return; }
  if (!body || !Array.isArray(body.cards)) {
    document.body.dataset.state = "error";
    addLi.hidden = true;
    showLine("Couldn't reach PairBrowse.");
    return;
  }
  const seen = new Set();
  cards = body.cards.map(valid).filter((c) => c && !seen.has(c.id) && seen.add(c.id));
  if (document.body.dataset.state !== "list") drawn = false;
  document.body.dataset.state = "list";
  addLi.hidden = false; // Add note only where a note can land: the list state
  list.hidden = false;
  draw();
  strip.scrollLeft = 0; // the current picture is first
  frame();
}

function off(why) {
  document.body.dataset.state = "off";
  addLi.hidden = true;
  cards = [];
  draw();
  list.hidden = true;
  showLine(OFF_LINE, why);
}

// One `timeline` event: { op: "add" | "remove" | "pin", card }. Anything else is ignored.
function apply(ev) {
  const card = valid(ev?.card);
  if (!card || document.body.dataset.state !== "list") return;
  if (ev.op === "add") add(card);
  else if (ev.op === "remove") remove(card.id);
  else if (ev.op === "pin") replace(card);
}

function add(card) {
  missing.delete(card.id);
  if (cards.some((c) => c.id === card.id)) return replace(card);
  // A picture becomes the first card: kept in view when the strip is at its start. A note joins the
  // history's end, kept in view when the strip is at its end.
  const atStart = strip.scrollLeft <= PITCH;
  const atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - PITCH;
  cards.push(card);
  draw();
  if (!card.note) { if (atStart) strip.scrollLeft = 0; }
  else if (atEnd) strip.scrollLeft = strip.scrollWidth;
  frame();
}
function remove(id) {
  const i = cards.findIndex((c) => c.id === id);
  if (i < 0) return false;
  cards.splice(i, 1);
  if (pictureOpen === id) closePicture();
  release(id);
  nodes.delete(id);
  if (focusId === id) focusId = null;
  if (menuFor === id) closeMenu(false);
  draw();
  frame();
  return true;
}
function replace(card) {
  const i = cards.findIndex((c) => c.id === card.id);
  if (i < 0) return;
  missing.delete(card.id);
  cards[i] = card;
  fill(nodes.get(card.id), card);
}

// ---- drawing ----

const label = (c) => `${shortClock(c.t)}, ${c.caption || (c.note ? "Note" : "Picture")}${c.pinned ? ", pinned" : ""}${c.note ? ", note" : ""}`;

function node(card) {
  const thumb = card.note ? el("span", { className: "thumb note-text" }) : el("img", { className: "thumb", alt: "" });
  const pill = el("span", { className: "live-pill", hidden: true }, el("i", { className: "live" }), "Live");
  pill.firstChild.setAttribute("aria-hidden", "true");
  const more = el("button", { className: "more", type: "button", textContent: "⋯", tabIndex: -1 });
  more.setAttribute("aria-haspopup", "menu");
  more.setAttribute("aria-expanded", "false");
  more.setAttribute("aria-controls", "menu");
  // The face is the button that shows the picture (click, Enter, Space); it carries the card's name,
  // aria-current and the roving tabindex. The More button is its sibling, not inside it, and roves
  // with the face: only the focused card's face and More are Tab stops.
  const face = el("button", { className: "face", type: "button", tabIndex: -1 }, thumb, el("span", { className: "time" }), el("span", { className: "cap" }));
  if (hasBubbles() && !card.note) { face.setAttribute("aria-haspopup", "dialog"); face.setAttribute("aria-expanded", "false"); }
  const li = el("li", { className: "card" }, face, el("span", { className: "pin-chip", hidden: true, textContent: "Pinned" }), pill, more);
  li.setAttribute("role", "listitem");
  li.dataset.id = card.id;
  return li;
}

// The face's aria-label replaces its content in the accessible name, so "current" is said in it.
function fill(li, c, now = current()) {
  if (!li) return;
  li.querySelector(".face").setAttribute("aria-label", label(c) + (c.id === now ? ", current" : ""));
  li.dataset.note = String(c.note);
  li.querySelector(".pin-chip").hidden = !c.pinned;
  li.querySelector(".time").textContent = shortClock(c.t);
  const cap = li.querySelector(".cap");
  cap.textContent = c.note ? "Note" : c.caption;
  cap.title = [c.caption, c.step?.title].filter(Boolean).join(" · ");
  if (c.note) li.querySelector(".note-text").textContent = c.caption;
  li.querySelector(".more").setAttribute("aria-label", `More for ${c.caption || shortClock(c.t)}`);
}

// The newest picture card (a note is not something the agent saw).
const current = () => { for (let i = cards.length - 1; i >= 0; i--) if (!cards[i].note) return cards[i].id; return null; };
// The display order: the current picture first, then every other card in the helper's order
// (oldest to newest, notes included).
function ordered() {
  const now = current();
  const first = now ? cards.find((c) => c.id === now) : null;
  return first ? [first, ...cards.filter((c) => c !== first)] : cards;
}

function draw() {
  const now = current();
  const items = ordered().map((c) => {
    let li = nodes.get(c.id);
    if (!li) { li = node(c); nodes.set(c.id, li); }
    fill(li, c, now);
    return li;
  });
  for (const id of nodes.keys()) if (!cards.some((c) => c.id === id)) { release(id); nodes.delete(id); }
  for (const li of items) {
    const on = li.dataset.id === now;
    const face = li.querySelector(".face");
    if (on) face.setAttribute("aria-current", "true");
    else face.removeAttribute("aria-current");
    if (!on) li.querySelector(".live-pill").hidden = true;
  }
  if (!focusId || !nodes.has(focusId)) focusId = now || cards.at(-1)?.id || null;
  for (const li of items) {
    const on = li.dataset.id === focusId;
    li.querySelector(".face").tabIndex = on ? 0 : -1;
    li.querySelector(".more").tabIndex = on ? 0 : -1;
  }
  // In place, Add note kept last: a node moved loses focus, so only what changed moves, and the
  // focus is put back where it was.
  // A card that joins grows in from nothing and one deleted folds away (common.js enter and leave),
  // once the list was read: the first draw only places them.
  const had = list.contains(document.activeElement) ? document.activeElement : null;
  // (A list that goes away whole, the timeline turned off, takes its cards at once.)
  const listing = document.body.dataset.state === "list";
  for (const li of [...list.children]) {
    if (li === addLi || li.dataset.leaving || items.includes(li)) continue;
    if (li.dataset.id === shownId) setShown(null);
    if (listing) leave(li, { axis: "inline" }); else li.remove();
  }
  const fresh = items.filter((li) => !li.isConnected);
  items.forEach((li, i) => { const at = [...list.children].filter((n) => !n.dataset.leaving)[i]; if (at !== li) list.insertBefore(li, at); });
  if (drawn) for (const li of fresh) enter(li, { axis: "inline" });
  drawn = true;
  if (had?.isConnected && document.activeElement !== had) had.focus({ preventScroll: true });
  if (document.body.dataset.state === "list") showLine(cards.length ? "" : "Nothing yet. Pictures sent to the agent appear here.");
  setDriver();
}

// ---- pictures: the visible cards and a few more, by display index (no observer) ----

function range(order = ordered()) {
  const first = Math.max(0, Math.floor((strip.scrollLeft - PAD) / PITCH));
  const last = Math.min(order.length - 1, Math.floor((strip.scrollLeft + strip.clientWidth - PAD) / PITCH));
  return [first, last];
}
function frame() {
  if (!visible() || !cards.length) return countHeld();
  const order = ordered();
  const [first, last] = range(order);
  order.forEach((c, i) => {
    if (i < first - RELEASE_MARGIN || i > last + RELEASE_MARGIN) release(c.id);
    else if (i >= first - FETCH_MARGIN && i <= last + FETCH_MARGIN) want(c);
  });
  countHeld();
}
const countHeld = () => { document.body.dataset.held = String(held.size); };

// Every picture fetch goes through here: none while hidden.
async function want(c) {
  if (!visible() || !base || c.note || held.has(c.id) || loading.has(c.id) || missing.has(c.id)) return;
  loading.add(c.id);
  const blob = await fetch(base + `timeline/${c.id}.jpg`, { signal: AbortSignal.timeout(8000) }).then((r) => {
    if (r.ok) return r.blob();
    if (r.status === 404) missing.add(c.id); // gone: not asked again on every scroll
    return null;
  }).catch(() => null);
  loading.delete(c.id);
  const li = nodes.get(c.id);
  if (!blob || !li || !visible() || held.has(c.id)) return;
  const order = ordered();
  const [first, last] = range(order);
  const i = order.findIndex((x) => x.id === c.id);
  if (i < first - RELEASE_MARGIN || i > last + RELEASE_MARGIN) return;
  const url = URL.createObjectURL(blob);
  held.set(c.id, url);
  li.querySelector("img.thumb").src = url;
  countHeld();
}
function release(id) {
  const url = held.get(id);
  if (!url) return;
  held.delete(id);
  URL.revokeObjectURL(url);
  nodes.get(id)?.querySelector("img.thumb")?.removeAttribute("src");
  countHeld();
}
const releaseAll = () => { for (const id of [...held.keys()]) release(id); countHeld(); };

strip.addEventListener("scroll", () => { frame(); if (menuFor) closeMenu(false); if (!$("where").hidden) $("where").hidden = true; }, { passive: true });
window.addEventListener("resize", () => frame());

// ---- driving: the panel's definition (an action within DRIVING_MS) ----

function setDriver() {
  const driving = document.body.dataset.s === "live" && Date.now() - lastActivity < DRIVING_MS;
  document.body.dataset.driving = String(driving);
  const now = current();
  const pill = now && nodes.get(now)?.querySelector(".live-pill");
  if (pill) pill.hidden = !driving;
}
function scheduleDriver() {
  clearTimeout(driveTimer);
  driveTimer = 0;
  const left = lastActivity + DRIVING_MS - Date.now();
  if (left > 0 && visible()) driveTimer = setTimeout(() => { driveTimer = 0; setDriver(); }, left + 500);
}

// ---- the stream and the page's visibility ----

function start() {
  started = true;
  // The owner stream (panel=1 always, never a viewer), shared with the other pages (common.js).
  stream = helperStream(base, {
    kind: "timeline",
    onState: (s) => {
      if (s === "live") {
        document.body.dataset.s = "live";
        setDriver();
        if (stale && visible()) { stale = false; load(); }
        return;
      }
      // A drop (or a closed stream) makes the cards stale; the first "connecting" does not.
      if (document.body.dataset.s === "live" || s === "closed") stale = true;
      document.body.dataset.s = s;
      setDriver();
    },
  });
  const on = stream.on;
  on("timeline", apply);
  on("activity", (items) => {
    if (!Array.isArray(items)) return;
    const t = Math.max(0, ...items.map((a) => (Number.isFinite(a?.t) ? a.t : 0)));
    if (t <= lastActivity) return;
    lastActivity = t;
    setDriver();
    scheduleDriver();
  });
  load();
}

function connect(url) {
  if (!url || url === base) return;
  base = url;
  if (started) { stream?.close(); stream = null; started = false; }
  showLine("");
  if (visible()) start();
}

document.addEventListener("visibilitychange", () => {
  if (!visible()) {
    clearTimeout(driveTimer);
    driveTimer = 0;
    releaseAll();
    return;
  }
  if (!base) return;
  if (!started) return start();
  // A reload after a stream drop, or after a timeline.json that failed while the stream stayed up
  // (one GET per show of the strip, no poll).
  if (stale || document.body.dataset.state === "error") { stale = false; load(); }
  setDriver();
  scheduleDriver();
  frame();
});

// ---- cards: show, menu, keyboard ----

const cardOf = (target) => target?.closest?.("li.card:not(.add)") || null;
const faceOf = (li) => li?.querySelector(".face") || null;
const items = () => [...list.querySelectorAll("li.card:not(.add) .face")];
const stops = () => [...items(), addBtn];

function focusStop(target) {
  if (!target) return;
  if (target !== addBtn) {
    focusId = cardOf(target).dataset.id;
    for (const face of items()) {
      const on = face === target;
      face.tabIndex = on ? 0 : -1;
      cardOf(face).querySelector(".more").tabIndex = on ? 0 : -1;
    }
  }
  target.focus();
}

function show(id) {
  // A note has no picture to show (the helper answers 409): nothing to ask for.
  if (cards.find((c) => c.id === id)?.note === true) return;
  if (hasBubbles()) return togglePicture(id);
  // The helper's show route (the right dock shows the picture); a 404 from a helper without it is
  // silent and nothing is marked shown; another failure says so under the cards. The agent panel opens first when it is not (Part H).
  const pb = window.pairbrowse;
  if (pb) {
    pb.layout.get().then(({ state }) => {
      if (state && state.right !== pb.DockState.kOpen) return pb.layout.set({ ...state, right: pb.DockState.kOpen });
    }).catch(() => {});
  }
  if (base) post(base + `timeline/${id}/show`, {}).then((r) => { if (r.ok) setShown(id); else if (r.status !== 404) problem("Couldn't show it in the agent panel."); }).catch(() => problem("Couldn't reach PairBrowse."));
}
// The picture shows large in another part of the window (the agent panel) until 530's bubble can
// show it here: the card says so where it was clicked, a ring on it and a line under it, until
// another card is shown or the strip scrolls (DESIGN.md Part I). No timer.
function setShown(id) {
  for (const li of list.querySelectorAll('li.card[data-shown="true"]')) delete li.dataset.shown;
  shownId = id;
  const li = id && nodes.get(id);
  const note = $("where");
  if (!li) { note.hidden = true; return; }
  li.dataset.shown = "true";
  note.style.left = `${Math.round(li.getBoundingClientRect().left)}px`;
  note.hidden = false;
  say("Shown large in the agent panel");
}

// ---- the picture in the browser's bubble above its card (530 E1, E2 B3) ----
const pb = window.pairbrowse || null;
const hasBubbles = () => typeof pb?.bubbles?.open === "function";
const PICTURE_KIND = Number.isInteger(pb?.BubbleKind?.kPicture) ? pb.BubbleKind.kPicture : 2;
// A click outside closes the bubble before that click lands: on the same card's face it is that
// close, not a new open (OnClosed, not by Escape, this recently; a timestamp, no timer).
const REOPEN_MS = 400;
let pictureOpen = null; // the card whose picture the bubble shows
let lastClosed = { id: null, at: -Infinity };
let staleCloses = 0; // a bubble replaced by another: its OnClosed still comes, once
let selfClosed = false; // closed by this page (a second click on its card): no guard then
let observing = false;
function observePicture() {
  if (observing) return;
  observing = true;
  pb.bubbles.addObserver({
    onClosed: (kind, byEscape) => {
      if (kind !== PICTURE_KIND) return;
      if (staleCloses > 0) { staleCloses--; return; }
      const id = pictureOpen;
      pictureOpen = null;
      if (id) nodes.get(id)?.querySelector(".face")?.setAttribute("aria-expanded", "false");
      const mine = selfClosed;
      selfClosed = false;
      if (!byEscape) { if (!mine) lastClosed = { id, at: performance.now() }; return; }
      // Escape, the bubble's x or a delete there: the focus comes back to the card (or, deleted, the next).
      const face = faceOf(nodes.get(id));
      if (face) focusStop(face);
      else focusStop(items()[0] || addBtn);
    },
  });
}
// The face's box in this page's CSS pixels, rounded outward and kept inside the page.
function anchorRect(node) {
  const r = node.getBoundingClientRect();
  const x = Math.max(0, Math.floor(r.left)), y = Math.max(0, Math.floor(r.top));
  const right = Math.min(window.innerWidth, Math.ceil(r.right)), bottom = Math.min(window.innerHeight, Math.ceil(r.bottom));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}
async function togglePicture(id) {
  observePicture();
  if (pictureOpen === id) { closePicture(); return; }
  if (lastClosed.id === id && performance.now() - lastClosed.at < REOPEN_MS) return;
  const face = faceOf(nodes.get(id));
  if (!face) return;
  if (pictureOpen) { nodes.get(pictureOpen)?.querySelector(".face")?.setAttribute("aria-expanded", "false"); staleCloses++; }
  pictureOpen = id;
  face.setAttribute("aria-expanded", "true");
  let shown = false;
  try { ({ shown } = await pb.bubbles.open(PICTURE_KIND, anchorRect(face), id)); } catch {}
  if (!shown && pictureOpen === id) { pictureOpen = null; face.setAttribute("aria-expanded", "false"); }
}
function closePicture() {
  if (!pictureOpen) return;
  selfClosed = true;
  pb.bubbles.close(PICTURE_KIND).catch(() => {});
}

list.addEventListener("click", (e) => {
  const li = cardOf(e.target);
  if (!li) return;
  const more = e.target.closest(".more");
  if (more) { e.stopPropagation(); return menuFor === li.dataset.id ? closeMenu(true) : openMenu(li, false); }
  focusStop(faceOf(li));
  show(li.dataset.id);
});

list.addEventListener("focusin", (e) => { const li = cardOf(e.target); if (li && e.target === faceOf(li) && focusId !== li.dataset.id) focusStop(e.target); });

list.addEventListener("keydown", (e) => {
  const li = cardOf(e.target);
  const onCard = li && e.target === faceOf(li);
  const onAdd = e.target === addBtn;
  if (!onCard && !onAdd) return;
  const all = stops();
  const at = all.indexOf(e.target);
  let to = null;
  if (e.key === "ArrowRight") to = all[Math.min(all.length - 1, at + 1)];
  else if (e.key === "ArrowLeft") to = all[Math.max(0, at - 1)];
  else if (e.key === "Home") to = all[0];
  else if (e.key === "End") to = all.at(-1);
  if (to) { e.preventDefault(); focusStop(to); return; }
  if (!onCard) return;
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); show(li.dataset.id); }
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); openMenu(li, true); }
  else if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") { e.preventDefault(); openMenu(li, false); }
});

const outside = (e) => { if (!menu.contains(e.target) && !e.target.closest?.(".more")) closeMenu(false); };

function openMenu(li, confirm) {
  const card = cards.find((c) => c.id === li.dataset.id);
  if (!card) return;
  if (menuFor && menuFor !== card.id) closeMenu(false);
  menuFor = card.id;
  li.querySelector(".more").setAttribute("aria-expanded", "true");
  menu.inert = false;
  menu.hidden = false;
  document.addEventListener("pointerdown", outside, true);
  fillMenu(card, confirm);
}

function menuItem(text, fn, danger = false) {
  const b = el("button", { type: "button", textContent: text, tabIndex: -1, className: danger ? "danger" : "" });
  b.setAttribute("role", "menuitem");
  b.addEventListener("click", fn);
  return b;
}

function fillMenu(card, confirm) {
  const ask = card.note ? "Delete this note?" : "Delete this picture?";
  // The menu's name is the question while it asks, and both answers point at it.
  menu.setAttribute("aria-label", confirm ? ask : "Card menu");
  if (confirm) {
    const answers = [menuItem("Delete", () => del(card), true), menuItem("Keep", () => closeMenu(true))];
    for (const b of answers) b.setAttribute("aria-describedby", "ask");
    const q = el("p", { className: "ask", id: "ask", textContent: ask });
    q.setAttribute("role", "presentation"); // a menu holds only items; describedby still reads it
    menu.replaceChildren(q, ...answers);
  } else {
    menu.replaceChildren(menuItem(card.pinned ? "Unpin" : "Pin", () => pin(card)), menuItem("Delete", () => fillMenu(card, true), true));
  }
  place(nodes.get(card.id)); // before focus, which would otherwise scroll the menu into view
  const first = menu.querySelector('[role="menuitem"]');
  first.tabIndex = 0;
  first.focus({ preventScroll: true });
}

// Under the card's More button, kept inside the window.
function place(li) {
  if (!li) return;
  const b = li.querySelector(".more").getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = `${Math.max(4, Math.min(b.right - w, window.innerWidth - w - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(b.bottom + 4, window.innerHeight - h - 4))}px`;
}

function closeMenu(refocus) {
  const id = menuFor;
  menuFor = null;
  // The items stay for the 160 ms fade (the next open replaces them); inert keeps them out of reach.
  menu.hidden = true;
  menu.inert = true;
  menu.setAttribute("aria-label", "Card menu");
  document.removeEventListener("pointerdown", outside, true);
  const li = id && nodes.get(id);
  li?.querySelector(".more").setAttribute("aria-expanded", "false");
  if (refocus && li) focusStop(faceOf(li));
}

menu.addEventListener("keydown", (e) => {
  const all = [...menu.querySelectorAll('[role="menuitem"]')];
  const at = all.indexOf(document.activeElement);
  let to = null;
  if (e.key === "ArrowDown") to = all[(at + 1) % all.length];
  else if (e.key === "ArrowUp") to = all[(at - 1 + all.length) % all.length];
  else if (e.key === "Home") to = all[0];
  else if (e.key === "End") to = all.at(-1);
  else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); closeMenu(true); return; }
  if (to) { e.preventDefault(); for (const b of all) b.tabIndex = b === to ? 0 : -1; to.focus(); }
});

// The menu item pressed says busy while its request is out (tokens.css draws the bar after 300 ms).
const pressed = () => (menu.contains(document.activeElement) ? document.activeElement : null);
async function pin(card) {
  const r = await busy(pressed(), () => post(base + `timeline/${card.id}/pin`, { on: !card.pinned }).catch(() => null));
  const body = await r?.json().catch(() => null);
  const next = r?.ok ? valid(body) : null;
  closeMenu(true);
  if (!next) return problem(body?.error || "Couldn't reach PairBrowse.");
  replace(next);
  say(next.pinned ? "Pinned" : "Unpinned");
}

async function del(card) {
  const i = items().indexOf(faceOf(nodes.get(card.id))); // its place on screen
  const r = await busy(pressed(), () => fetch(base + `timeline/${card.id}`, { method: "DELETE" }).catch(() => null));
  closeMenu(false);
  if (!r?.ok) {
    const body = await r?.json().catch(() => null);
    problem(body?.error || "Couldn't delete it.");
    return focusStop(faceOf(nodes.get(card.id)));
  }
  remove(card.id); // unless the stream's remove came first
  say("Deleted");
  const all = items();
  focusStop(all[Math.min(i, all.length - 1)] || addBtn);
}

// An error a route replied: in the strip's status line until the next success, out of the scrolling
// flow so it shows wherever the strip is scrolled.
function problem(text) {
  showLine(text);
  $("line").classList.add("toast");
}

// ---- Add note ----

function openNote() {
  addBtn.hidden = true;
  form.hidden = false;
  note.value = "";
  note.focus();
}
function closeNote() {
  form.hidden = true;
  addBtn.hidden = false;
  note.value = "";
  addBtn.focus();
}
addBtn.addEventListener("click", openNote);
form.addEventListener("submit", (e) => e.preventDefault());
note.addEventListener("keydown", async (e) => {
  if (e.key === "Escape") { e.preventDefault(); return closeNote(); }
  // Enter that ends an input method's composition (Japanese, Chinese...) picks the words; it posts nothing.
  if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  const text = note.value.trim();
  if (!text || !base) return closeNote();
  note.disabled = true;
  const r = await post(base + "timeline/note", { text }).catch(() => null);
  const body = await r?.json().catch(() => null);
  note.disabled = false;
  const card = r?.ok ? valid(body) : null;
  closeNote();
  if (!card) return problem(body?.error || "Couldn't reach PairBrowse.");
  if (cards.length === 0) showLine("");
  add(card); // once: the stream's add may have come first
  say("Note added");
});

// ---- where the helper is ----

// No helper to ask (the browser has no helper address, or neither the browser API nor the
// extension's storage is there, or it has no address yet): the right dock's words, the resting
// state; an address that arrives later connects (storage.onChanged below).
const NO_HELPER = "No agent connected";
// No stream to wait for: the page says so in body[data-s] too (as the docks do), not "connecting".
const noHelper = () => { document.body.dataset.s = "none"; showLine(NO_HELPER); };
if (PICTURE) {
  // The picture bubble's page: only the browser opens it (its own host, its API).
  pictureMode();
} else if (window.pairbrowse) {
  // The browser build: the helper's address from the browser itself.
  window.pairbrowse.session.helper().then(({ origin, key } = {}) => {
    if (origin && key) connect(`${origin}/${key}/`);
    else noHelper();
  }).catch(noHelper);
} else {
  // The extension: the address the daemon handed to background.js, as the side panel reads it.
  let area = null;
  try { area = globalThis.chrome?.storage?.session || null; } catch {}
  if (!area) noHelper();
  else area.get("view").then(({ view }) => (view ? connect(view) : noHelper())).catch(noHelper);
  try { globalThis.chrome?.storage?.onChanged?.addListener((changes, a) => { if (a === "session" && changes.view) connect(changes.view.newValue); }); } catch {}
}

// ---- #picture=<id>: the picture large in the browser's bubble (530 E2 B3) ----
// The card from timeline.json and its picture, its time and caption (also the page's title, which
// names the bubble to a screen reader), Pin and Delete (asked first), the x. The owner stream's
// timeline events keep it current; its card deleted, the bubble closes. Escape is the browser's.
// The focus starts on the x.
async function pictureMode() {
  const close = () => { if (hasBubbles()) pb.bubbles.close(PICTURE_KIND).catch(() => {}); };
  const msg = (text) => { $("pic-msg").textContent = text; };
  let pbase = null, card = null, blobUrl = null, picStream = null;
  $("pic-close").addEventListener("click", close);
  $("pic-close").focus();
  const draw = (c) => {
    card = c;
    $("pic-time").textContent = shortClock(c.t);
    $("pic-cap").textContent = c.caption || "Picture";
    document.title = `${shortClock(c.t)}, ${c.caption || "Picture"}`;
    $("pic-pin").textContent = c.pinned ? "Unpin" : "Pin";
  };
  const ask = (on) => {
    $("pic-ask").hidden = !on;
    $("pic-actions").hidden = on;
    (on ? $("pic-no") : $("pic-delete")).focus();
  };
  $("pic-pin").addEventListener("click", async () => {
    if (!card || !pbase) return;
    const r = await busy($("pic-pin"), () => post(pbase + `timeline/${card.id}/pin`, { on: !card.pinned }).catch(() => null));
    const body = await r?.json().catch(() => null);
    const next = r?.ok ? valid(body) : null;
    if (!next) return msg(body?.error || "Couldn't reach PairBrowse.");
    msg("");
    draw(next);
  });
  $("pic-delete").addEventListener("click", () => ask(true));
  $("pic-no").addEventListener("click", () => ask(false));
  $("pic-yes").addEventListener("click", async () => {
    if (!card || !pbase) return;
    const r = await busy($("pic-yes"), () => fetch(pbase + `timeline/${card.id}`, { method: "DELETE" }).catch(() => null));
    if (!r?.ok) { const body = await r?.json().catch(() => null); ask(false); return msg(body?.error || "Couldn't delete it."); }
    close();
  });
  let helper = null;
  try { helper = await pb?.session.helper(); } catch {}
  if (!helper?.origin || !helper?.key) return msg(NO_HELPER);
  pbase = `${helper.origin}/${helper.key}/`;
  const r = await fetch(pbase + "timeline.json", { signal: AbortSignal.timeout(8000) }).catch(() => null);
  const body = r?.ok ? await r.json().catch(() => null) : null;
  const found = Array.isArray(body?.cards) ? body.cards.map(valid).find((c) => c?.id === PICTURE) : null;
  if (!found) return msg("This picture is gone.");
  draw(found);
  picStream = helperStream(pbase, { kind: "timeline" });
  picStream.on("timeline", (ev) => {
    const c = valid(ev?.card);
    if (!c || c.id !== PICTURE) return;
    if (ev.op === "remove") close();
    else if (ev.op === "pin") draw(c);
  });
  const pic = await fetch(pbase + `timeline/${PICTURE}.jpg`, { signal: AbortSignal.timeout(8000) }).then((x) => (x.ok ? x.blob() : null)).catch(() => null);
  if (!pic) return msg("The picture is not kept any more.");
  blobUrl = URL.createObjectURL(pic);
  $("pic-img").alt = found.caption || "Picture";
  $("pic-img").src = blobUrl;
  window.addEventListener("pagehide", () => { if (blobUrl) URL.revokeObjectURL(blobUrl); picStream?.close(); }, { once: true });
}
