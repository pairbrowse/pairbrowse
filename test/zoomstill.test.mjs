// The sharper still for a hand-off's phone zoomed in (scripts/liveview/zoomstill.mjs): the viewer's
// report read with bounded numbers, and the clip taken of the tab: the part on screen in page
// coordinates, at the phone's pixels, never more than the caps, none where the tab's own pixels do.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readView, planClip, ZOOM_STILL } from "../scripts/liveview/zoomstill.mjs";

const FRAME = { w: 1280, h: 800 };
const metrics = ({ ratio = 1, pageX = 0, pageY = 0, w = 1280, h = 800, scale = 1, zoom = 1 } = {}) => ({
  cssVisualViewport: { pageX, pageY, clientWidth: w, clientHeight: h, scale, zoom },
  cssLayoutViewport: { clientWidth: w, clientHeight: h },
  layoutViewport: { clientWidth: w * ratio, clientHeight: h * ratio },
});

test("readView: five finite numbers in their bounds, nothing else", () => {
  assert.deepEqual(readView({ x: 10, y: 20.5, w: 400, h: 300, px: 2.7, extra: "kept out" }), { x: 10, y: 20.5, w: 400, h: 300, px: 2.7 });
  for (const v of [null, [], "x", {}, { x: 0, y: 0, w: 0, h: 10, px: 2 }, { x: -1, y: 0, w: 10, h: 10, px: 2 }, { x: 0, y: 0, w: 10, h: 10, px: 0 },
    { x: 0, y: 0, w: 10, h: 10, px: 17 }, { x: 0, y: 0, w: 1e9, h: 10, px: 2 }, { x: "1", y: 0, w: 10, h: 10, px: 2 }, { x: NaN, y: 0, w: 10, h: 10, px: 2 },
    { x: 0, y: 0, w: 10, h: Infinity, px: 2 }]) assert.equal(readView(v), null, JSON.stringify(v));
});

test("planClip: the part on screen at the phone's pixels, in page coordinates", () => {
  const p = planClip({ x: 100, y: 50, w: 400, h: 250, px: 2.74 }, FRAME, metrics({ pageY: 900 }));
  assert.deepEqual(p, { clip: { x: 100, y: 950, width: 400, height: 250, scale: 2.74 }, rect: { x: 100, y: 50, w: 400, h: 250 } });
  // Over the phone's own ratio cap: 3 at most.
  assert.equal(planClip({ x: 0, y: 0, w: 100, h: 100, px: 9 }, FRAME, metrics()).clip.scale, ZOOM_STILL.maxScale);
  // A part past the picture's edge is cut to it.
  assert.deepEqual(planClip({ x: 1200, y: 700, w: 400, h: 400, px: 3 }, FRAME, metrics()).rect, { x: 1200, y: 700, w: 80, h: 100 });
});

test("planClip: never more than 2.5 megapixels; none where the tab's own pixels are as sharp", () => {
  // The whole tab at 3: capped by pixels, still worth it at about 1.56.
  const whole = planClip({ x: 0, y: 0, w: 1280, h: 800, px: 3 }, FRAME, metrics());
  assert.ok(whole.clip.width * whole.clip.height * whole.clip.scale ** 2 <= ZOOM_STILL.maxPixels);
  assert.ok(whole.clip.scale > 1.5);
  // A phone at 1x (0.9 device pixels a page pixel): the tab's own still is enough.
  assert.equal(planClip({ x: 0, y: 0, w: 1280, h: 800, px: 0.9 }, FRAME, metrics()), null);
  // A Retina screen (2 device pixels a page pixel): a clip only past that, its scale over the 2.
  assert.equal(planClip({ x: 0, y: 0, w: 400, h: 250, px: 2.2 }, FRAME, metrics({ ratio: 2 })), null);
  const retina = planClip({ x: 0, y: 0, w: 400, h: 250, px: 3 }, FRAME, metrics({ ratio: 2 }));
  assert.equal(retina.clip.scale, 1.5);
  assert.ok(retina.clip.width * retina.clip.height * (retina.clip.scale * 2) ** 2 <= ZOOM_STILL.maxPixels);
});

test("planClip: nothing when the tab is pinched on its own screen, its size isn't the picture's, or the part is empty", () => {
  const view = { x: 0, y: 0, w: 400, h: 250, px: 3 };
  assert.equal(planClip(view, FRAME, metrics({ scale: 1.5 })), null);
  assert.equal(planClip(view, FRAME, metrics({ zoom: 1.25 })), null);
  assert.equal(planClip(view, FRAME, metrics({ w: 1000 })), null);
  assert.equal(planClip({ ...view, x: 1280 }, FRAME, metrics()), null);
  assert.equal(planClip(view, FRAME, {}), null);
  assert.equal(planClip(view, FRAME, null), null);
});
