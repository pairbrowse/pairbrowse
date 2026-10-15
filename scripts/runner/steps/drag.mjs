// A drag step: a stroke drawn as a person draws it.
import { sleep } from "../../util.mjs";
import { viewSize } from "../locate.mjs";

// A stroke's pace: one small move this often (a steady hand drawing).
const STROKE_STEP_MS = 8;
const strokeEnds = new WeakMap(); // page -> where its last stroke let go (moves the humanized mouse doesn't know of)

export async function drag({ page, arg, hooks }) {
  // Drawing, as a person does: the mouse goes down at the first point and follows the rest
  // (in the PairBrowse browser its moves take human paths and timing), then lets go.
  const [w, h] = await viewSize(page);
  const pts = arg.map(([x, y]) => ({ x: Math.round(x * w), y: Math.round(y * h) }));
  const mark = (p) => hooks.cursor?.({ boundingBox: async () => ({ x: p.x, y: p.y, width: 0, height: 0 }) }, "");
  const glide = Math.min(600, Number(await mark(pts[0])) || 0); // how long the cursor takes to get there
  // The stroke goes straight to the browser's input at a steady drawing pace: the humanized
  // mouse gives every move a hand's whole reach-and-settle time (about half a second per
  // point, seconds for a long reach) and presses where its own last move ended.
  const cdp = await page.context().newCDPSession(page);
  const send = (type, p) => cdp.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
  const from = strokeEnds.get(page);
  if (!from) {
    // The first stroke here: the hand comes to the start as a person's does (human paths in
    // the PairBrowse browser).
    await page.mouse.move(pts[0].x, pts[0].y);
  } else {
    // From the last stroke's end: along a gentle curve, eased, in the time the cursor glides.
    const dx = pts[0].x - from.x, dy = pts[0].y - from.y;
    const n = Math.max(3, Math.round(glide / 16));
    for (let k = 1; k <= n; k++) {
      const e = (1 - Math.cos((Math.PI * k) / n)) / 2, bend = 0.08 * Math.sin(Math.PI * e);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(from.x + dx * e - dy * bend), y: Math.round(from.y + dy * e + dx * bend), button: "none", buttons: 0 });
      await sleep(glide / n);
    }
  }
  let at = pts[0];
  try {
    await send("mousePressed", at);
    // Let go whatever happens on the way: a stroke that fails must never leave the button held.
    try {
      for (const p of pts.slice(1)) {
        // A person took over (clicked, typed, paused agents): the stroke stops where it is.
        const why = hooks.interrupted?.();
        if (why) throw new Error(why);
        const n = Math.max(2, Math.min(12, Math.round(Math.hypot(p.x - at.x, p.y - at.y) / 12)));
        for (let k = 1; k <= n; k++) {
          await send("mouseMoved", { x: Math.round(at.x + (p.x - at.x) * k / n), y: Math.round(at.y + (p.y - at.y) * k / n) });
          await sleep(STROKE_STEP_MS);
        }
        at = p;
        await mark(p);
      }
    } finally {
      await send("mouseReleased", at).catch(() => {});
      strokeEnds.set(page, at);
    }
  } finally {
    cdp.detach().catch(() => {});
  }
  hooks.activity(`Drew a stroke (${pts.length} points)`);
}
