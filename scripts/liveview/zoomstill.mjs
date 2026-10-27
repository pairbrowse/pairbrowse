// A sharper still for a hand-off's phone zoomed in (liveview-turn.js): the tab is drawn at its own
// size (1280 CSS pixels wide on a server, one device pixel each), a phone shows a part of it 2 to 4
// times larger on a screen of 3 device pixels a point, so even the sharp still of the whole tab is
// blurred there. The viewer reports the part it shows (POST turn-view: readView), and once the page
// has settled (cast.mjs onSettle) the helper takes that part alone at the phone's pixel size (planClip,
// cast.clipStill), never the page resized, and sends it to that stream (event "sharp"), which draws
// it over that part until the next moving frame. Only the hand-off's own stream, only while a tab of
// its scope is on screen and that tab's picture is one it may see (grants.mjs frameTo), never a
// person's own tab.
import { FRAME_SKIP_BYTES } from "../../ui/limits.js";

export const ZOOM_STILL = {
  maxPixels: 2_500_000, // a still's own pixels at most (a slow phone's connection, its decoding)
  maxScale: 3, // device pixels per page pixel at most (a phone's own ratio)
  gain: 1.15, // worth a still only this much sharper than the tab's own pixels
  gapMs: 600, // one stream's stills at most this often (a page that never quite settles)
};
const SIDE_MAX = 10_000;

// A viewer's report, checked: { x, y, w, h } the part of the picture on screen in the page's CSS
// pixels (the frame's coordinates), px the device pixels the phone gives one of them now. Returns
// it with bounded numbers, or null.
export function readView(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const n = (k, lo, hi) => (typeof v[k] === "number" && Number.isFinite(v[k]) && v[k] >= lo && v[k] <= hi ? v[k] : null);
  const view = { x: n("x", 0, SIDE_MAX), y: n("y", 0, SIDE_MAX), w: n("w", 1, SIDE_MAX), h: n("h", 1, SIDE_MAX), px: n("px", 0.1, 16) };
  return Object.values(view).every((x) => x !== null) ? view : null;
}

// The clip for a view of a frame ({ w, h } CSS pixels) from Page.getLayoutMetrics' answer: { clip
// (for Page.captureScreenshot: page coordinates, scale over the tab's own pixel ratio), rect (the
// part, in the frame's coordinates) }, or null when the tab's own pixels are sharp enough there,
// the tab is zoomed by its own pinch, or its size isn't the frame's (it changed meanwhile).
export function planClip(view, frame, metrics, { maxPixels, maxScale, gain } = ZOOM_STILL) {
  const css = metrics?.cssVisualViewport, layout = metrics?.cssLayoutViewport, device = metrics?.layoutViewport;
  if (!view || !frame || !css || !layout) return null;
  if ((css.scale ?? 1) !== 1 || (css.zoom ?? 1) !== 1) return null;
  if (Math.abs(css.clientWidth - frame.w) > 2 || Math.abs(css.clientHeight - frame.h) > 2) return null;
  const ratio = Math.min(4, Math.max(1, device?.clientWidth > 0 && layout.clientWidth > 0 ? device.clientWidth / layout.clientWidth : 1));
  const x = Math.max(0, Math.floor(view.x)), y = Math.max(0, Math.floor(view.y));
  const w = Math.min(frame.w, Math.ceil(view.x + view.w)) - x, h = Math.min(frame.h, Math.ceil(view.y + view.h)) - y;
  if (w < 1 || h < 1) return null;
  const want = Math.min(view.px, maxScale, Math.sqrt(maxPixels / (w * h)));
  if (want < ratio * gain) return null;
  const scale = Math.floor((want / ratio) * 100) / 100;
  return { clip: { x: x + (css.pageX || 0), y: y + (css.pageY || 0), width: w, height: h, scale }, rect: { x, y, w, h } };
}

// cast: the picture (liveview/cast.mjs). targets(): the hand-off streams with a view now, [{ res,
// view, ok() }] (ok: that stream may get a picture of the tab on screen). send(res, data): writes
// the "sharp" event ({ img, x, y, w, h, fw, fh }) to that stream. Returns { wake() (a view changed:
// a still now if the page is at rest), close() }.
export function createZoomStills({ cast, targets, send, personTab = () => false, log = () => {}, gapMs = ZOOM_STILL.gapMs }) {
  const last = new WeakMap(); // stream -> { sig, at } of its last still
  let busy = false, again = false, timer = null, closed = false;
  async function run() {
    if (busy) { again = true; return; }
    busy = true;
    try {
      do {
        again = false;
        for (const { res, view, ok } of targets()) {
          const page = cast.state.shown?.page, frame = cast.state.lastFrame;
          if (closed || !view || !page || !frame || !cast.settled() || res.destroyed || !ok() || personTab(page)) continue;
          // Once per view and picture at rest: a page that keeps settling gets one every gapMs.
          const sig = `${view.x},${view.y},${view.w},${view.h},${view.px}|${frame.img.length}:${frame.img.slice(-64)}`;
          const was = last.get(res);
          if (was?.sig === sig) continue;
          const wait = was ? was.at + gapMs - Date.now() : 0;
          if (wait > 0) { clearTimeout(timer); timer = setTimeout(wake, wait); timer.unref?.(); continue; }
          let rect = null;
          const img = await cast.clipStill(page, (m) => { const p = planClip(view, frame, m); rect = p?.rect || null; return p?.clip || null; });
          last.set(res, { sig, at: Date.now() });
          // Checked again as it goes: the same tab on screen, that stream still allowed its picture.
          if (!img || !rect || res.destroyed || cast.state.shown?.page !== page || !ok() || personTab(page)) continue;
          if (res.writableLength > FRAME_SKIP_BYTES) continue;
          send(res, { img, ...rect, fw: frame.w, fh: frame.h });
        }
      } while (again && !closed);
    } catch (e) {
      log("liveview zoom still", e?.message || e);
    } finally { busy = false; }
  }
  function wake() { if (!closed) run(); }
  const stop = cast.onSettle ? cast.onSettle(wake) : () => {};
  return { wake, close() { closed = true; clearTimeout(timer); stop(); } };
}
