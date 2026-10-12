// The session timeline (DESIGN.md B7): the pictures the helper sent to agents, the current picture
// first, then the history oldest to newest, then Add note, from the helper's owner routes (timeline.json, timeline/<id>.jpg, DELETE timeline/<id>,
// POST timeline/note and timeline/<id>/pin) and the owner stream's `timeline` event. The page only
// renders: it never writes layout or toggles itself. Nothing runs before the page is first
// visible; while hidden it fetches nothing and holds no picture.
import { $, el, shortClock, helperStream } from "../common.js";

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
  if (!body || !Array.isArray(body.cards)) {
    document.body.dataset.state = "error";
    addLi.hidden = true;
    showLine("Couldn't reach PairBrowse.");
    return;
  }
  const seen = new Set();
  cards = body.cards.map(valid).filter((c) => c && !seen.has(c.id) && seen.add(c.id));
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
  const had = list.contains(document.activeElement) ? document.activeElement : null;
  for (const li of [...list.children]) if (li !== addLi && !items.includes(li)) li.remove();
  items.forEach((li, i) => { const at = list.children[i]; if (at !== li) list.insertBefore(li, at); });
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

strip.addEventListener("scroll", () => { frame(); if (menuFor) closeMenu(false); }, { passive: true });
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
  // The helper's show route (the right dock shows the picture); a 404 from a helper without it is
  // silent and nothing is marked shown.
  if (base) post(base + `timeline/${id}/show`, {}).catch(() => {});
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

async function pin(card) {
  const r = await post(base + `timeline/${card.id}/pin`, { on: !card.pinned }).catch(() => null);
  const body = await r?.json().catch(() => null);
  const next = r?.ok ? valid(body) : null;
  closeMenu(true);
  if (!next) return problem(body?.error || "Couldn't reach PairBrowse.");
  replace(next);
  say(next.pinned ? "Pinned" : "Unpinned");
}

async function del(card) {
  const i = items().indexOf(faceOf(nodes.get(card.id))); // its place on screen
  const r = await fetch(base + `timeline/${card.id}`, { method: "DELETE" }).catch(() => null);
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
  if (e.key !== "Enter") return;
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

if (window.pairbrowse) {
  // The browser build: the helper's address from the browser itself.
  window.pairbrowse.session.helper().then(({ origin, key } = {}) => {
    if (origin && key) connect(`${origin}/${key}/`);
    else showLine("Waiting for PairBrowse");
  }).catch(() => showLine("Waiting for PairBrowse"));
} else {
  // The extension: the address the daemon handed to background.js, as the side panel reads it.
  let area = null;
  try { area = globalThis.chrome?.storage?.session || null; } catch {}
  if (!area) showLine("Waiting for PairBrowse");
  else area.get("view").then(({ view }) => (view ? connect(view) : showLine("Waiting for PairBrowse"))).catch(() => showLine("Waiting for PairBrowse"));
  try { globalThis.chrome?.storage?.onChanged?.addListener((changes, a) => { if (a === "session" && changes.view) connect(changes.view.newValue); }); } catch {}
}
