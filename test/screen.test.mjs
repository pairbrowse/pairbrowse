// The joiner's picture page (shared browser mode, scripts/browser/panel/screen.*): what the
// person sees while the pictures stop coming because the connection to the host is moving to
// another address.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inPage } from "./live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const panel = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "browser", "panel");
const TYPES = { html: "text/html", css: "text/css", js: "text/javascript" };

test("pictures that stop coming show a spinner and 'Reconnecting to Bob…' over the last one, gone with the next picture", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
    // The page as the extension serves it, from its own files.
    await page.route("http://pairbrowse.test/**", (route) => {
      const name = new URL(route.request().url()).pathname.slice(1);
      route.fulfill({ contentType: TYPES[name.split(".").pop()], body: readFileSync(join(panel, name)) });
    });
    await page.goto("http://pairbrowse.test/screen.html");
    // The page's own script world (window.pbScreen lives there), as the helper reaches it.
    const hold = () => inPage(page, () => window.pbScreen.hold());
    // Short waits, but with room: on a busy machine (the suite runs many browsers at once) a
    // round trip to the page can take a good part of a second, so the spinner comes 600 ms after
    // the last picture here and the longer wording at 1.8 s, and the test waits for each state
    // rather than for a fixed time.
    await inPage(page, () => { window.pbScreen.holdAfter(600, 1800); window.pbScreen.info({ title: "Shop", url: "https://shop.example", who: "Bob" }); });
    const holdUntil = async (ok) => { for (let i = 0; i < 80; i++) { const h = await hold(); if (ok(h)) return h; await page.waitForTimeout(50); } return hold(); };
    // A picture a frame at a time, as the helper sends them.
    const sendFrame = () => inPage(page, () => {
      const c = document.createElement("canvas"); c.width = 320; c.height = 200;
      const ctx = c.getContext("2d"); ctx.fillStyle = "#4a90d9"; ctx.fillRect(0, 0, 320, 200); ctx.fillStyle = "#fff"; ctx.fillRect(40, 40, 240, 40);
      window.pbScreen.frame(c.toDataURL("image/jpeg").split(",")[1]);
    });
    assert.deepEqual(await hold(), { shown: false, text: "", dimmed: false }, "nothing before the first picture");
    await sendFrame();
    await page.waitForTimeout(80);
    await sendFrame();
    await page.waitForTimeout(80);
    assert.equal((await hold()).shown, false, "nothing while pictures keep coming");
    assert.deepEqual(await holdUntil((h) => h.shown), { shown: true, text: "Reconnecting to Bob…", dimmed: true });
    const style = await page.evaluate(() => { const s = getComputedStyle(document.getElementById("hold")); return { pointer: s.pointerEvents, bg: s.backgroundColor }; });
    assert.equal(style.pointer, "none", "never takes a click from the picture");
    assert.match(style.bg, /rgba\(20, 22, 43, 0\.35\)/, "translucent over the last picture");
    assert.equal(await page.evaluate(() => document.getElementById("still").hidden), false, "the last picture stays");
    await page.screenshot({ path: join(process.env.PAIRBROWSE_TEST_SHOTS || "/tmp", "screen-reconnecting.png") }).catch(() => {});
    assert.equal((await holdUntil((h) => /Still/.test(h.text))).text, "Still reconnecting to Bob…", "longer: said so, in the same words");
    assert.doesNotMatch(await page.evaluate(() => document.body.textContent), /tunnel|cloudflare|pool/i);
    await sendFrame();
    await page.waitForTimeout(80);
    assert.deepEqual(await hold(), { shown: false, text: "Still reconnecting to Bob…", dimmed: false }, "the next picture takes it down");
    // A fresh stop starts the count anew: "Reconnecting", not "Still".
    assert.deepEqual(await holdUntil((h) => h.shown), { shown: true, text: "Reconnecting to Bob…", dimmed: true });
  } finally {
    await browser.close();
  }
});
