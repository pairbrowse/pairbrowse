// The hand-off viewer on a phone (scripts/liveview-turn.js; spec server-mode B8): the landing page
// and the viewer in the runtime's browser on a 390x844 touch screen (isMobile, hasTouch), against
// the real live view server with a grant table and fake tabs whose CDP sessions record what would
// reach the page. A tap clicks, a drag scrolls, a hold stays pressed, zoom stays on the phone, the
// type box passes each character on and keeps nothing, one input POST is out at a time, and a
// dropped connection loses and repeats nothing. The browser tests skip without
// PAIRBROWSE_TEST_RUNTIME; the file checks run everywhere.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLiveView, createInvites } from "../scripts/liveview.mjs";
import { createGrants } from "../scripts/daemon/grants.mjs";
import { createAudit } from "../scripts/daemon/audit.mjs";
import { patchright } from "./helpers/live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME?.replace(/^~/, process.env.HOME);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(25)) if (await fn()) return true; return false; };
const scriptFile = (name) => readFileSync(new URL(`../scripts/${name}`, import.meta.url), "utf8");
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const FRAME = { w: 1280, h: 800 };
// A 1x1 picture: the page's frames (the viewer sizes the picture from the frame's w and h).
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// ---- the files (no browser) ----

test("liveview-turn.js is in ASSETS and loaded by liveview.js for role turn alone, before its stream opens", async () => {
  const { ASSET_FILES } = await import("../scripts/liveview/http.mjs");
  assert.equal(ASSET_FILES["liveview-turn.js"], "liveview-turn.js");
  const lv = scriptFile("liveview.js");
  assert.equal(lv.split('import("./liveview-turn.js")').length - 1, 1, "one same-origin dynamic import");
  assert.match(lv, /const turnView = role === "turn";/);
  assert.match(lv, /if \(turnView\) \{\s*import\("\.\/liveview-turn\.js"\)[\s\S]*?openStream\(\); \}\)[\s\S]*?\} else openStream\(\);/, "the stream opens once the turn viewer listens");
  const turn = scriptFile("liveview-turn.js");
  assert.doesNotMatch(turn, /localStorage|sessionStorage|indexedDB|document\.cookie/, "the type box and the viewer keep nothing");
  assert.doesNotMatch(turn, /\.value\s*=(?!\s*""|=)/, "the type box is only ever emptied");
  assert.doesNotMatch(turn, /innerHTML|insertAdjacentHTML|eval\(|new Function/);
});

// ---- the page in a phone's browser ----

// Tabs whose CDP sessions record each call and when, with an opener each (for pop-ups).
function fakeTabs(urls) {
  const sessions = [];
  const ctx = Object.assign(new EventEmitter(), { pages: () => pages, newPage: async () => { throw new Error("no new tabs here"); } });
  const tab = (url, opener = null) => {
    const p = Object.assign(new EventEmitter(), {
      url: () => url, title: async () => `Title of ${url}`, context: () => ctx, bringToFront: async () => {}, evaluate: async () => null,
      opener: async () => opener, isClosed: () => !pages.includes(p),
    });
    return p;
  };
  const pages = urls.map((u) => tab(u));
  let slow = 0; // ms each input dispatch takes (the page busy)
  ctx.newCDPSession = async (page) => {
    const cdp = Object.assign(new EventEmitter(), { calls: [], page });
    cdp.send = async (method, params) => {
      cdp.calls.push({ method, params, at: Date.now() });
      if (slow && method.startsWith("Input.dispatch")) await wait(slow);
      return method === "Page.captureScreenshot" ? { data: PIXEL } : {};
    };
    cdp.detach = async () => {};
    sessions.push(cdp);
    return cdp;
  };
  const open = (url, opener) => { const p = tab(url, opener); pages.push(p); ctx.emit("page", p); return p; };
  // Every input call that reached any tab, in order.
  const input = () => sessions.flatMap((s) => s.calls).filter((c) => c.method.startsWith("Input.dispatch")).sort((a, b) => a.at - b.at);
  return { ctx, pages, sessions, open, input, setSlow: (ms) => { slow = ms; } };
}

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...(body ? { "content-type": "application/json" } : {}) } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// The phone's link: a loopback relay in front of the live view. cut(true) drops every
// connection through it and refuses new ones, as a phone losing its signal does (the browser's own
// offline switch fails new requests but leaves an open stream alone); cut(false) lets them through.
async function relay(port) {
  const socks = new Set();
  let down = false;
  const server = net.createServer((a) => {
    if (down) return a.destroy();
    const b = net.connect(port, "127.0.0.1");
    for (const [x, y] of [[a, b], [b, a]]) { socks.add(x); x.on("error", () => {}); x.on("close", () => { socks.delete(x); y.destroy(); }); x.pipe(y); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    cut(on) { down = on; if (on) for (const x of socks) x.destroy(); },
    close: () => { for (const x of socks) x.destroy(); server.close(); },
  };
}

// A live view with a grant on the first tab (a payment on shop.example), frames flowing from
// whichever tab is shown, and a phone in the runtime's browser.
async function phone(t, { action = "payment" } = {}) {
  const tabs = fakeTabs(["https://shop.example/pay", "https://other.example/"]);
  const audit = createAudit({ file: join(mkdtempSync(join(tmpdir(), "pb-lvmobile-")), "audit.jsonl") });
  const grants = createGrants({ audit });
  const invites = createInvites();
  const view = await startLiveView({ getContext: async () => tabs.ctx, currentUrl: async () => tabs.pages[1].url(), invites, grants, covers: { want: () => {}, picture: async (_p, img) => img } });
  view.setSession({ name: "default", where: "Local" });
  const g = grants.mint({ session: "default", page: tabs.pages[0], action });
  const frames = setInterval(() => {
    const s = tabs.sessions.at(-1);
    s?.emit("Page.screencastFrame", { data: PIXEL, metadata: { deviceWidth: FRAME.w, deviceHeight: FRAME.h }, sessionId: 1 });
  }, 150);
  const link = await relay(view.port);
  const browser = await patchright(runtime).chromium.launch();
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  t.after(async () => { clearInterval(frames); await browser.close().catch(() => {}); link.close(); view.close(); });
  // Opens the link and takes over: the viewer, live, with its first picture.
  const takeOver = async () => {
    await page.goto(`http://127.0.0.1:${link.port}/${g.redeemKey}/`);
    await page.tap("#take");
    await page.waitForURL(/\/[0-9a-f]{64}\/$/);
    await page.waitForSelector('#turn-conn[data-s="live"]');
    await page.waitForSelector("#screen:not([hidden])");
    await until(() => page.evaluate(() => document.getElementById("screen").getBoundingClientRect().width > 100));
  };
  // Where a page point is on the phone's screen now (zoom included).
  const at = (x, y) => page.evaluate(([x, y, w, h]) => { const r = document.getElementById("screen").getBoundingClientRect(); return { x: r.left + (x * r.width) / w, y: r.top + (y * r.height) / h }; }, [x, y, FRAME.w, FRAME.h]);
  const cdp = await context.newCDPSession(page);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })) });
  // Runs in the page's own world (a page.evaluate runs in an isolated one: what it defines there the page never sees).
  const inPage = (expression) => cdp.send("Runtime.evaluate", { expression });
  return { ...tabs, view, grants, g, browser, context, page, errors, takeOver, at, touch, inPage, cut: link.cut };
}

const mouseCalls = (calls) => calls.filter((c) => c.method === "Input.dispatchMouseEvent");
const typedIn = (calls) => calls.filter((c) => c.method === "Input.dispatchKeyEvent" && c.params.type === "keyDown" && c.params.text).map((c) => c.params.text).join("");

test("landing page and Take over fit the screen with no horizontal scroll", { skip: !runtime, timeout: 60_000 }, async (t) => {
  const s = await phone(t);
  await s.page.goto(`http://127.0.0.1:${s.view.port}/${s.g.redeemKey}/`);
  const fits = () => s.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  assert.ok(await fits(), "the landing page");
  const take = await s.page.locator("#take").boundingBox();
  assert.ok(take.x >= 0 && take.x + take.width <= 390 && take.height >= 44, "Take over is on screen, a finger's size");
  await s.takeOver();
  assert.ok(await fits(), "the viewer");
  assert.equal(await s.page.evaluate(() => document.body.dataset.role), "turn");
  for (const sel of ["#turnbar", "#turn-done", "#type-box", "#zoom-in", "#zoom-out", "#stage"]) {
    const b = await s.page.locator(sel).boundingBox();
    assert.ok(b && b.x >= 0 && b.x + b.width <= 390.5 && b.y >= 0 && b.y + b.height <= 844.5, `${sel} is on screen`);
  }
  for (const sel of [".side", ".strip", ".toolbar", ".activity"]) assert.equal(await s.page.isVisible(sel), false, `${sel} is the desktop's`);
  // The header: the step's kind, its site, the time left, the connection.
  assert.match(await s.page.textContent("#turn-step"), /^Payment · shop\.example$/);
  assert.match(await s.page.textContent("#turn-left"), /^1[45]:\d\d left$/);
  assert.equal(await s.page.textContent("#turn-conn"), "Live");
  assert.equal(await s.page.isVisible("#turn-tabs"), false, "one tab: no switcher");
  assert.deepEqual(s.errors, []);
});

test("tap posts mouse press and release; drag posts wheel; a hold stays pressed; zoom keeps a click on the same page point", { skip: !runtime, timeout: 60_000 }, async (t) => {
  const s = await phone(t);
  await s.takeOver();
  // A tap: moved, pressed, released at the tap's page point.
  const p = await s.at(640, 400);
  await s.page.touchscreen.tap(p.x, p.y);
  assert.ok(await until(() => mouseCalls(s.input()).length >= 3));
  const tap = mouseCalls(s.input()).map((c) => c.params);
  assert.deepEqual(tap.map((c) => c.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  for (const c of tap) { assert.ok(Math.abs(c.x - 640) <= 4 && Math.abs(c.y - 400) <= 4, `${c.type} at ${c.x},${c.y}`); }
  assert.equal(tap[1].button, "left");
  // A drag: wheel at the start point, the page moving with the finger (a drag up scrolls down).
  const before = s.input().length;
  await s.touch("touchStart", [p]);
  for (let i = 1; i <= 6; i++) { await s.touch("touchMove", [{ x: p.x, y: p.y - i * 15 }]); await wait(20); }
  await s.touch("touchEnd", []);
  assert.ok(await until(() => s.input().slice(before).some((c) => c.params.type === "mouseWheel")));
  const drag = s.input().slice(before);
  assert.equal(drag.filter((c) => /mouse(Pressed|Released)/.test(c.params.type)).length, 0, "a drag never clicks");
  const dy = drag.filter((c) => c.params.type === "mouseWheel").reduce((n, c) => n + c.params.deltaY, 0);
  assert.ok(dy > 0, `scrolled down by ${dy}`);
  // A hold: pressed while the finger stays, released when it lifts.
  const h0 = s.input().length;
  await s.touch("touchStart", [p]);
  await wait(1000);
  await s.touch("touchEnd", []);
  assert.ok(await until(() => s.input().slice(h0).some((c) => c.params.type === "mouseReleased")));
  const hold = s.input().slice(h0).filter((c) => /mouse(Pressed|Released)/.test(c.params.type));
  assert.deepEqual(hold.map((c) => c.params.type), ["mousePressed", "mouseReleased"]);
  assert.ok(hold[1].at - hold[0].at >= 700, `held ${hold[1].at - hold[0].at} ms`);
  // Zoom on the phone: + scales the picture, and a tap on the same page point lands there.
  await s.page.tap("#zoom-in");
  await s.page.tap("#zoom-in");
  assert.equal(await s.page.textContent("#zoom-level"), "2.3x");
  const z0 = s.input().length;
  const q = await s.at(640, 400);
  await s.page.touchscreen.tap(q.x, q.y);
  assert.ok(await until(() => mouseCalls(s.input().slice(z0)).length >= 3));
  for (const c of mouseCalls(s.input().slice(z0))) assert.ok(Math.abs(c.params.x - 640) <= 2 && Math.abs(c.params.y - 400) <= 2, `zoomed ${c.params.type} at ${c.params.x},${c.params.y}`);
  // A pinch out zooms in further; the page itself was never resized.
  const mid = { x: 195, y: 400 };
  await s.touch("touchStart", [{ x: mid.x - 20, y: mid.y }, { x: mid.x + 20, y: mid.y }]);
  for (let i = 1; i <= 5; i++) await s.touch("touchMove", [{ x: mid.x - 20 - i * 10, y: mid.y }, { x: mid.x + 20 + i * 10, y: mid.y }]);
  await s.touch("touchEnd", []);
  assert.equal(await s.page.textContent("#zoom-level"), "4x", "pinched to the most");
  assert.equal(s.sessions.flatMap((c) => c.calls).some((c) => c.method === "Emulation.setDeviceMetricsOverride"), false, "no resize on the page");
  await s.page.tap("#zoom-level");
  assert.equal(await s.page.textContent("#zoom-level"), "1x");
  assert.deepEqual(s.errors, []);
});

test("the type box opens the keyboard path and a six-digit code reaches the page; Backspace, Enter and a composition map, and the box stays empty", { skip: !runtime, timeout: 60_000 }, async (t) => {
  const s = await phone(t);
  await s.takeOver();
  const box = await s.page.locator("#type-box").boundingBox();
  await s.page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  assert.equal(await s.page.evaluate(() => document.activeElement.id), "type-box", "the box has focus: the phone's keyboard opens");
  assert.equal(await s.page.getAttribute("#type-box", "autocomplete"), "off");
  assert.equal(await s.page.getAttribute("#type-box", "enterkeyhint"), "done");
  await s.page.keyboard.type("482913");
  assert.ok(await until(() => typedIn(s.input()) === "482913"), typedIn(s.input()));
  assert.equal(await s.page.inputValue("#type-box"), "", "the box keeps nothing");
  // One key press per digit, each down then up, never a paste.
  const keys = s.input().filter((c) => c.method === "Input.dispatchKeyEvent");
  assert.deepEqual(keys.map((c) => c.params.type), Array(6).fill(["keyDown", "keyUp"]).flat());
  assert.equal(keys.every((c) => !c.params.modifiers), true);
  assert.equal(s.input().some((c) => c.method === "Input.insertText"), false);
  await s.page.keyboard.press("Backspace");
  await s.page.keyboard.press("Enter");
  assert.ok(await until(() => s.input().some((c) => c.params.key === "Enter")));
  const named = s.input().filter((c) => c.method === "Input.dispatchKeyEvent" && ["Backspace", "Enter"].includes(c.params.key) && c.params.type !== "keyUp").map((c) => c.params.key);
  assert.deepEqual(named, ["Backspace", "Enter"]);
  // A keyboard's composed word (suggestions, accents): sent once, when it ends.
  const n0 = s.input().length;
  await s.page.evaluate(() => {
    const b = document.getElementById("type-box");
    b.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    b.value = "ok";
    b.dispatchEvent(new InputEvent("input", { inputType: "insertCompositionText", data: "ok", isComposing: true }));
    b.dispatchEvent(new CompositionEvent("compositionend", { data: "ok" }));
    b.dispatchEvent(new InputEvent("input", { inputType: "insertCompositionText", data: "ok" }));
  });
  assert.ok(await until(() => typedIn(s.input().slice(n0)) === "ok"));
  await wait(300);
  assert.equal(typedIn(s.input().slice(n0)), "ok", "sent once");
  assert.equal(await s.page.inputValue("#type-box"), "");
  // A long insert (a pasted phrase) goes as one text event.
  await s.page.evaluate(() => document.getElementById("type-box").dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "a".repeat(40), cancelable: true })));
  assert.ok(await until(() => s.sessions.flatMap((c) => c.calls).some((c) => c.method === "Input.insertText" && c.params.text === "a".repeat(40))));
  assert.deepEqual(s.errors, []);
});

test("one POST in flight with presses in order", { skip: !runtime, timeout: 60_000 }, async (t) => {
  const s = await phone(t);
  await s.takeOver();
  s.setSlow(60); // each dispatched event takes the page 60 ms: answers come late
  let open = 0, most = 0, posts = 0;
  s.page.on("request", (r) => { if (r.method() === "POST" && /\/input\?/.test(r.url())) { open++; posts++; most = Math.max(most, open); } });
  const done = (r) => { if (r.method() === "POST" && /\/input\?/.test(r.url())) open--; };
  s.page.on("requestfinished", done);
  s.page.on("requestfailed", done);
  const pts = [[200, 200], [400, 300], [600, 400], [800, 500], [1000, 600]];
  for (const [x, y] of pts) { const p = await s.at(x, y); await s.page.touchscreen.tap(p.x, p.y); await wait(110); } // past a double tap's reach
  await s.page.tap("#type-box");
  await s.page.keyboard.type("1234");
  assert.ok(await until(() => typedIn(s.input()) === "1234", 15_000), typedIn(s.input()));
  assert.equal(most, 1, "never two input POSTs at once");
  assert.ok(posts < pts.length * 3 + 4, `events went together while a POST was out (${posts} POSTs)`);
  const order = mouseCalls(s.input()).filter((c) => c.params.type !== "mouseMoved").map((c) => `${c.params.type === "mousePressed" ? "P" : "R"}${Math.round(c.params.x / 100)}`);
  assert.deepEqual(order, pts.flatMap(([x]) => [`P${x / 100}`, `R${x / 100}`]), "every press and release, in order");
  assert.deepEqual(s.errors, []);
});

test("setOffline for 20 s then back: the stream reconnects with the same view key and input resumes, nothing typed is lost or repeated", { skip: !runtime, timeout: 90_000 }, async (t) => {
  const s = await phone(t);
  await s.takeOver();
  const url = s.page.url();
  await s.page.tap("#type-box");
  await s.page.keyboard.type("12");
  assert.ok(await until(() => typedIn(s.input()) === "12"));
  await s.context.setOffline(true);
  s.cut(true);
  await s.page.keyboard.type("34");
  const lost = Date.now();
  assert.ok(await until(() => s.page.evaluate(() => document.getElementById("turn-conn").dataset.s === "reconnecting"), 10_000), "the phone sees the connection drop");
  assert.ok(await until(() => !s.grants.open()[0]?.streaming, 10_000), "the helper lets the dropped stream go");
  await wait(20_000 - (Date.now() - lost));
  assert.equal(typedIn(s.input()), "12", "nothing arrives while offline");
  assert.equal(await s.page.inputValue("#type-box"), "", "what waits is not in the box");
  s.cut(false);
  await s.context.setOffline(false);
  assert.ok(await until(() => typedIn(s.input()) === "1234", 15_000), typedIn(s.input()));
  assert.ok(await until(() => s.page.evaluate(() => document.getElementById("turn-conn").dataset.s === "live"), 15_000), "the stream is back");
  assert.ok(await until(() => s.grants.open()[0]?.streaming), "the same view key holds the stream again");
  assert.equal(s.page.url(), url, "no new link was needed");
  await s.page.keyboard.type("56");
  assert.ok(await until(() => typedIn(s.input()) === "123456"), typedIn(s.input()));
  await wait(1500);
  assert.equal(typedIn(s.input()), "123456", "nothing repeated");
  assert.deepEqual(s.errors, []);
});

test("a pop-up joins the switcher; Done ends the hand-off and the viewer stops", { skip: !runtime, timeout: 60_000 }, async (t) => {
  const s = await phone(t);
  await s.takeOver();
  s.open("https://pay.example/3ds", s.pages[0]); // a 3-D Secure pop-up the handed-over tab opened
  await s.page.waitForSelector("#turn-tabs", { state: "visible" });
  assert.equal(await s.page.locator("#turn-tabs option").count(), 2);
  const popup = await s.page.evaluate(() => [...document.querySelectorAll("#turn-tabs option")].find((o) => /pay\.example/.test(o.textContent)).value);
  await s.page.selectOption("#turn-tabs", popup);
  assert.ok(await until(() => s.sessions.at(-1)?.page === s.pages[2]), "the pop-up is on screen");
  await s.page.tap("#turn-done");
  assert.ok(await until(() => s.grants.open().length === 0), "the grant ended");
  await s.page.waitForSelector('#turn-conn[data-s="closed"]');
  assert.equal(await s.page.isDisabled("#type-box"), true);
  assert.match(await s.page.textContent("#overlay-title"), /This hand-off ended/);
  assert.deepEqual(s.errors, []);
});

// A turn viewer's batch sent again after a lost answer: answered, never replayed twice (no browser).
test("a batch sent again with the same run and number is answered and not replayed", async () => {
  const tabs = fakeTabs(["https://shop.example/pay"]);
  const audit = createAudit({ file: join(mkdtempSync(join(tmpdir(), "pb-lvmobile-")), "audit.jsonl") });
  const grants = createGrants({ audit });
  const view = await startLiveView({ getContext: async () => tabs.ctx, currentUrl: async () => tabs.pages[0].url(), invites: createInvites(), grants });
  view.setSession({ name: "default", where: "Local" });
  const sse = [];
  try {
    const g = grants.mint({ session: "default", page: tabs.pages[0], action: "2fa" });
    const viewKey = JSON.parse((await request(view.port, "POST", `/${g.redeemKey}/redeem`, {})).text).view.slice(1, -1);
    // The stream puts the grant's tab on screen.
    let text = "";
    await new Promise((resolve) => { const req = http.get({ host: "127.0.0.1", port: view.port, path: `/${viewKey}/events` }, (res) => { res.setEncoding("utf8"); res.on("data", (d) => (text += d)); resolve(); }); sse.push(req); });
    assert.ok(await until(() => /event: turn\ndata: [^\n]*"state":"on"/.test(text)));
    const post = (q, text) => request(view.port, "POST", `/${viewKey}/input${q}`, [{ type: "char", text, modifiers: 0 }]);
    const run = "0123456789abcdef";
    assert.equal((await post(`?run=${run}&seq=1`, "7")).status, 204);
    assert.equal((await post(`?run=${run}&seq=1`, "7")).status, 204, "the same batch again: answered");
    assert.equal((await post(`?run=${run}&seq=2`, "8")).status, 204);
    assert.equal((await post(`?run=${run}&seq=2`, "8")).status, 204);
    // A reload of the viewer is a new run: its first batch counts.
    assert.equal((await post("?run=fedcba9876543210&seq=1", "9")).status, 204);
    // Without a run (or a bad one) every batch is fresh.
    assert.equal((await post("", "0")).status, 204);
    assert.equal((await post("?run=xyz&seq=1", "0")).status, 204);
    assert.ok(await until(() => typedIn(tabs.input()) === "78900"));
    await wait(100);
    assert.equal(typedIn(tabs.input()), "78900", "each batch replayed once");
  } finally { for (const r of sse) r.destroy(); view.close(); }
});

// A batch whose replay failed (the helper answered 500) is replayed when it comes again; two pages
// on one view key keep their own numbers (no browser).
test("a batch that failed with 500 is replayed when sent again; two runs on one key never mix", async () => {
  const tabs = fakeTabs(["https://shop.example/pay"]);
  const audit = createAudit({ file: join(mkdtempSync(join(tmpdir(), "pb-lvmobile-")), "audit.jsonl") });
  const grants = createGrants({ audit });
  let fail = 1; // the first replay throws, as a helper failing mid-request does
  const onHumanInput = () => { if (fail-- > 0) throw new Error("helper failed"); };
  const view = await startLiveView({ getContext: async () => tabs.ctx, currentUrl: async () => tabs.pages[0].url(), invites: createInvites(), grants, onHumanInput });
  view.setSession({ name: "default", where: "Local" });
  const sse = [];
  try {
    const g = grants.mint({ session: "default", page: tabs.pages[0], action: "2fa" });
    const viewKey = JSON.parse((await request(view.port, "POST", `/${g.redeemKey}/redeem`, {})).text).view.slice(1, -1);
    let text = "";
    await new Promise((resolve) => { const req = http.get({ host: "127.0.0.1", port: view.port, path: `/${viewKey}/events` }, (res) => { res.setEncoding("utf8"); res.on("data", (d) => (text += d)); resolve(); }); sse.push(req); });
    assert.ok(await until(() => /event: turn\ndata: [^\n]*"state":"on"/.test(text)));
    const post = (q, text) => request(view.port, "POST", `/${viewKey}/input${q}`, [{ type: "char", text, modifiers: 0 }]);
    const a = "aaaaaaaaaaaaaaaa", b = "bbbbbbbbbbbbbbbb";
    assert.equal((await post(`?run=${a}&seq=1`, "1")).status, 500, "the helper failed");
    assert.equal(typedIn(tabs.input()), "", "nothing replayed");
    assert.equal((await post(`?run=${a}&seq=1`, "1")).status, 204, "sent again unchanged");
    assert.ok(await until(() => typedIn(tabs.input()) === "1"), "and replayed this time");
    // Page B posts between page A's batch and its lost-answer repeat: A's repeat is still known.
    assert.equal((await post(`?run=${a}&seq=2`, "2")).status, 204);
    assert.equal((await post(`?run=${b}&seq=1`, "3")).status, 204);
    assert.equal((await post(`?run=${a}&seq=2`, "2")).status, 204);
    assert.equal((await post(`?run=${b}&seq=1`, "3")).status, 204);
    assert.ok(await until(() => typedIn(tabs.input()) === "123"));
    await wait(100);
    assert.equal(typedIn(tabs.input()), "123", "each batch replayed once");
  } finally { for (const r of sse) r.destroy(); view.close(); }
});

test("hidden for a while then shown: the viewer says it reconnects and holds input until the turn event", { skip: !runtime, timeout: 60_000 }, async (t) => {
  const s = await phone(t);
  await s.takeOver();
  await s.page.tap("#type-box");
  // The person switches to their messages app for the code: the page hidden past the 3 s close.
  await s.inPage(`Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));`);
  assert.ok(await until(() => s.page.evaluate(() => document.getElementById("turn-conn").dataset.s === "reconnecting"), 6000), "the header no longer says Live");
  assert.ok(await until(() => !s.grants.open()[0]?.streaming, 6000), "the stream closed");
  await s.page.keyboard.type("42");
  await wait(500);
  assert.equal(typedIn(s.input()), "", "nothing goes out before the stream and its turn event are back");
  await s.inPage(`delete document.hidden; delete document.visibilityState; document.dispatchEvent(new Event("visibilitychange"));`);
  assert.ok(await until(() => typedIn(s.input()) === "42", 10_000), typedIn(s.input()));
  assert.equal(await s.page.textContent("#turn-conn"), "Live");
  assert.equal(await s.page.isVisible("#turn-away"), false, "no 'That tab isn't on screen'");
  await wait(500);
  assert.equal(typedIn(s.input()), "42", "nothing repeated");
  assert.deepEqual(s.errors, []);
});

test("a mouse press whose gesture is cancelled comes up where it last was", { skip: !runtime, timeout: 60_000 }, async (t) => {
  const s = await phone(t);
  await s.takeOver();
  const p = await s.at(300, 300), q = await s.at(500, 400);
  await s.page.mouse.move(p.x, p.y);
  await s.page.mouse.down();
  await s.page.mouse.move(q.x, q.y, { steps: 3 });
  // The browser takes the gesture away (a system gesture, the pointer lost): pointercancel, no up.
  await s.page.evaluate(() => document.getElementById("stage").dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, pointerType: "mouse", bubbles: true })));
  assert.ok(await until(() => mouseCalls(s.input()).some((c) => c.params.type === "mouseReleased")), "the press came up");
  const up = mouseCalls(s.input()).find((c) => c.params.type === "mouseReleased").params;
  assert.ok(Math.abs(up.x - 500) <= 4 && Math.abs(up.y - 400) <= 4, `released at ${up.x},${up.y}`);
  await s.page.mouse.up();
  assert.deepEqual(s.errors, []);
});
