// Pages that require Trusted Types (YouTube, Google's apps) refuse plain strings as HTML: the page
// script must still draw people's pointers and the agent's cursor there. Needs PAIRBROWSE_TEST_RUNTIME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { join } from "node:path";
import { ensureHud } from "./live.mjs";
import { hudScript } from "../scripts/browser.mjs";

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
