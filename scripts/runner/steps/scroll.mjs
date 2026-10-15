// A scroll step: the wheel, gliding (pairbrowse_scroll) or quick (fast mode).
import { sleep } from "../../util.mjs";
import { viewSize } from "../locate.mjs";

export async function scroll({ page, arg, hooks }) {
  // The cursor onto the page, then the wheel: in small eased steps that glide like a person
  // (pairbrowse_scroll), or in two quick ones (fast mode). A screen for "down" / "up".
  const [w, h] = await viewSize(page);
  const total = arg === "down" ? Math.round(h * 0.8) : arg === "up" ? -Math.round(h * 0.8) : Math.round(Number(arg));
  const x = Math.round(w / 2), y = Math.round(h / 2);
  await hooks.cursor?.({ boundingBox: async () => ({ x, y, width: 0, height: 0 }) }, "");
  await page.mouse.move(x, y);
  // A glide: about a third of a second a screen, in up to a dozen eased steps (smooth to watch,
  // never slow); fast mode: two quick turns.
  const n = hooks.smooth ? Math.min(12, Math.max(6, Math.ceil(Math.abs(total) / 90))) : 2;
  let sent = 0;
  for (let k = 1; k <= n; k++) {
    const eased = Math.round(total * (1 - Math.cos((Math.PI * k) / n)) / 2); // slow, fast, slow
    await page.mouse.wheel(0, eased - sent);
    sent = eased;
    if (k % 10 === 0) await hooks.cursor?.({ boundingBox: async () => ({ x, y, width: 0, height: 0 }) }, ""); // still the agent's
    if (hooks.smooth) await sleep(16);
  }
  await sleep(60); // the page catches up with the last turn of the wheel
  hooks.activity(`Scrolled ${total > 0 ? "down" : "up"}`);
}
