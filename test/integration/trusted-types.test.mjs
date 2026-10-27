// Pages that require Trusted Types (YouTube, Google's apps) refuse plain strings as HTML: the page
// script must still draw people's pointers and the agent's cursor there. Needs PAIRBROWSE_TEST_RUNTIME.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { join } from "node:path";
import { ensureHud } from "../helpers/live.mjs";
import { hudScript } from "../../scripts/browser.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;

test("pointers and the agent's cursor show on a page that requires Trusted Types", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html", "content-security-policy": "require-trusted-types-for 'script'" });
    res.end("<title>tt</title><body style='height:3000px'>page</body>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ headless: true });
  try {
    const { source, name, token, tags } = hudScript();
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript({ content: source });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await ensureHud(page, source, name);
    const drawn = await page.evaluate(([n, t, cursorTag]) => {
      window[n](t, JSON.stringify([{ k: "a", who: "Nev", color: "#e9763f", x: 100, y: 100 }]), "cursors");
      window[n](t, JSON.stringify({ x: 50, y: 50, act: "click" }), "cursor");
      return document.querySelectorAll(cursorTag).length;
    }, [name, token, tags.cursor]);
    assert.ok(drawn >= 2, `the pointer and the cursor are drawn (${drawn})`);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});

// A page whose content security policy allows no inline styles (style-src without 'unsafe-inline',
// as Google's reCAPTCHA demo sends) dropped the HUD's <style> elements: the bar showed as plain
// text in the page and the badge's spark at full size. Its shadow roots' CSS now goes in as
// constructed stylesheets: the bar sits fixed at the bottom across the window, the badge fixed at
// the bottom right, small, also under Trusted Types.
test("the bar and the badge keep their styles on a page whose CSP allows no inline styles", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html", "content-security-policy": "style-src 'self' https://www.gstatic.com; require-trusted-types-for 'script'; object-src 'none'" });
    res.end("<title>strict</title><body style='height:3000px'><p>page</p></body>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ headless: true });
  try {
    const { source, name, token, tags } = hudScript();
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript({ content: source });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await ensureHud(page, source, name);
    const got = await page.evaluate(([n, t, barTag, hudTag]) => {
      window[n](t, JSON.stringify({ items: [{ t: Date.now(), text: "Clicked **Next**", who: "" }] }), "bar");
      window[n](t, "Claude is driving", "claude");
      const box = (tag) => { const el = document.querySelector(tag); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), pos: getComputedStyle(el).position }; };
      return { bar: box(barTag), badge: box(hudTag), vw: innerWidth, vh: innerHeight };
    }, [name, token, tags.bar, tags.hud]);
    assert.ok(got.bar && got.bar.pos === "fixed" && got.bar.w === got.vw && got.bar.y + got.bar.h === got.vh, `the bar is fixed at the bottom across the window: ${JSON.stringify(got)}`);
    assert.ok(got.bar.h <= 40, `the bar is one thin line: ${JSON.stringify(got.bar)}`);
    assert.ok(got.badge && got.badge.pos === "fixed" && got.badge.x + got.badge.w <= got.vw && got.badge.w < 500 && got.badge.h < 80, `the badge is small, fixed at the bottom right: ${JSON.stringify(got.badge)}`);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
