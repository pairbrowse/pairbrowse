// The hand-off viewer (spec server-mode B8), phone first: what a person who took over a tab from a
// hand-off link sees and does. liveview.js loads it for role "turn" alone and keeps the shared
// parts (the stream, the picture and its size, the end of the hand-off); this adds the header (the
// step, its site, the time left, the connection, Done, the hand-off's tabs and "That tab isn't on
// screen"), touch (a tap clicks, a drag scrolls, a hold stays pressed), zoom kept on the phone
// (pinch, + and -: the page's own size never changes mid-step), the type box that opens the
// phone's keyboard, the one input queue, and "Fill saved card" in a session with a saved card
// (spec server-mode B12: the helper sends the person's own ArrowDown and Enter into the focused
// card number field, so the browser's autofill picks the card), and the option list: an open select
// list is the browser's own popup and never in the picture, so after a tap the viewer asks for the
// focused select's options, lists them over the picture, and the helper sends the choice as the
// person's own keys (liveview/options.mjs). Zoomed in, it reports the part of the tab on screen,
// and the helper sends a sharper still of that part once the page settles (liveview/zoomstill.mjs),
// drawn over it until the next moving frame. The helper checks every event again
// (liveview/input.mjs readViewerInput); this only shapes what a person's hands do.
import { $, el } from "./common.js";
import { createZoom } from "./liveview-zoom.js";

const ACTION_WORDS = { login: "Sign in", captcha: "Verification", "2fa": "2FA code", payment: "Payment", other: "Your step" };
const STATE_WORDS = { connecting: "Connecting", live: "Live", reconnecting: "Reconnecting", closed: "Ended" };
const DRAG_PX = 8; // a finger that travels further scrolls the page instead of clicking
// A finger that stays put this long presses, and holds until it lifts. Long enough for a pinch's
// second finger, which often lands a moment after the first: once a press is down two fingers no
// longer pinch (a press already down stays as it is), so at 200 ms most pinches never formed.
const HOLD_MS = 450;
const TAP_GAP_MS = 400, TAP_NEAR_PX = 16; // double and triple taps
const ZOOM_MIN = 1, ZOOM_MAX = 4, ZOOM_STEP = 1.5;
const TEXT_AT = 32; // a longer insert (a pasted or suggested phrase) goes as one text event
const BATCH_MAX = 200; // events in one POST (the helper takes 500)
const POST_MS = 10_000; // one request's bound
const RETRY_MS = 1000; // a POST that didn't arrive goes again after this
const STREAM_RETRY_MS = 2000; // the stream, refused while the helper still holds a dropped one
const LOW_MS = 2 * 60_000; // the time left turns red under this
const VIEW_MS = 250; // the part on screen is reported once zoom and pan rest this long
// Keys the type box passes on by name (a phone keyboard's Enter and Backspace; a hardware
// keyboard's arrows and Tab). Shift only: no shortcut ever leaves the box.
const NAMED = new Set(["Backspace", "Enter", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// The event stream over a WebSocket (liveview-socket.js), as liveview.js opens it for this viewer.
export { socketEvents } from "./liveview-socket.js";

// base: the viewer's /<viewKey>/; img, stage: the picture and its pane; on(event, fn): the stream's
// events (liveview.js, before the stream opens); frame(): the picture's
// { w, h } in page pixels; reopen(): opens the event stream again; end(): the hand-off is over.
// Returns { state(s) (the stream's: connecting, live, reconnecting, closed), lost() (the stream
// was refused: open it again, or end when the hand-off is gone) }.
export function startTurn({ base, img, stage, on, frame, reopen, end }) {
  const box = $("frame"); // what zoom scales: the picture and the pointers drawn over it
  let live = false, stopped = false;
  // Input goes out only while the stream is up and has sent its turn event: after a reconnect the
  // helper puts the picture back on the grant's tab first, then says so (input sent before that
  // would find no tab on screen and be refused).
  let ready = false;
  let info = null; // the last turn event

  // ---- the header ----
  const what = el("strong", { textContent: "Your turn" });
  const where = el("small", { className: "turn-site", id: "turn-site" });
  const left = el("time", { className: "turn-left", id: "turn-left" });
  const dot = el("i");
  const connText = el("span", { textContent: STATE_WORDS.connecting });
  const conn = el("span", { className: "turn-conn", id: "turn-conn" }, dot, connText);
  conn.dataset.s = "connecting";
  conn.setAttribute("role", "status");
  const done = el("button", { className: "primary turn-done", id: "turn-done", type: "button", textContent: "Done" });
  const tabs = el("select", { className: "field turn-tabs", id: "turn-tabs", hidden: true });
  tabs.setAttribute("aria-label", "The hand-off's tabs");
  const back = el("button", { className: "mini", id: "turn-back", type: "button", textContent: "Go back" });
  const away = el("p", { className: "turn-away", id: "turn-away", hidden: true }, el("span", { textContent: "That tab isn't on screen." }), back);
  away.setAttribute("role", "alert");
  const problem = el("p", { className: "turn-problem", id: "turn-problem", hidden: true });
  problem.setAttribute("role", "alert");
  const bar = el("header", { className: "turnbar", id: "turnbar" },
    el("div", { className: "turn-row" }, el("p", { className: "turn-step", id: "turn-step" }, what, el("span", { className: "sr", textContent: " · " }), where), el("span", { className: "turn-meta" }, left, conn), done),
    tabs, away, problem);

  // ---- the keys row: the type box and zoom ----
  const type = el("input", { className: "field type-box", id: "type-box", type: "text", placeholder: "Type here", autocomplete: "off", spellcheck: false });
  type.setAttribute("autocapitalize", "off");
  type.setAttribute("autocorrect", "off");
  type.setAttribute("enterkeyhint", "done");
  type.setAttribute("aria-label", "Type into the page: tap a field in the picture first");
  const zoomOut = el("button", { className: "mini", id: "zoom-out", type: "button", textContent: "-" });
  zoomOut.setAttribute("aria-label", "Zoom out");
  const level = el("button", { className: "mini turn-level", id: "zoom-level", type: "button", textContent: "1x" });
  level.setAttribute("aria-label", "Zoom back to the whole page");
  const zoomIn = el("button", { className: "mini", id: "zoom-in", type: "button", textContent: "+" });
  zoomIn.setAttribute("aria-label", "Zoom in");
  // A saved card (the turn event's savedCard): filled into the card number field the person tapped.
  const fill = el("button", { className: "mini turn-fill", id: "turn-fill", type: "button", textContent: "Fill saved card", hidden: true });
  fill.setAttribute("aria-label", "Fill saved card: tap the card number field first");
  const keys = el("footer", { className: "turnkeys", id: "turnkeys" }, type, fill, zoomOut, level, zoomIn);
  // The option list: a sheet over the picture with the focused select's options.
  const optTitle = el("p", { className: "turn-opts-title", id: "turn-opts-title" });
  const optList = el("div", { className: "turn-opts-list", id: "turn-opts-list", role: "listbox" });
  optList.setAttribute("aria-labelledby", "turn-opts-title");
  const optClose = el("button", { className: "mini", id: "turn-opts-close", type: "button", textContent: "Close" });
  const opts = el("section", { className: "turn-opts", id: "turn-opts", hidden: true }, el("div", { className: "turn-opts-head" }, optTitle, optClose), optList);
  opts.setAttribute("role", "dialog");
  opts.setAttribute("aria-labelledby", "turn-opts-title");
  const win = document.querySelector(".window");
  win.prepend(bar);
  win.append(opts, keys);
  stage.setAttribute("aria-label", "The handed-over tab. Tap to click, drag to scroll, pinch to zoom.");

  const say = (text) => { problem.textContent = text; problem.hidden = !text; };
  const setAway = (on) => { away.hidden = !on; document.body.dataset.away = String(on); };

  // The time left, from the grant's deadline (this device's clock).
  function tick() {
    if (!info) return;
    const ms = Number(info.expiresAt) - Date.now();
    const s = Math.max(0, Math.ceil(ms / 1000));
    left.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left`;
    left.dateTime = new Date(Number(info.expiresAt)).toISOString();
    left.dataset.low = String(ms < LOW_MS);
  }
  const ticker = setInterval(tick, 1000);

  function onTurn(t) {
    if (!t || typeof t !== "object") return;
    info = t;
    what.textContent = ACTION_WORDS[t.action] || ACTION_WORDS.other;
    where.textContent = String(t.host || "");
    tick();
    const scope = Array.isArray(t.scope) ? t.scope : [];
    tabs.replaceChildren(...scope.map((s) => el("option", { value: String(s.id), textContent: s.title || s.host || "Tab", selected: !!s.shown })));
    tabs.hidden = scope.length < 2;
    setAway(t.state === "off");
    fill.hidden = t.savedCard !== true;
    fitFocus();
    if (live) { ready = true; send(); reportView(); }
  }
  on("turn", onTurn);

  // ---- the hand-off's own actions: Done, another of its tabs, back to its tab ----
  async function act(route, body) {
    say("");
    const r = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(POST_MS) }).catch(() => null);
    if (!r) { say("Couldn't reach PairBrowse. Check your connection and try again."); return null; }
    if (r.status === 404) { stop(); end(); return null; }
    if (!r.ok) { const b = await r.json().catch(() => ({})); say(b.error || "That didn't work. Try again."); return null; }
    return r;
  }
  done.addEventListener("click", async () => {
    done.disabled = true;
    // What was typed goes first: Done waits for the queue to empty.
    for (let i = 0; i < 50 && (out || pending.length) && !stopped; i++) await new Promise((r) => setTimeout(r, 100));
    if (await act("turn-done", {})) { stop(); end({ reason: "done" }); } else done.disabled = stopped;
  });
  // Fill saved card: what was typed goes first (the queue empties), then the helper's two keys.
  fill.addEventListener("click", async () => {
    fill.disabled = true;
    for (let i = 0; i < 50 && (out || pending.length) && !stopped; i++) await new Promise((r) => setTimeout(r, 100));
    if (!stopped) await act("turn-fill-card", {});
    fill.disabled = stopped;
  });
  tabs.addEventListener("change", () => act("turn", { show: tabs.value }));

  // ---- the option list: asked for after each tap, once the tap was replayed ----
  const settled = async () => { for (let i = 0; i < 50 && (out || pending.length) && !stopped; i++) await new Promise((r) => setTimeout(r, 100)); return !out && !pending.length; };
  let asked = 0;
  async function askOptions() {
    const mine = ++asked;
    if (!(await settled()) || stopped || mine !== asked) return;
    const r = await fetch(base + "turn-options", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", cache: "no-store", signal: AbortSignal.timeout(POST_MS) }).catch(() => null);
    const b = r?.ok ? await r.json().catch(() => null) : null;
    if (mine !== asked || stopped) return;
    if (!Array.isArray(b?.options)) { opts.hidden = true; return; }
    optTitle.textContent = b.label || "Choose an option";
    const count = b.options.length;
    optList.replaceChildren(...b.options.map((o, i) => {
      const btn = el("button", { className: "turn-opt", type: "button", textContent: String(o?.label || "") || " ", disabled: !!o?.disabled });
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", String(i === b.selected));
      btn.addEventListener("click", async () => {
        opts.hidden = true;
        await settled();
        if (!stopped) await act("turn-pick", { index: i, count });
      });
      return btn;
    }));
    opts.hidden = false;
    optList.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }
  // Closing the list closes the page's own (unseen) list too.
  optClose.addEventListener("click", () => { asked++; opts.hidden = true; add({ type: "key", key: "Escape", modifiers: 0 }); });
  back.addEventListener("click", () => { const first = info?.scope?.[0]; if (first) act("turn", { show: String(first.id) }); });

  // ---- the input queue: one POST in flight; presses, releases and keys kept in order ----
  // Each batch carries this page's run and its number, so a batch sent again after a lost answer
  // (the phone's connection dropped mid-request) is answered by the helper but not replayed twice.
  const run = hex(crypto.getRandomValues(new Uint8Array(8)));
  let seq = 0;
  let pending = []; // events not yet in a batch
  let out = null; // the batch in flight, or waiting to go again: { seq, events }
  let sending = false, retry = 0;
  function add(ev) {
    if (stopped) return;
    const last = pending[pending.length - 1];
    // While a POST is out, hover moves keep only the newest place and scrolls add up.
    if (last && ev.type === "mouse" && ev.action === "mouseMoved" && !ev.buttons && last.type === "mouse" && last.action === "mouseMoved" && !last.buttons) pending[pending.length - 1] = ev;
    else if (last && ev.type === "wheel" && last.type === "wheel") pending[pending.length - 1] = { ...last, dx: last.dx + ev.dx, dy: last.dy + ev.dy };
    else pending.push(ev);
    send();
  }
  async function send() {
    if (stopped || sending || !ready) return;
    if (!out) {
      if (!pending.length) return;
      out = { seq: ++seq, events: pending.splice(0, BATCH_MAX) };
    }
    sending = true;
    clearTimeout(retry);
    let status;
    try {
      const r = await fetch(`${base}input?run=${run}&seq=${out.seq}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(out.events), cache: "no-store", signal: AbortSignal.timeout(POST_MS) });
      status = r.status;
    } catch { status = 0; }
    sending = false;
    // Not arrived, or the helper failed: the same batch goes again, before anything newer.
    if (!status || status >= 500) { retry = setTimeout(send, RETRY_MS); return; }
    out = null;
    if (status === 404 || status === 403) { stop(); end(); return; } // the hand-off is over
    if (status === 409) setAway(true); // another tab is on screen: not replayed, and said
    send();
  }
  addEventListener("online", () => send());

  // ---- the picture: page points, taps, holds, scrolls, zoom ----
  // A place on the real page, clamped to the picture (zoom included: the rectangle is as drawn).
  const point = (x, y) => {
    const r = img.getBoundingClientRect(), f = frame();
    return { x: Math.round(clamp((x - r.left) * (f.w / r.width), 0, f.w - 1)), y: Math.round(clamp((y - r.top) * (f.h / r.height), 0, f.h - 1)) };
  };
  const onPicture = (x, y) => { const r = img.getBoundingClientRect(); return !img.hidden && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; };
  const mouse = (action, at, extra = {}) => ({ type: "mouse", action, ...at, button: "none", buttons: 0, clickCount: 0, modifiers: 0, ...extra });
  const press = (at, count) => [mouse("mouseMoved", at), mouse("mousePressed", at, { button: "left", buttons: 1, clickCount: count })];
  const lift = (at, count) => mouse("mouseReleased", at, { button: "left", clickCount: count });

  let lastTap = { t: 0, x: 0, y: 0, count: 0 };
  const tapCount = (x, y, t) => {
    const near = Math.abs(x - lastTap.x) < TAP_NEAR_PX && Math.abs(y - lastTap.y) < TAP_NEAR_PX;
    const count = near && t - lastTap.t < TAP_GAP_MS ? Math.min(lastTap.count + 1, 3) : 1;
    lastTap = { t, x, y, count };
    return count;
  };

  // Zoom: the picture scaled on this device only, 1x to 4x, panned with two fingers (liveview-zoom.js);
  // a picture shorter than the page area stays at its top, right under the header (liveview.css).
  const zoomer = createZoom({ stage, box, min: ZOOM_MIN, max: ZOOM_MAX, top: true, onLevel: (z) => { level.textContent = `${Math.round(z * 10) / 10}x`; reportView(); } });
  const zoom = zoomer.state, zoomAt = zoomer.at, middle = zoomer.middle;
  zoomIn.addEventListener("click", () => { zoomedByHand = true; zoomAt(zoom.z * ZOOM_STEP, ...middle()); });
  zoomOut.addEventListener("click", () => { zoomedByHand = true; zoomAt(zoom.z / ZOOM_STEP, ...middle()); });
  level.addEventListener("click", () => { zoomedByHand = true; zoomAt(1, ...middle()); });

  // The first zoom: on the part of the tab that matters (the turn event's focus, liveview/focus.mjs:
  // a verification frame, the focused field's form, the page's fields), large enough to read and
  // tap, never leaving most of the screen empty under a small picture. Again when that part
  // changes size (a challenge opened), until the person zooms or pinches themselves.
  let zoomedByHand = false, fittedTo = null;
  const sameFocus = (a, b) => !!a && !!b && a.kind === b.kind && Math.abs(a.w - b.w) <= a.w * 0.25 && Math.abs(a.h - b.h) <= a.h * 0.25;
  function fitFocus(force = false) {
    if (zoomedByHand || stopped) return;
    const W = img.offsetWidth, H = img.offsetHeight, sw = stage.clientWidth, sh = stage.clientHeight;
    if (img.hidden || W < 2 || H < 2 || !sw || !sh) return;
    const f = info?.focus && Number(info.focus.vw) > 0 ? info.focus : null;
    if (!force && fittedTo && (f ? sameFocus(fittedTo, f) : fittedTo.none)) return;
    const s = f ? W / f.vw : 1;
    let z = f ? Math.min((sw * 0.94) / (f.w * s), (sh * 0.9) / (f.h * s)) : sh / H;
    z = clamp(z, ZOOM_MIN, ZOOM_MAX);
    if (H * z < sh * 0.5) z = clamp((sh * 0.5) / H, ZOOM_MIN, ZOOM_MAX); // never half the screen empty
    if (f) zoomer.show(z, (f.x + f.w / 2) * s, (f.y + f.h / 2) * s);
    else zoomer.show(z, W / 2, 0);
    fittedTo = f ? { ...f } : { none: true };
  }
  img.addEventListener("load", () => { if (!fittedTo) fitFocus(); });
  addEventListener("resize", () => fitFocus(true));

  // One finger: wait (a tap, until it travels or holds), scroll, or press (held, then dragged).
  // Two fingers: pinch and pan the zoom; a press already down stays as it is.
  const fingers = new Map(); // pointerId -> { x, y }
  let g = null; // { id, x0, y0, at, count, mode, timer, lx, ly }
  let pinch = null; // { d, from, mid }
  const spread = () => { const [a, b] = [...fingers.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }; };
  function holdStart() {
    if (!g || g.mode !== "wait") return;
    g.mode = "press";
    g.count = tapCount(g.x0, g.y0, performance.now());
    for (const ev of press(g.at, g.count)) add(ev);
  }
  stage.addEventListener("pointerdown", (e) => {
    if (stopped || !live) return;
    if (!opts.hidden) { asked++; opts.hidden = true; } // a tap elsewhere closes the page's list too
    e.preventDefault();
    stage.setPointerCapture?.(e.pointerId);
    if (e.pointerType === "mouse") {
      if (g || !onPicture(e.clientX, e.clientY) || e.button !== 0) return;
      const at = point(e.clientX, e.clientY);
      // at: the last place pressed, where a cancelled press comes up (a release needs a place).
      g = { id: e.pointerId, mode: "mouse", at, count: tapCount(e.clientX, e.clientY, e.timeStamp) };
      for (const ev of press(at, g.count)) add(ev);
      return;
    }
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fingers.size === 2 && g?.mode !== "press") {
      if (g) clearTimeout(g.timer);
      g = null;
      const s = spread();
      zoomedByHand = true;
      pinch = { d: s.d, mid: s.mid, from: { ...zoom } };
      return;
    }
    if (fingers.size > 1 || g || !onPicture(e.clientX, e.clientY)) return;
    g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, at: point(e.clientX, e.clientY), count: 1, mode: "wait", timer: setTimeout(holdStart, HOLD_MS) };
  });
  stage.addEventListener("pointermove", (e) => {
    if (stopped) return;
    if (e.pointerType === "mouse") {
      if (g?.mode === "mouse") { g.at = point(e.clientX, e.clientY); add(mouse("mouseMoved", g.at, { button: "left", buttons: 1 })); }
      else if (live && onPicture(e.clientX, e.clientY)) add(mouse("mouseMoved", point(e.clientX, e.clientY)));
      return;
    }
    if (fingers.has(e.pointerId)) fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && fingers.size >= 2) {
      const s = spread();
      zoomAt(pinch.from.z * (s.d / pinch.d), pinch.mid.x, pinch.mid.y, pinch.from, s.mid);
      return;
    }
    if (!g || e.pointerId !== g.id) return;
    if (g.mode === "wait" && Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > DRAG_PX) { clearTimeout(g.timer); g.mode = "scroll"; g.lx = g.x0; g.ly = g.y0; }
    if (g.mode === "scroll") {
      // The page moves with the finger: a drag up scrolls down, in page pixels at this zoom.
      const r = img.getBoundingClientRect(), f = frame();
      add({ type: "wheel", ...g.at, dx: -(e.clientX - g.lx) * (f.w / r.width), dy: -(e.clientY - g.ly) * (f.h / r.height) });
      g.lx = e.clientX; g.ly = e.clientY;
    } else if (g.mode === "press") { g.at = point(e.clientX, e.clientY); add(mouse("mouseMoved", g.at, { button: "left", buttons: 1 })); }
  });
  function up(e) {
    fingers.delete(e.pointerId);
    if (pinch && fingers.size < 2) pinch = null;
    if (!g || e.pointerId !== g.id) return;
    clearTimeout(g.timer);
    if (g.mode === "wait" && e.type === "pointerup") {
      const count = tapCount(g.x0, g.y0, performance.now());
      for (const ev of [...press(g.at, count), lift(g.at, count)]) add(ev);
      askOptions();
    } else if (g.mode === "press" || g.mode === "mouse") {
      // A pressed button always comes up, also when the gesture was cancelled.
      add(lift(e.type === "pointerup" ? point(e.clientX, e.clientY) : g.at, g.count));
      askOptions();
    }
    g = null;
  }
  stage.addEventListener("pointerup", up);
  stage.addEventListener("pointercancel", up);
  stage.addEventListener("contextmenu", (e) => e.preventDefault());
  // Safari's own pinch (its gesture events) zooms the whole page, header and keys too, and a page
  // zoomed that way can't be pinched back from the picture (it takes every touch): never here.
  for (const ev of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (live && !stopped && onPicture(e.clientX, e.clientY)) add({ type: "wheel", ...point(e.clientX, e.clientY), dx: e.deltaX, dy: e.deltaY });
  }, { passive: false });

  // ---- the sharper still of the part on screen, zoomed in ----
  // The part of the picture on screen (page pixels) and the screen's pixels for one of them, sent
  // once zoom and pan rest and only when it changed (again after a reconnect: the stream's view is new).
  let viewTimer = 0, viewSent = "";
  function reportView() {
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
      if (!ready || stopped || img.hidden) return;
      const r = img.getBoundingClientRect(), st = stage.getBoundingClientRect(), f = frame();
      if (r.width < 2 || r.height < 2 || f.w < 2 || f.h < 2) return;
      const kx = f.w / r.width, ky = f.h / r.height; // page pixels per screen point
      const x0 = Math.max(r.left, st.left), x1 = Math.min(r.right, st.right), y0 = Math.max(r.top, st.top), y1 = Math.min(r.bottom, st.bottom);
      if (x1 - x0 < 2 || y1 - y0 < 2) return;
      const v = { x: Math.round((x0 - r.left) * kx), y: Math.round((y0 - r.top) * ky), w: Math.round((x1 - x0) * kx), h: Math.round((y1 - y0) * ky), px: Math.round(((window.devicePixelRatio || 1) / kx) * 100) / 100 };
      const sig = JSON.stringify(v);
      if (sig === viewSent) return;
      viewSent = sig;
      fetch(base + "turn-view", { method: "POST", headers: { "content-type": "application/json" }, body: sig, cache: "no-store", signal: AbortSignal.timeout(POST_MS) }).catch(() => { viewSent = ""; });
    }, VIEW_MS);
  }
  // The still, over the part it shows (in the picture's own box, so zoom moves it along), until the
  // next frame: a moving one, or the whole tab's still.
  const sharp = el("img", { className: "sharp", id: "sharp", alt: "", hidden: true });
  box.append(sharp);
  let stills = 0;
  on("frame", () => { stills++; sharp.hidden = true; });
  on("sharp", (d) => {
    const f = frame(), mine = ++stills;
    if (!d || typeof d.img !== "string" || d.fw !== f.w || d.fh !== f.h || !(d.w > 0 && d.h > 0)) return;
    sharp.onload = () => {
      if (mine !== stills) return;
      Object.assign(sharp.style, { left: `${(d.x / f.w) * 100}%`, top: `${(d.y / f.h) * 100}%`, width: `${(d.w / f.w) * 100}%`, height: `${(d.h / f.h) * 100}%` });
      sharp.hidden = false;
    };
    sharp.src = "data:image/jpeg;base64," + d.img;
  });

  // ---- the type box: opens the keyboard, passes each character on, keeps nothing ----
  let composing = false, composed = "";
  // Text as the page should get it: one key press per character (a one-time-code box moves on
  // each), a line break as Enter, a long insert as one text event.
  function typed(text) {
    if (!text) return;
    const chars = [...text];
    if (chars.length > TEXT_AT) return add({ type: "text", text });
    for (const ch of chars) {
      if (ch === "\n" || ch === "\r") add({ type: "key", key: "Enter", modifiers: 0 });
      else if (ch === "\t") add({ type: "key", key: "Tab", modifiers: 0 });
      else add({ type: "char", text: ch, modifiers: 0 });
    }
  }
  type.addEventListener("keydown", (e) => {
    if (e.isComposing || composing || e.keyCode === 229 || !NAMED.has(e.key)) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    add({ type: "key", key: e.key, modifiers: e.shiftKey ? 8 : 0 });
  });
  type.addEventListener("beforeinput", (e) => {
    // A word still being composed (a keyboard's suggestions, accents, CJK) is sent once, when done.
    if (e.isComposing || composing || e.inputType === "insertCompositionText") return;
    e.preventDefault();
    composed = "";
    if (e.inputType === "insertText" || e.inputType === "insertReplacementText" || e.inputType === "insertFromPaste" || e.inputType === "insertFromDrop") typed(e.data ?? e.dataTransfer?.getData("text/plain") ?? "");
    else if (e.inputType === "deleteContentBackward") add({ type: "key", key: "Backspace", modifiers: 0 });
    else if (e.inputType === "deleteContentForward") add({ type: "key", key: "Delete", modifiers: 0 });
    else if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") add({ type: "key", key: "Enter", modifiers: 0 });
  });
  type.addEventListener("compositionstart", () => { composing = true; });
  type.addEventListener("compositionend", (e) => {
    composing = false;
    composed = e.data || "";
    typed(composed);
    type.value = "";
  });
  // Whatever still reached the box (an insert that couldn't be stopped) goes on once, and the box
  // is emptied; the text a composition just sent is not sent again.
  type.addEventListener("input", (e) => {
    if (composing || e.isComposing) return;
    const v = type.value;
    type.value = "";
    if (v && v !== composed) typed(v);
    composed = "";
  });

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(ticker);
    clearTimeout(retry);
    clearTimeout(viewTimer);
    if (g) clearTimeout(g.timer);
    pending = []; out = null;
    for (const c of [type, done, tabs, back, fill]) c.disabled = true;
    opts.hidden = true;
    setAway(false);
    say("");
    document.body.dataset.ended = "true"; // no timer, no Done, no keys (liveview.css)
  }

  return {
    state(s) {
      live = s === "live";
      if (!live) { ready = false; viewSent = ""; } // until the stream's next turn event
      conn.dataset.s = s;
      connText.textContent = STATE_WORDS[s] || s;
      if (s === "closed") stop();
    },
    // The stream was refused: the hand-off still runs (its dropped stream not yet let go), or ended
    // while this device was away (its key is gone: 404).
    async lost() {
      if (stopped) return;
      const r = await fetch(base + "state.json", { cache: "no-store", signal: AbortSignal.timeout(POST_MS) }).catch(() => null);
      if (r?.status === 404) { stop(); return end(); }
      setTimeout(reopen, STREAM_RETRY_MS);
    },
  };
}
