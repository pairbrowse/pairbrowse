// The Web Store's buttons name this browser (scripts/hud/store.js, the page script's store part),
// in a real browser (PAIRBROWSE_TEST_RUNTIME): "Add to PairBrowse", "Remove from PairBrowse", as
// the store draws them; other text and other sites as they are.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { hudScript } from "../../scripts/browser.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;

test("the store's buttons read Add to PairBrowse and Remove from PairBrowse; other text stays", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const html = `<!doctype html><body><button id=add><span>Add to Chrome</span></button><p id=p>Add to Chrome is what the store says</p>
      <div role=button id=rm aria-label="Remove from Chrome">Remove from Chrome</div><script>setTimeout(() => { const b = document.createElement("button"); b.id = "late"; b.textContent = "Add to Chrome"; document.body.append(b); document.getElementById("add").firstChild.textContent = "Add to Chrome"; }, 200);</script>`;
    await page.route("https://chromewebstore.google.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: html }));
    await page.route("https://example.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: html }));
    await page.goto("https://chromewebstore.google.com/detail/x");
    await page.evaluate(hudScript().source);
    await page.waitForTimeout(500);
    const read = () => page.evaluate(() => ({ add: document.getElementById("add").textContent, late: document.getElementById("late")?.textContent, p: document.getElementById("p").textContent, rm: document.getElementById("rm").textContent, label: document.getElementById("rm").getAttribute("aria-label") }));
    assert.deepEqual(await read(), { add: "Add to PairBrowse", late: "Add to PairBrowse", p: "Add to Chrome is what the store says", rm: "Remove from PairBrowse", label: "Remove from PairBrowse" });
    await page.goto("https://example.com/");
    await page.evaluate(hudScript().source);
    await page.waitForTimeout(500);
    assert.equal((await read()).add, "Add to Chrome", "another site: as it is");
  } finally { await browser.close(); }
});
