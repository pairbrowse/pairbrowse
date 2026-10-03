// The live view page: the browser's tabs and the shown page, with your clicks, scrolling and
// typing sent back. Served by liveview.mjs under the page's key, with no inline code allowed.
// body data-role is "owner" (your own link), "drive" or "watch" (invite links): the server
// enforces it; this only keeps refused controls out of sight.
import { $, el, rich, clock, activityHead, sparkIcon, joinBanners, profilePanel, whose } from "./common.js";

const base = location.pathname.replace(/\/?$/, "/");
const img = $("screen"), stage = $("stage");
const role = document.body.dataset.role || "owner";
const canDrive = role !== "watch";
// Only the host resizes the page: an invited viewer's pane never changes it.
const mayResize = role === "owner";
if (!canDrive) { stage.setAttribute("aria-label", "Live view of the PairBrowse browser (watch only)"); $("url-input").disabled = true; }

const YOU_DRIVE_MS = 3000; // "You're driving" after your last input
const FIT_DEBOUNCE_MS = 200;
const ACTIVITY_SHOWN = 4;
const CLICK_NEAR_PX = 5, CLICK_GAP_MS = 500; // double and triple clicks
let frame = { w: 1, h: 1 };
let turn = false;
let gotFrame = false;

// ---- state ----
const STATE_LABELS = { connecting: "Connecting", live: "Live", reconnecting: "Reconnecting", closed: "Browser closed" };
function setState(s) {
  const yours = turn && s === "live";
  $("state").dataset.s = yours ? "you" : s;
  $("state-text").textContent = yours ? "Your turn" : STATE_LABELS[s];
  document.body.dataset.s = s;
  $("overlay-title").textContent = s === "closed" ? "The PairBrowse browser closed" : "Reconnecting";
  $("overlay-text").textContent = s === "closed" ? "It reopens on Claude's next action." : "Waiting for PairBrowse";
}

let youTimer = 0;
let agentName = "Claude"; // the agent that acted last, named as the page's bottom bar names it
function setDriver(who) {
  $("driver").dataset.who = who;
  $("driver-who").textContent = who === "you" ? "You're" : agentName;
  $("driver").lastChild.textContent = who === "you" ? " driving" : " is driving";
}
function youDrive() {
  setDriver("you");
  clearTimeout(youTimer);
  youTimer = setTimeout(() => setDriver("claude"), YOU_DRIVE_MS);
}

// ---- address bar: show the real host prominently ----
let currentUrl = "";
function setUrl(raw) {
  currentUrl = raw || "";
  const text = $("url-text");
  text.replaceChildren();
  let u;
  try { u = new URL(raw); } catch { text.textContent = raw || ""; return; }
  const secure = u.protocol === "https:";
  $("url").dataset.secure = String(secure || u.protocol === "about:");
  $("lock").setAttribute("aria-label", secure ? "Secure connection" : "Not secure");
  if (u.protocol === "about:") { text.textContent = raw; return; }
  text.append(el("span", { textContent: secure ? "" : u.protocol + "//" }), el("span", { className: "host", textContent: u.host }), el("span", { textContent: (u.pathname === "/" ? "" : u.pathname) + u.search }));
  text.title = raw;
}

// ---- network ----
let chain = Promise.resolve();
const post = (route, body) => !canDrive ? chain : (chain = chain.then(() => fetch(base + route, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}).catch(() => {})));

// Fit the whole page in the pane, like a monitor. With "Fit to pane" on, the page itself is
// rendered at the pane's size, so it stays readable in a narrow pane.
let fitOn = true;
try { fitOn = localStorage.getItem("pb-fit") !== "off"; } catch {}
let fitTimer = 0;
const sendViewport = () => mayResize ? post("input", { type: "viewport", on: fitOn, w: stage.clientWidth, h: stage.clientHeight, dpr: window.devicePixelRatio || 1 }) : chain;
// The page image fills the pane as far as it can without cropping (contain), centered. Sized
// here, not with object-fit, so the image's box is exactly the page and clicks map 1:1.
function sizeImage() {
  const sw = stage.clientWidth, sh = stage.clientHeight;
  if (!sw || !sh || frame.w < 2 || frame.h < 2) return;
  const scale = Math.min(sw / frame.w, sh / frame.h);
  img.style.width = Math.floor(frame.w * scale) + "px";
  img.style.height = Math.floor(frame.h * scale) + "px";
}
const fit = () => {
  document.documentElement.style.setProperty("--fit-h", Math.max(120, stage.clientHeight) + "px");
  sizeImage();
  clearTimeout(fitTimer);
  fitTimer = setTimeout(sendViewport, FIT_DEBOUNCE_MS);
};
new ResizeObserver(fit).observe(stage);
const fitBtn = $("fit");
fitBtn.setAttribute("aria-pressed", String(fitOn));
fitBtn.addEventListener("click", () => {
  fitOn = !fitOn;
  fitBtn.setAttribute("aria-pressed", String(fitOn));
  try { localStorage.setItem("pb-fit", fitOn ? "on" : "off"); } catch {}
  sendViewport();
});

const es = new EventSource(base + "events");
const on = (event, fn) => es.addEventListener(event, (e) => fn(JSON.parse(e.data)));
es.onopen = () => { setState("live"); fit(); };
es.onerror = () => setState(es.readyState === EventSource.CLOSED ? "closed" : "reconnecting");

on("frame", (f) => {
  const resized = f.w !== frame.w || f.h !== frame.h;
  frame = f;
  if (resized) sizeImage();
  img.src = `data:image/${frame.type === "png" ? "png" : "jpeg"};base64,` + frame.img;
  if (!gotFrame) { gotFrame = true; img.hidden = false; $("skeleton").remove(); img.alt = "Live page"; }
});

// An agent's spark color, only if it is a plain color value.
const agentColor = (c) => /^#[0-9a-f]{3,8}$|^(rgb|hsl|oklch)a?\([\d.,%\s/]+\)$/i.test(String(c || "")) ? c : "";
const tabName = (t) => t.title && t.title !== "about:blank" ? t.title : "New tab";

// ---- tab overview: who is in each tab ----
const overviewEl = $("overview"), overviewBtn = $("overview-btn");
let lastTabs = [];
function drawOverview() {
  if (overviewEl.hidden) return;
  overviewEl.replaceChildren(...(lastTabs.length ? lastTabs.map((t) => {
    const row = el("button", { type: "button", disabled: !canDrive, title: t.url || "" });
    if (t.shown) row.setAttribute("aria-current", "true");
    const who = el("span", { className: "who" });
    const color = t.agent ? agentColor(t.agent.color) : "";
    if (color) who.style.setProperty("--agent", color);
    if (t.waiting && t.person) { who.dataset.waiting = "true"; who.append(el("i"), `Paused: ${t.person} is using this tab`); }
    else if (t.agent) who.append(el("i"), t.agent.label || "An agent", ...(t.person ? [` · ${t.person} is here too`] : []));
    else if (t.person) who.append(el("i"), `${t.person} is using this tab`);
    else who.append(el("i"), "No agent");
    row.append(el("span", { className: "t", textContent: tabName(t) }), who);
    if (t.last?.text) row.append(el("span", { className: "last" }, ...(t.last.who ? [`${t.last.who}: `] : []), rich(t.last.text)));
    row.addEventListener("click", () => { if (canDrive) post("tab", { i: t.i }); });
    return el("li", {}, row);
  }) : [el("li", { className: "empty", textContent: "No tabs open." })]));
}
function openOverview(open) {
  overviewEl.hidden = !open;
  overviewBtn.setAttribute("aria-expanded", String(open));
  drawOverview();
}
overviewBtn.addEventListener("click", () => openOverview(overviewEl.hidden));
overviewEl.addEventListener("keydown", (e) => { if (e.key === "Escape") { openOverview(false); overviewBtn.focus(); } });
document.addEventListener("pointerdown", (e) => { if (!overviewEl.hidden && !overviewEl.contains(e.target) && !overviewBtn.contains(e.target)) openOverview(false); });

// ---- the tab strip ----
const CLOSE_PATH = "M3.3 3.3a1 1 0 0 1 1.4 0L8 6.6l3.3-3.3a1 1 0 1 1 1.4 1.4L9.4 8l3.3 3.3a1 1 0 0 1-1.4 1.4L8 9.4l-3.3 3.3a1 1 0 0 1-1.4-1.4L6.6 8 3.3 4.7a1 1 0 0 1 0-1.4Z";
function closeIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [k, v] of [["width", "10"], ["height", "10"], ["viewBox", "0 0 16 16"], ["aria-hidden", "true"]]) svg.setAttribute(k, v);
  const path = document.createElementNS(ns, "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", CLOSE_PATH);
  svg.append(path);
  return svg;
}
function tabChip(t) {
  const b = el("button", { className: "tab", title: t.agent?.label ? `${t.url}\n${t.agent.label}` : t.url });
  b.setAttribute("role", "tab");
  b.setAttribute("aria-selected", String(t.shown));
  b.dataset.claude = String(t.claude);
  const fav = t.icon ? el("img", { src: t.icon, alt: "" }) : el("i");
  fav.className = "fav";
  const close = el("span", { className: "close", title: "Close tab" }, closeIcon());
  close.setAttribute("role", "button");
  close.setAttribute("aria-label", "Close tab");
  close.onclick = (e) => { e.stopPropagation(); post("tab", { close: t.i }); };
  b.append(fav, el("span", { textContent: tabName(t) }));
  if (t.agent) {
    const dot = el("i", { className: "agent", title: t.agent.label || "" });
    const color = agentColor(t.agent.color);
    if (color) dot.style.setProperty("--agent", color);
    dot.setAttribute("aria-label", `${t.agent.label || "An agent"} is in this tab`);
    b.append(dot);
  }
  b.append(sparkIcon("claude", "Claude is working in this tab"), close);
  b.onclick = () => post("tab", { i: t.i });
  b.onauxclick = (e) => { if (e.button === 1) post("tab", { close: t.i }); };
  if (t.shown) setUrl(t.url);
  return b;
}
on("tabs", (tabs) => {
  lastTabs = Array.isArray(tabs) ? tabs : [];
  drawOverview();
  $("tabs").replaceChildren(...lastTabs.map(tabChip));
  $("tabs").querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
});

on("status", (s) => {
  turn = s.kind === "you" && !!s.text;
  document.body.dataset.turn = String(turn);
  $("turn").dataset.open = String(turn);
  $("turn-text").textContent = s.text || "Your turn";
  setState(document.body.dataset.s === "connecting" ? "live" : document.body.dataset.s);
  if (turn) stage.focus({ preventScroll: true });
});

on("session", (s) => {
  if (!s.name) return;
  const where = $("where");
  where.hidden = false;
  where.dataset.clean = String(!!s.temporary);
  $("where-text").replaceChildren(document.createTextNode(`${s.where} · `), el("b", { textContent: s.name }));
  where.title = `${s.where} browser session: ${s.name}`;
});

// ---- who is here: a count chip, with everyone named in its tooltip ----
let collaborationState = { participants: [], owner: null, active: null, humanUntil: 0 };
function renderCollaboration(next) {
  collaborationState = next || collaborationState;
  const c = collaborationState;
  const people = Array.isArray(c.participants) ? c.participants : [];
  const guests = Array.isArray(c.guests) ? c.guests : [];
  // Everyone once: a guest whose agent acts is a participant too.
  const names = new Set([...people.map((p) => p?.label || p?.id), ...guests.map((g) => g?.label)].filter(Boolean));
  const count = names.size;
  const left = Math.ceil((Number(c.humanUntil) - Date.now()) / 1000);
  const owner = Number(c.owner?.expiresAt) > Date.now() ? c.owner.label || c.owner.id : null;
  const active = c.active?.label || c.active?.id;
  const lines = [`${count} ${count === 1 ? "person" : "people"} here`];
  for (const p of people) if (p?.label || p?.id) lines.push(`  ${p.label || p.id}`);
  for (const g of guests) lines.push(`  ${g.label} (guest, ${g.role === "drive" ? "can drive" : "watching"})`);
  if (owner) lines.push(`Owner: ${owner}`);
  if (active) lines.push(`Acting now: ${active}`);
  if (left > 0) lines.push(`A person has control: agents wait ${left}s`);
  const chip = $("collaboration-status");
  chip.hidden = count < 2 && left <= 0;
  $("people-count").textContent = String(count);
  $("people-hold").hidden = left <= 0;
  $("people-hold").textContent = left > 0 ? `${left}s` : "";
  chip.dataset.hold = String(left > 0);
  chip.title = lines.join("\n");
  chip.setAttribute("aria-label", lines.join(", ").replace(/\s+/g, " "));
}
on("collaboration", renderCollaboration);
// The countdowns tick.
setInterval(() => { if (collaborationState.humanUntil || collaborationState.owner) renderCollaboration(collaborationState); }, 1000);

// ---- activity, with who did it and in which tab (the filter is kept in memory only) ----
let allActivity = [];
let whoFilter = "";
const seenWho = new Set();
const filterEl = $("who-filter");
function drawActivity() {
  const items = allActivity.filter((a) => !whoFilter || a.who === whoFilter).slice(-ACTIVITY_SHOWN).reverse();
  if (!items.length) {
    if (whoFilter) $("activity").replaceChildren(el("li", { className: "empty", textContent: `Nothing from ${whoFilter} yet.` }));
    return;
  }
  $("activity").replaceChildren(...items.map((a) => el("li", {}, el("time", { textContent: clock(a.t) }), ...(activityHead(a) ? [el("strong", { textContent: `${activityHead(a)}: ` })] : []), rich(a.text))));
}
filterEl.addEventListener("change", () => { whoFilter = filterEl.value; drawActivity(); });
on("activity", (list) => {
  allActivity = Array.isArray(list) ? list : [];
  const lastAgent = allActivity.findLast((a) => a.who && !/\(by hand\)$/.test(a.who));
  agentName = whose(lastAgent?.who);
  if ($("driver").dataset.who !== "you") setDriver("claude");
  let added = false;
  for (const a of allActivity) if (a.who && !seenWho.has(a.who)) { seenWho.add(a.who); added = true; }
  if (added) {
    filterEl.replaceChildren(el("option", { value: "", textContent: "Everyone" }), ...[...seenWho].sort().map((w) => el("option", { value: w, textContent: w })));
    filterEl.value = whoFilter;
    filterEl.hidden = false;
  }
  drawActivity();
});

// ---- join requests (the host only) ----
if (role === "owner") on("join", joinBanners($("joins"), () => base));

// ---- Profile: remembered details and passwords (your own link only) ----
if (role === "owner") {
  const drawerEl = $("drawer"), profileBtn = $("profile-btn");
  const profile = profilePanel(() => base);
  async function openProfile(open) {
    drawerEl.dataset.open = String(open);
    profileBtn.setAttribute("aria-expanded", String(open));
    if (!open) return;
    if (!await profile.load()) profile.say("Couldn't reach PairBrowse.", "error");
    // Don't pull the cursor away from a field the person already clicked into.
    if (!drawerEl.contains(document.activeElement)) drawerEl.querySelector("input")?.focus({ preventScroll: true });
  }
  profileBtn.addEventListener("click", () => openProfile(drawerEl.dataset.open !== "true"));
  $("drawer-close").addEventListener("click", () => openProfile(false));
  drawerEl.addEventListener("keydown", (e) => { if (e.key === "Escape") openProfile(false); });
  on("profile", (p) => { if (drawerEl.dataset.open === "true") profile.draw(p); });
}

// ---- toolbar ----
for (const action of ["back", "forward", "reload"]) $(action).addEventListener("click", () => { youDrive(); post("input", { type: "nav", action }); });

// Address bar: shows the host prominently; click it to type an address or a search.
const urlBox = $("url"), urlText = $("url-text"), urlInput = $("url-input");
const editUrl = (value) => {
  urlText.hidden = true;
  urlInput.hidden = false;
  urlInput.value = value ?? (currentUrl === "about:blank" ? "" : currentUrl);
  urlInput.focus();
  urlInput.select();
};
const endEdit = () => { urlInput.hidden = true; urlText.hidden = false; };
urlBox.addEventListener("mousedown", (e) => { if (canDrive && urlInput.hidden) { e.preventDefault(); editUrl(); } });
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && urlInput.value.trim()) {
    e.preventDefault();
    youDrive();
    post("input", { type: "nav", action: "go", url: urlInput.value });
    endEdit();
    stage.focus({ preventScroll: true });
  } else if (e.key === "Escape") { e.preventDefault(); endEdit(); stage.focus({ preventScroll: true }); }
});
urlInput.addEventListener("blur", endEdit);
$("newtab").addEventListener("click", () => { youDrive(); post("tab", { new: true }); editUrl(""); });
// Browser shortcuts: Cmd/Ctrl+L (address), Cmd/Ctrl+T (new tab).
document.addEventListener("keydown", (e) => {
  if (!canDrive || !(e.metaKey || e.ctrlKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "l") { e.preventDefault(); editUrl(); }
  else if (k === "t") { e.preventDefault(); $("newtab").click(); }
});

// ---- input ----
// Coordinates on the real page. Clamped, so a drag that leaves the view ends at the edge.
const point = (e) => {
  const r = img.getBoundingClientRect();
  const x = (e.clientX - r.left) * (frame.w / r.width);
  const y = (e.clientY - r.top) * (frame.h / r.height);
  return { x: Math.round(Math.min(frame.w - 1, Math.max(0, x))), y: Math.round(Math.min(frame.h - 1, Math.max(0, y))) };
};
const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const btn = (b) => ["left", "middle", "right"][b] || "none";
const BUTTONS = { left: 1, right: 2, middle: 4 };

// Input goes out in order, batched once per frame, so drags follow your hand closely.
let pending = [];
let raf = 0;
const flush = () => { raf = 0; if (pending.length) { const batch = pending; pending = []; post("input", batch); } };
const queue = (ev, now = false) => {
  const last = pending[pending.length - 1];
  // Only the newest position per frame matters for plain hover moves; trackpad scrolls add up.
  if (last && ev.action === "mouseMoved" && last.action === "mouseMoved" && !ev.buttons && !last.buttons) pending[pending.length - 1] = ev;
  else if (last && ev.type === "wheel" && last.type === "wheel") pending[pending.length - 1] = { ...ev, dx: last.dx + ev.dx, dy: last.dy + ev.dy };
  else pending.push(ev);
  if (now) { cancelAnimationFrame(raf); flush(); } else if (!raf) raf = requestAnimationFrame(flush);
};

let down = null; // { id, type, button, count }
// Pointer events don't carry click counts, so count double and triple clicks here.
let lastDown = { t: 0, x: 0, y: 0, count: 0 };
const clickCount = (e) => {
  const near = Math.abs(e.clientX - lastDown.x) < CLICK_NEAR_PX && Math.abs(e.clientY - lastDown.y) < CLICK_NEAR_PX;
  const count = near && e.timeStamp - lastDown.t < CLICK_GAP_MS ? Math.min(lastDown.count + 1, 3) : 1;
  lastDown = { t: e.timeStamp, x: e.clientX, y: e.clientY, count };
  return count;
};
img.addEventListener("pointerdown", (e) => {
  if (down || !canDrive) return;
  e.preventDefault();
  stage.focus({ preventScroll: true });
  youDrive();
  img.setPointerCapture(e.pointerId);
  if (e.pointerType === "touch") {
    down = { id: e.pointerId, type: "touch" };
    return queue({ type: "touch", action: "touchStart", ...point(e) }, true);
  }
  const button = btn(e.button);
  down = { id: e.pointerId, type: "mouse", button, count: clickCount(e) };
  queue({ type: "mouse", action: "mousePressed", ...point(e), button, buttons: BUTTONS[button] || 1, clickCount: down.count, modifiers: mods(e) }, true);
});
img.addEventListener("pointermove", (e) => {
  if (down && e.pointerId !== down.id) return;
  if (down?.type === "touch") return queue({ type: "touch", action: "touchMove", ...point(e) });
  // Every intermediate position while a button is held (slider handles, drawing, drag and drop).
  const moves = down && e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const m of moves.length ? moves : [e]) {
    queue({ type: "mouse", action: "mouseMoved", ...point(m), button: down ? down.button : "none", buttons: down ? BUTTONS[down.button] || 1 : 0, modifiers: mods(e) });
  }
});
const release = (e) => {
  if (!down || e.pointerId !== down.id) return;
  if (down.type === "touch") queue({ type: "touch", action: e.type === "pointercancel" ? "touchCancel" : "touchEnd" }, true);
  else queue({ type: "mouse", action: "mouseReleased", ...point(e), button: down.button, buttons: 0, clickCount: down.count, modifiers: mods(e) }, true);
  down = null;
  if (img.hasPointerCapture(e.pointerId)) img.releasePointerCapture(e.pointerId);
};
img.addEventListener("pointerup", release);
img.addEventListener("pointercancel", release);
img.addEventListener("lostpointercapture", release);
img.addEventListener("contextmenu", (e) => e.preventDefault());
img.addEventListener("dragstart", (e) => e.preventDefault());
img.addEventListener("wheel", (e) => { e.preventDefault(); queue({ type: "wheel", ...point(e), dx: e.deltaX, dy: e.deltaY }); }, { passive: false });

const SPECIAL = new Set(["Backspace", "Tab", "Enter", "Escape", "PageUp", "PageDown", "End", "Home", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Delete"]);
stage.addEventListener("keydown", (e) => {
  if (!canDrive) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") return;
  if ((e.metaKey || e.ctrlKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    const command = k === "a" ? "selectAll" : k === "x" ? "cut" : k === "y" || (k === "z" && e.shiftKey) ? "redo" : k === "z" ? "undo" : null;
    if (command) { e.preventDefault(); youDrive(); queue({ type: "command", command, modifiers: mods(e) }, true); }
    return;
  }
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); youDrive(); queue({ type: "text", text: e.key }, true); }
  else if (SPECIAL.has(e.key)) { e.preventDefault(); youDrive(); queue({ type: "key", key: e.key, modifiers: mods(e) }, true); }
});
stage.addEventListener("paste", (e) => {
  const text = e.clipboardData?.getData("text/plain");
  if (text) { e.preventDefault(); youDrive(); queue({ type: "text", text }, true); }
});
