// A go step: open an address and wait for the page (not every script and image) to arrive.
import { addressOnly } from "../../log.mjs";

export async function go({ page, arg, hooks }) {
  // Wait for the page to arrive, not for every script and image: a slow resource on the
  // site mustn't fail the step when the page itself is there and usable.
  await page.goto(arg, { waitUntil: "commit", timeout: 30000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  // Sites built in JavaScript draw their forms a moment after the page arrives.
  await page.locator("input:not([type=hidden]), textarea, select").first().waitFor({ state: "visible", timeout: 2500 }).catch(() => {});
  hooks.activity(`Opened ${addressOnly(arg)}`);
}
