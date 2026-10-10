// browser_drag as a hand does it. Playwright's own dragTo presses, makes one move to the target
// and lets go: pages that start a drag on the first move and move the card on the ones after
// (most board and list libraries, built on pointer events or on HTML5 drag-and-drop) pick the
// card up and put it back where it was. Here the press is followed by a short move that starts
// the drag, then steps across to the target (the page sees the card move, drop targets light
// up), a moment's hold, and the release. Playwright's mouse keeps HTML5 drags in the page (no
// system drag); in the PairBrowse browser the moves take human paths.
import { within } from "../util.mjs";

const STEPS = 12; // moves across to the target
const START_NUDGE_PX = 8; // past any library's "did the pointer really move" threshold
const HOLD_MS = 80; // for the page to draw the pick-up and the drop target before the next move
const FIND_MS = 5000; // to find and reach each element

// from, to: locators. cursor(el, act): shows the agent's cursor (daemon/hud.mjs cursorTo).
// interrupted(): why to stop mid-way ("" to go on): a person took the tab or paused agents.
// Throws with a plain reason when an end can't be found or reached.
export async function dragBetween(page, from, to, { cursor = null, interrupted = () => "" } = {}) {
  // Both ends in view first (as far as they can be at once), the start last so the pointer's
  // first reach lands on it.
  // Both ends on the page at all (a stale ref matches nothing: said at once, not after a wait).
  for (const [el, what] of [[from, "the element to drag"], [to, "the drop target"]]) {
    const n = await within(2000, el.count()).catch(() => 1);
    if (n === 0) throw new Error(`couldn't find ${what} on the page (gone, or a stale ref: take a browser_snapshot)`);
  }
  await within(FIND_MS, to.scrollIntoViewIfNeeded({ timeout: FIND_MS })).catch(() => {});
  await cursor?.(from, "click"); // sent, and the press declared, before the button goes down
  await from.hover({ timeout: FIND_MS }).catch((e) => { throw new Error(`${reason(e)} (the element to drag)`); });
  const a = await box(from, "the element to drag");
  const b = await box(to, "the drop target");
  await page.mouse.down();
  try {
    // The move that starts the drag: short, from the pressed spot.
    await page.mouse.move(a.x + START_NUDGE_PX, a.y + START_NUDGE_PX, { steps: 2 });
    await sleep(HOLD_MS);
    const why = interrupted();
    if (why) throw new Error(why);
    cursor?.(to, "click");
    await page.mouse.move(b.x, b.y, { steps: STEPS });
    await sleep(HOLD_MS);
  } finally {
    // Let go whatever happens on the way: a failed drag must never leave the button held.
    await page.mouse.up().catch(() => {});
  }
}

async function box(el, what) {
  const r = await within(FIND_MS, el.boundingBox({ timeout: FIND_MS })).catch(() => null);
  if (!r || !(r.width > 0 && r.height > 0)) throw new Error(`couldn't find ${what} on the page (hidden, gone, or a stale ref: take a browser_snapshot)`);
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A plain reason from Playwright's error.
export function reason(e) {
  const m = String(e?.message || e || "");
  if (/intercepts pointer events/i.test(m)) return "something covers it";
  if (/not visible|hidden/i.test(m)) return "it's hidden";
  if (/Timeout|timeout/i.test(m)) return "it couldn't be reached in time";
  if (/not found in the current page snapshot|does not match|strict mode|resolved to \d+ elements/i.test(m)) return "the ref doesn't match an element now (take a browser_snapshot)";
  return m.split("\n")[0].slice(0, 120) || "it didn't work";
}
