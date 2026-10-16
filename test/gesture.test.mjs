// The helper's reads give a page no user activation (scripts/gesture.mjs): after an evaluate, a
// snapshot, fast mode's outline read and a locator read the page has never been activated (the
// browser's popup blocker and every activation-gated API read just that), while a real click
// still activates it. Live part: PAIRBROWSE_TEST_RUNTIME, headless (a headless browser has no
// popup blocker, so activation itself is what is checked).
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { readParams, patchSend, installNoReadGesture } from "../scripts/gesture.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;

test("a function call goes without the user gesture; every other call as it was", () => {
  assert.deepEqual(readParams("Runtime.callFunctionOn", { functionDeclaration: "f", userGesture: true }), { functionDeclaration: "f", userGesture: false });
  const p = { functionDeclaration: "f" };
  assert.equal(readParams("Runtime.callFunctionOn", p), p);
  const input = { type: "mousePressed", userGesture: true };
  assert.equal(readParams("Input.dispatchMouseEvent", input), input, "real input is untouched");
  assert.equal(readParams("Runtime.callFunctionOn", undefined), undefined);
  const sent = [];
  class Session { send(method, params) { sent.push([method, params]); return Promise.resolve(); } }
  assert.equal(patchSend(Session.prototype), true);
  assert.equal(patchSend(Session.prototype), false, "wrapped once");
  new Session().send("Runtime.callFunctionOn", { userGesture: true });
  assert.deepEqual(sent, [["Runtime.callFunctionOn", { userGesture: false }]]);
  assert.equal(installNoReadGesture({}), false, "no driver to hook into: says so");
});

test("reads give the page no activation; a real click still does", { skip: !runtime, timeout: 60_000 }, async () => {
  const require = createRequire(join(runtime, "package.json"));
  const { chromium } = require("patchright");
  const { outline } = await import("../scripts/runner.mjs");
  const body = `<title>t</title><label>Email <input></label><button onclick="document.title = window.open('about:blank') ? 'opened' : 'blocked'">Open</button>`;
  const activated = async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.route("http://pairbrowse.test/**", (r) => r.fulfill({ contentType: "text/html", body }));
      await page.goto("http://pairbrowse.test/");
      await page.evaluate(() => 1);
      await page.ariaSnapshot({ mode: "ai" });
      await outline(page);
      await page.locator("button").innerText();
      const read = await page.evaluate(() => navigator.userActivation.hasBeenActive);
      await page.click("button");
      return { read, clicked: await page.evaluate(() => navigator.userActivation.hasBeenActive), title: await page.title() };
    } finally {
      await browser.close();
    }
  };
  // The driver as it comes: its reads activate the page (what this guards against).
  assert.equal((await activated()).read, true, "the driver's own reads carry a user gesture");
  assert.equal(installNoReadGesture(require("patchright-core/lib/coreBundle")), true);
  const after = await activated();
  assert.equal(after.read, false, "no activation from the helper's reads");
  assert.equal(after.clicked, true, "a real click activates the page");
  assert.equal(after.title, "opened", "and its popup opens");
});
