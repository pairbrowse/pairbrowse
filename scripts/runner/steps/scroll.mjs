// A scroll step: the wheel, in whole notches of the platform's size (wheel.mjs), in short flicks
// that glide (pairbrowse_scroll) or one quick turn after another (fast mode).
import { sleep } from "../../util.mjs";
import { viewSize } from "../locate.mjs";
import { wheelFlicks, wheelNotch } from "../../wheel.mjs";

// Fast mode's wait between notches: one frame, no pause between flicks.
const QUICK_MS = 16;

export async function scroll({ page, arg, hooks }) {
  // The cursor onto the page, then the wheel. A screen for "down" / "up".
  const [w, h] = await viewSize(page);
  const total = arg === "down" ? Math.round(h * 0.8) : arg === "up" ? -Math.round(h * 0.8) : Math.round(Number(arg));
  const x = Math.round(w / 2), y = Math.round(h / 2);
  await hooks.cursor?.({ boundingBox: async () => ({ x, y, width: 0, height: 0 }) }, "");
  await page.mouse.move(x, y);
  // Whole notches of the platform pages are told about (hooks.wheelNotch, the helper's; else this
  // computer's), so deltaY and wheelDeltaY are a real device's pair: in flicks with a finger's
  // pauses when smooth, each notch a frame apart in fast mode.
  const steps = wheelFlicks(total, hooks.wheelNotch ?? wheelNotch());
  let k = 0;
  for (const s of steps) {
    await page.mouse.wheel(0, s.delta);
    if (++k % 10 === 0) await hooks.cursor?.({ boundingBox: async () => ({ x, y, width: 0, height: 0 }) }, ""); // still the agent's
    if (s.sleepMs > 0) await sleep(hooks.smooth ? s.sleepMs : Math.min(s.sleepMs, QUICK_MS));
  }
  await sleep(60); // the page catches up with the last turn of the wheel
  hooks.activity(`Scrolled ${total > 0 ? "down" : "up"}`);
}
