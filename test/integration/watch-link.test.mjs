// Watch live by link, live: a real helper and browser make a watch link (the agent's tool and the
// side panel's route), its page opens in another browser on a phone-sized screen through the public
// address (PAIRBROWSE_TEST_TUNNEL=direct: the guest port stands in for the tunnel), shows the agent's
// tab live with the password field covered, and nothing a watcher taps or types reaches the
// browser. The agent can't type the link into a page; Stop all ends it and the page says so.
// Needs PAIRBROWSE_TEST_RUNTIME.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { rmSync } from "node:fs";
import { patchright, session } from "../helpers/live.mjs";
import { sleep, text, until } from "../helpers/util.mjs";
import { helperHome, startHelper } from "../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME?.replace(/^~/, process.env.HOME);
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function startSite() {
  let typed = "";
  const server = http.createServer((req, res) => {
    if (req.method === "POST") { req.on("data", (d) => { typed += d; }); req.on("end", () => { res.writeHead(204); res.end(); }); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Sign in</title><body style="font:16px sans-serif;background:#fff">
      <h1>Sign in</h1><label>Email <input id="email" value="ann@example.com"></label>
      <label>Password <input id="pw" type="password" value="hunter2-secret"></label>
      <textarea id="note"></textarea>
      <script>document.addEventListener("keydown", (e) => fetch("/key", { method: "POST", body: e.key }));
      document.addEventListener("pointerdown", () => fetch("/click", { method: "POST", body: "click" }));</script></body>`);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${server.address().port}`, typed: () => typed, close: () => server.close() })));
}
const post = (url, body) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
    let t = "";
    res.setEncoding("utf8");
    res.on("data", (d) => (t += d));
    res.on("end", () => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(t); } catch { return t; } })() }));
  });
  req.on("error", reject);
  req.end(JSON.stringify(body));
});

test("a watch link, live: made by the agent and the side panel, watched on a phone, view only, never typed into a page, stopped", { skip: !runtime && "set PAIRBROWSE_TEST_RUNTIME", timeout: 240_000 }, async () => {
  const home = helperHome(runtime, { prefix: "pb-watch-", config: { sessionPicker: false } });
  const site = await startSite();
  const helper = await startHelper(home, { env: { PAIRBROWSE_TEST_TUNNEL: "direct" } });
  let browser = null;
  try {
    const agent = await session(helper.socketPath, "w");
    await agent.tool("browser_navigate", { url: `${site.base}/signin` });
    // The agent's watch link (Claude Code's hook asks the user; this client has no hook).
    const made = text(await agent.tool("pairbrowse_invite", { action: "create", share: "watch" }));
    const link = /Link: (http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/)/.exec(made)?.[1];
    assert.ok(link, made);
    assert.match(made, /Anyone who has the link can watch this browser live/);
    // Never typed into a page.
    const typed = await agent.tool("browser_type", { target: "#note", text: `watch here: ${link}` });
    assert.match(text(typed), /one of this session's watch or live view links/);
    // The side panel's Copy watch link: the owner's route.
    const live = /Live view: (http:\/\/127\.0\.0\.1:\d+\/[^/\s]+\/)/.exec(text(await agent.tool("pairbrowse_liveview", { action: "start" })))?.[1];
    assert.ok(live);
    const panel = await post(`${live}invite`, { share: "watch", hours: 0.25 });
    assert.equal(panel.status, 200, JSON.stringify(panel.body));
    assert.equal(panel.body.share, "watch");

    // A phone opens the agent's link.
    browser = await patchright(runtime).chromium.launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: PHONE_UA });
    const page = await context.newPage();
    const errors = [], sent = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("request", (r) => { if (r.method() !== "GET") sent.push(r.url()); });
    await page.goto(link);
    await page.waitForSelector('#watch-conn[data-s="live"]', { timeout: 30_000 });
    await page.waitForSelector("#screen:not([hidden])", { timeout: 30_000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "fits the phone");
    const listed = JSON.parse(await (await fetch(`${live}invites.json`)).text()).items;
    assert.ok(await until("one watching", async () => JSON.parse(await (await fetch(`${live}invites.json`)).text()).items.some((i) => i.share === "watch" && i.watching === 1), 15_000, 200));
    assert.equal(listed.filter((i) => i.share === "watch").length, 2);
    assert.ok(listed.every((i) => !JSON.stringify(i).match(/[0-9a-f]{64}/)), "no key listed");

    // Taps, keys and the wheel reach nothing.
    const box = await page.locator("#screen").boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 3);
    await page.keyboard.type("abc");
    await page.mouse.wheel(0, 300);
    await sleep(800);
    assert.equal(site.typed(), "", "the page in the browser heard nothing");
    assert.deepEqual(sent, [], "the watch page sent nothing");

    // Stop all: the page goes dark and says so.
    const stop = await post(`${live}invite`, { op: "stop_watch" });
    assert.deepEqual([stop.status, stop.body.stopped], [200, 2]);
    await page.waitForFunction(() => document.getElementById("overlay-title").textContent === "This watch link ended", null, { timeout: 15_000 });
    const gone = await fetch(link);
    assert.equal(gone.status, 404);
    assert.match(text(await agent.tool("pairbrowse_invite", { action: "list" })), /^No invites\.$/);
    assert.deepEqual(errors, []);
    agent.sock.destroy();
  } finally {
    await browser?.close().catch(() => {});
    await helper.stop();
    site.close();
    rmSync(home, { recursive: true, force: true });
  }
});
