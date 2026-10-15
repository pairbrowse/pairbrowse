// The joiner's picture page (shared browser mode, ui/screen/): what the
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
const ui = join(dirname(fileURLToPath(import.meta.url)), "..", "ui");
const TYPES = { html: "text/html", css: "text/css", js: "text/javascript" };

test("pictures that stop coming show a spinner and 'Reconnecting to Bob…' over the last one, gone with the next picture", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
    // The page as the extension serves it, from its own files.
    await page.route("http://pairbrowse.test/**", (route) => {
      const name = new URL(route.request().url()).pathname.slice(1);
      route.fulfill({ contentType: TYPES[name.split(".").pop()], body: readFileSync(join(ui, name)) });
    });
    await page.goto("http://pairbrowse.test/screen/index.html");
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
    assert.match(style.bg, /rgba\(11, 20, 33, 0\.35\)/, "translucent over the last picture");
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

test("on the slower route the helper's word on the channel drives the wait, never a quiet spell", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
    await page.route("http://pairbrowse.test/**", (route) => {
      const name = new URL(route.request().url()).pathname.slice(1);
      route.fulfill({ contentType: TYPES[name.split(".").pop()], body: readFileSync(join(panel, name)) });
    });
    await page.goto("http://pairbrowse.test/screen.html");
    const hold = () => inPage(page, () => window.pbScreen.hold());
    const holdUntil = async (ok) => { for (let i = 0; i < 80; i++) { const h = await hold(); if (ok(h)) return h; await page.waitForTimeout(50); } return hold(); };
    await inPage(page, () => { window.pbScreen.holdAfter(300, 1000); window.pbScreen.info({ title: "Shop", url: "https://shop.example", who: "Bob" }); });
    const sendFrame = () => inPage(page, () => {
      const c = document.createElement("canvas"); c.width = 320; c.height = 200;
      c.getContext("2d").fillRect(0, 0, 320, 200);
      window.pbScreen.frame(c.toDataURL("image/jpeg").split(",")[1]);
    });
    await sendFrame();
    assert.equal(await inPage(page, () => window.pbScreen.link("up")), true);
    await page.waitForTimeout(1200);
    assert.deepEqual(await hold(), { shown: false, text: "", dimmed: false }, "a quiet host page on a healthy channel: no wait");
    await inPage(page, () => window.pbScreen.link("down"));
    assert.deepEqual(await hold(), { shown: true, text: "Reconnecting to Bob…", dimmed: true }, "the channel down: said at once");
    assert.equal((await holdUntil((h) => /Still/.test(h.text))).text, "Still reconnecting to Bob…", "down for long: said so");
    await inPage(page, () => window.pbScreen.link("up"));
    assert.equal((await hold()).shown, false, "the channel up again: taken down");
    await inPage(page, () => window.pbScreen.link("down"));
    await sendFrame();
    assert.equal((await holdUntil((h) => !h.shown)).shown, false, "a picture takes it down");
    await page.waitForTimeout(800);
    assert.equal((await hold()).shown, false, "and a picture means the channel is up");
    assert.equal(await inPage(page, () => window.pbScreen.link("sideways")), false, "only up or down");
  } finally {
    await browser.close();
  }
});

test("the picture page keeps its ids, its words, its timers and a flat sheet", () => {
  const html = readFileSync(join(ui, "screen/index.html"), "utf8"), css = readFileSync(join(ui, "screen/screen.css"), "utf8"), js = readFileSync(join(ui, "screen/screen.js"), "utf8");
  for (const id of ["v", "still", "pointers", "status", "status-text", "hold", "hold-text", "top", "tag", "tag-text", "who", "who-text", "addr", "addr-state", "addr-text", "addr-host", "addr-rest", "sound", "pick", "pick-text", "pick-go", "pick-no", "pick-input"]) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `#${id}`);
  }
  for (const text of ["Connecting to the shared tab…", "Turn on sound", "The page asks for a file.", "Choose files", "Cancel"]) assert.ok(html.includes(text), text);
  const hold = css.match(/#hold \{([^}]*)\}/)[1];
  assert.ok(hold.includes("rgb(11 20 33 / 0.35)") && hold.includes("pointer-events: none"), "the hold scrim never takes a click");
  for (const text of ["`Reconnecting to ${who}…`", "`Still reconnecting to ${who}…`", "`${host}'s tab · live`", '"Shared tab · live"', "`Connecting to ${host || \"the host\"}'s tab…`"]) assert.ok(js.includes(text), text);
  const n = (w) => js.split(w).length - 1;
  assert.deepEqual([n("setTimeout("), n("setInterval("), n("requestAnimationFrame("), n("Observer")], [2, 1, 1, 0], "no new timer");
  assert.doesNotMatch(css, /backdrop-filter|gradient\(/);
  // B11 allows one endless animation, the Live dot's 2 s pulse; the connecting dot is static and
  // the hold spinner became a warn dot with the words (ui-screen subset).
  assert.equal(css.split("@keyframes").length - 1, 1, "the Live dot's pulse only");
  assert.doesNotMatch(css, /box-shadow: 0 0 0 3px/, "no halo rings");
});

test("who works in the host's tab shows in words on the picture, with a dot in their color", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.route("http://pairbrowse.test/**", (route) => {
      const name = new URL(route.request().url()).pathname.slice(1);
      route.fulfill({ contentType: TYPES[name.split(".").pop()], body: readFileSync(join(ui, name)) });
    });
    await page.goto("http://pairbrowse.test/screen/index.html");
    await inPage(page, () => {
      window.pbScreen.info({ title: "Shop", url: "https://shop.example/cart", who: "Bob" });
      const c = document.createElement("canvas"); c.width = 320; c.height = 200;
      c.getContext("2d").fillRect(0, 0, 320, 200);
      window.pbScreen.frame(c.toDataURL("image/jpeg").split(",")[1]);
    });
    for (let i = 0; i < 60 && !(await inPage(page, () => window.pbScreen.state().view === "frames")); i++) await page.waitForTimeout(50);
    const pill = () => inPage(page, () => window.pbScreen.whoPill());
    const dot = () => page.evaluate(() => getComputedStyle(document.querySelector("#who .dot")).backgroundColor);
    assert.deepEqual(await pill(), { shown: false, text: "" }, "nobody yet");
    await inPage(page, () => window.pbScreen.who({ person: "Sam", personColor: "#2fb6d9" }));
    assert.deepEqual(await pill(), { shown: true, text: "Sam is in this tab" });
    assert.equal(await dot(), "rgb(47, 182, 217)");
    assert.equal(await page.evaluate(() => document.getElementById("top").classList.contains("on")), true, "shown with whose tab it is");
    assert.match((await inPage(page, () => window.pbScreen.inTab())).title, /^Sam · Shop$/);
    const box = await page.evaluate(() => { const s = getComputedStyle(document.getElementById("who")); return { h: document.getElementById("who").getBoundingClientRect().height, shadow: s.boxShadow, blur: s.backdropFilter }; });
    assert.equal(box.h, 28, "a 28 px pill");
    assert.doesNotMatch(box.shadow, /0px 0px 0px 3px/, "no halo");
    await inPage(page, () => window.pbScreen.who({ agent: "Claude", agentColor: "#e9763f" }));
    assert.deepEqual(await pill(), { shown: true, text: "Claude (agent) is working in it" });
    assert.equal(await dot(), "rgb(233, 118, 63)");
    await inPage(page, () => window.pbScreen.who({ person: "Sam", personColor: "nope", agent: "Claude", agentColor: "#e9763f" }));
    assert.deepEqual(await pill(), { shown: true, text: "Sam · Claude (agent) working" });
    assert.equal(await dot(), "rgb(233, 118, 63)", "the agent's color when the person's is not a color");
    await inPage(page, () => window.pbScreen.who({}));
    assert.deepEqual(await pill(), { shown: false, text: "" }, "nobody: gone");
    await inPage(page, () => window.pbScreen.pointers([{ k: "sam", who: "Sam", color: "#2fb6d9", nx: 0.5, ny: 0.5 }]));
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".p span")).color), "rgb(11, 20, 33)", "dark ink on a pointer's name");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
