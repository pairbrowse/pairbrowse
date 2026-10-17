// Phishing protection in a real browser (PAIRBROWSE_TEST_RUNTIME): a listed site's page never
// shows, the warning does; its Continue anyway reaches the site; another site loads as it is.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPhishing } from "../../scripts/daemon/phishing.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;

test("a listed site is stopped before it shows; Continue anyway reaches it", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const file = join(mkdtempSync(join(tmpdir(), "phish-")), "p.txt");
  writeFileSync(file, [...Array.from({ length: 1200 }, (_, i) => `f${i}.example`), "evil.pbtest.example"].join("\n"));
  const phishing = createPhishing({ file });
  phishing.load();
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    let served = 0;
    await ctx.route("http://*.pbtest.example/**", (r) => { served++; return r.fulfill({ status: 200, contentType: "text/html", body: "<title>Site</title><p>the site" }); });
    phishing.watch(ctx);
    const page = await ctx.newPage();
    await page.goto("http://good.pbtest.example/").catch(() => {});
    assert.equal(await page.title(), "Site");
    page.goto("http://evil.pbtest.example/login").catch(() => {});
    await page.waitForFunction(() => document.title === "Deceptive site ahead", undefined, { timeout: 10_000 });
    assert.match(page.url(), /^data:text\/html/);
    await page.getByText("Continue anyway").click();
    await page.waitForFunction(() => document.title === "Site", undefined, { timeout: 10_000 });
    assert.equal(new URL(page.url()).hostname, "evil.pbtest.example");
    await page.goBack().catch(() => {});
    assert.ok(served >= 2);
  } finally { await browser.close(); }
});
