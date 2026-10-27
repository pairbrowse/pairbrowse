// A watch link's viewer (share "watch" on the public address, liveview/public-turn.mjs), phone
// first and view only. liveview.js loads it for a watch link on that address alone, after the page
// has loaded (a link preview that runs no script never opens the stream), and keeps the shared
// parts (the stream, the picture and its size, the tabs and activity). This adds the bar that says
// it is view only (its connection's state and the zoom keys in it, never over the picture), zoom on
// this device (pinch, a drag to move around when zoomed in, a double tap, + and -, Ctrl or Cmd with
// the wheel; liveview-zoom.js) (on a phone, liveview.css fits the picture to the screen's width at the
// top of the page area), and what a dropped stream does: the page
// asks its own address whether the link still works (404 once stopped or expired) and opens the
// stream again, or says the link ended. Nothing here sends input: the helper refuses a watch
// link's key every input route anyway.
import { $, el } from "./common.js";
import { createZoom } from "./liveview-zoom.js";
export { socketEvents } from "./liveview-socket.js";

const ZOOM_MIN = 1, ZOOM_MAX = 5, ZOOM_STEP = 1.5, DOUBLE_TAP_ZOOM = 2.5;
const TAP_GAP_MS = 350, TAP_NEAR_PX = 24;
const RETRY_MS = 2000; // a dropped stream, opened again after this
const CHECK_MS = 8000; // the link's own address, asked at most this long
const STATE_WORDS = { connecting: "Connecting", live: "Watching live", reconnecting: "Reconnecting", closed: "Ended" };

// base: the page's /<key>/; img, stage: the picture and its pane; reopen(): opens the event stream again; end(): the link ended (stopped or expired).
// Returns { state(s), lost() }.
export function startWatch({ base, img, stage, reopen, end }) {
  const box = $("frame"); // what zoom scales: the picture and what is drawn over it
  let stopped = false;

  // ---- the bar: the connection (its one indicator), view only, the zoom keys ----
  const conn = el("strong", { className: "watch-conn", id: "watch-conn" }, el("i"), el("span", { id: "watch-conn-text", textContent: STATE_WORDS.connecting }));
  conn.setAttribute("role", "status");
  conn.setAttribute("aria-live", "polite");
  // ---- zoom: -, the level (back to the whole page), + ----
  const zoomOut = el("button", { className: "mini", id: "watch-zoom-out", type: "button", textContent: "-" });
  zoomOut.setAttribute("aria-label", "Zoom out");
  const level = el("button", { className: "mini watch-level", id: "watch-zoom-level", type: "button", textContent: "1x" });
  level.setAttribute("aria-label", "Zoom back to the whole page");
  const zoomIn = el("button", { className: "mini", id: "watch-zoom-in", type: "button", textContent: "+" });
  zoomIn.setAttribute("aria-label", "Zoom in");
  const keys = el("div", { className: "watchkeys", id: "watchkeys" }, zoomOut, level, zoomIn);
  keys.setAttribute("role", "group");
  keys.setAttribute("aria-label", "Zoom");
  const bar = el("div", { className: "watchbar", id: "watchbar" },
    el("p", { className: "watch-title" }, conn, el("span", { className: "watch-only", textContent: "View only" })), keys);
  document.querySelector(".window").prepend(bar);
  stage.setAttribute("aria-label", "The shared browser, live and view only. Pinch or use + and - to zoom; drag to move around when zoomed in.");

  const zoomer = createZoom({ stage, box, min: ZOOM_MIN, max: ZOOM_MAX, top: true, onLevel: (z) => { level.textContent = `${Math.round(z * 10) / 10}x`; } });
  const zoom = zoomer.state, zoomAt = zoomer.at, middle = zoomer.middle;
  zoomIn.addEventListener("click", () => zoomAt(zoom.z * ZOOM_STEP, ...middle()));
  zoomOut.addEventListener("click", () => zoomAt(zoom.z / ZOOM_STEP, ...middle()));
  level.addEventListener("click", () => zoomAt(1, ...middle()));
  // Ctrl or Cmd with the wheel (and a trackpad's pinch, which the browser sends that way) zooms; the
  // plain wheel does nothing here (nothing reaches the page).
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(zoom.z * Math.exp(-e.deltaY / 200), e.clientX, e.clientY);
  }, { passive: false });

  // Fingers and the mouse: two fingers pinch, one moves the picture around while zoomed in, a
  // double tap zooms in there (or back out). Nothing is sent anywhere.
  const pointers = new Map(); // pointerId -> { x, y }
  let pinch = null, pan = null, lastTap = { t: 0, x: 0, y: 0 };
  const spread = () => { const [a, b] = [...pointers.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }; };
  stage.addEventListener("pointerdown", (e) => {
    if (keys.contains(e.target)) return;
    e.preventDefault();
    stage.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { const s = spread(); pinch = { d: s.d, mid: s.mid, from: { ...zoom } }; pan = null; return; }
    if (pointers.size === 1) pan = { id: e.pointerId, x: e.clientX, y: e.clientY, from: { ...zoom }, moved: false };
  });
  stage.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) { const s = spread(); zoomAt(pinch.from.z * (s.d / pinch.d), pinch.mid.x, pinch.mid.y, pinch.from, s.mid); return; }
    if (!pan || pan.id !== e.pointerId) return;
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (Math.hypot(dx, dy) > 6) pan.moved = true;
    if (zoom.z > 1) { zoom.tx = pan.from.tx + dx; zoom.ty = pan.from.ty + dy; zoomer.apply(); }
  });
  function up(e) {
    pointers.delete(e.pointerId);
    if (pinch && pointers.size < 2) { pinch = null; pan = null; return; }
    if (!pan || pan.id !== e.pointerId) return;
    const tap = !pan.moved && e.type === "pointerup";
    pan = null;
    if (!tap) return;
    const now = performance.now();
    const near = Math.abs(e.clientX - lastTap.x) < TAP_NEAR_PX && Math.abs(e.clientY - lastTap.y) < TAP_NEAR_PX;
    if (near && now - lastTap.t < TAP_GAP_MS) { lastTap = { t: 0, x: 0, y: 0 }; zoomAt(zoom.z > 1 ? 1 : DOUBLE_TAP_ZOOM, e.clientX, e.clientY); return; }
    lastTap = { t: now, x: e.clientX, y: e.clientY };
  }
  stage.addEventListener("pointerup", up);
  stage.addEventListener("pointercancel", up);
  // Safari's own pinch (its gesture events) would zoom the whole page instead: never here.
  for (const ev of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  // Keys on the stage itself: + and - zoom, 0 goes back to the whole page.
  stage.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") zoomAt(zoom.z * ZOOM_STEP, ...middle());
    else if (e.key === "-") zoomAt(zoom.z / ZOOM_STEP, ...middle());
    else if (e.key === "0") zoomAt(1, ...middle());
    else return;
    e.preventDefault();
  });
  img.addEventListener("load", () => zoomer.apply());

  // ---- the stream dropped: still a link? ----
  let retry = null;
  async function stillThere() {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CHECK_MS);
    try { return (await fetch(base, { cache: "no-store", credentials: "omit", signal: ctl.signal })).status; } catch { return 0; } finally { clearTimeout(timer); }
  }
  async function lost() {
    if (stopped) return;
    clearTimeout(retry);
    const status = await stillThere();
    if (stopped) return;
    if (status === 404 || status === 403) { stopped = true; return end(); }
    retry = setTimeout(() => { if (!stopped && !document.hidden) reopen(); }, RETRY_MS);
  }

  return {
    state(s) {
      conn.dataset.s = s;
      $("watch-conn-text").textContent = STATE_WORDS[s] || STATE_WORDS.connecting;
      if (s === "closed") stopped = true;
    },
    lost,
  };
}
