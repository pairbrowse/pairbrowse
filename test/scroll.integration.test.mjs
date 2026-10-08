// Fast mode's scroll step: the page glides down with the agent's cursor on it, and the agent's
// wheel never counts as a person scrolling. Needs PAIRBROWSE_TEST_RUNTIME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { join } from "node:path";
import { ensureHud } from "./live.mjs";
import { hudScript } from "../scripts/browser.mjs";
import { runSteps, preflight } from "../scripts/runner.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;

test("scroll step: smooth, with the agent's cursor, never taken for a person", { skip: !runtime, timeout: 60_000 }, async () => {
  assert.match(preflight([{ scroll: "sideways" }]), /scroll takes "down", "up" or a number/);
  assert.equal(preflight([{ scroll: "down" }, { scroll: -300 }]), null);
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const server = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<title>long</title><body style='height:5000px'>top</body>"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ headless: true });
  try {
    const { source, name, token, tags } = hudScript();
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.addInitScript({ content: source });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await ensureHud(page, source, name);
    const said = [];
    const hooks = {
      activity: (t) => said.push(t),
      cursor: async (el, act) => { const b = await el.boundingBox(); await page.evaluate(([n, t, c]) => window[n](t, c, "cursor"), [name, token, JSON.stringify({ x: b.x, y: b.y, act })]); },
    };
    const started = Date.now();
    const r = await runSteps(page, [{ scroll: "down" }], { ...hooks, smooth: true });
    const took = Date.now() - started;
    assert.ok(took < 450, `a screen glides by quickly (${took} ms)`);
    assert.ok(r.ok !== false, JSON.stringify(r));
    const after = await page.evaluate(() => scrollY);
    assert.ok(after > 400 && after < 700, `about a screen down (${after})`);
    assert.deepEqual(said, ["Scrolled down"]);
    said.length = 0;
    assert.ok(await page.evaluate((tag) => document.querySelectorAll(tag).length, tags.cursor) >= 1, "the cursor shows");
    // The pairbrowse_scroll way: smooth, and the engine's human-like input stays as it was.
    page._pairbrowseHumanized = true;
    let during = null;
    const smooth = await runSteps(page, [{ scroll: -200 }], { ...hooks, smooth: true, cursor: async (el, act) => { during = page._pairbrowseHumanized; await hooks.cursor(el, act); } });
    assert.ok(smooth.ok !== false, JSON.stringify(smooth));
    assert.equal(during, true, "a single scroll keeps human-like input");
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - (after - 200)) <= 2, "200 px back up");
    // Fast mode: human-like input off for the run, back on after.
    await runSteps(page, [{ scroll: 100 }], { ...hooks, cursor: async (el, act) => { during = page._pairbrowseHumanized; await hooks.cursor(el, act); } });
    assert.equal(during, false, "fast mode skips it");
    assert.equal(page._pairbrowseHumanized, true, "and puts it back");
    const user = await page.evaluate(([n, t]) => window[n](t, "", "user"), [name, token]);
    assert.ok(!user.some((e) => e.kind === "wheel"), `the agent's wheel isn't a person's: ${JSON.stringify(user)}`);
  } finally {
    await browser.close();
    server.close();
  }
});
