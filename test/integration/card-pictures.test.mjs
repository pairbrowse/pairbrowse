// Card fields covered in pictures that leave the host's screen (daemon/covers.mjs), live:
// coverRects finds a checkout's card number, security code and expiry fields, in the page and in
// a same-origin frame, a card number in a paragraph and one split across spans, and a one-time
// code's boxes, never the ZIP or the name on the card; the page's own scripts can't move them
// (the reads run in a world of their own); frames past the read limit are covered whole; and a
// timeline picture a real helper keeps (PAIRBROWSE_TEST_RUNTIME, headless) is covered where the
// card field is.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { session, testBase, patchright } from "../helpers/live.mjs";
import { sleep } from "../helpers/util.mjs";
import { spawnDaemon, stopDaemon } from "../helpers/daemon.mjs";
import { coverRects, agentPicture, COVER_COLOR } from "../../scripts/daemon/covers.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;

// Fixed places, as fractions of the view: the card field at (10%, 10%) 30% x 10%, the ZIP at
// (60%, 10%), the name on the card at (60%, 25%), the paragraph at (10%, 25%), the frame below.
const at = (l, t, w, h) => `position:fixed;left:${l}%;top:${t}%;width:${w}%;height:${h}%;box-sizing:border-box;margin:0;font:16px sans-serif;background:#fff;border:1px solid #888`;
const CHECKOUT = `<!doctype html><title>Checkout</title><body style="margin:0;background:#fff">
<input id=card autocomplete=cc-number aria-label="Card number" value="4242 4242 4242 4242" style="${at(10, 10, 30, 10)}">
<label style="${at(60, 4, 30, 5)};border:0">ZIP code<input id=zip autocomplete=postal-code name=zip value="94107" style="${at(60, 10, 30, 10)}"></label>
<input id=holder autocomplete=cc-name aria-label="Name on card" value="Ada Lovelace" style="${at(60, 25, 30, 10)}">
<p id=para style="${at(10, 25, 40, 10)};border:0">Card on file: 4111 1111 1111 1111 thanks</p>
<div id=split style="${at(10, 36, 40, 6)};border:0">Paid with <span>5555</span>
  <span>5555</span> <b>5555</b> <span><i>4444</i></span></div>
<input id=otp1 name=digit-1 inputmode=numeric maxlength=1 value=7 style="${at(60, 36, 4, 6)}"><input id=otp2 name=code maxlength=6 value=123456 style="${at(66, 36, 10, 6)}">
<iframe id=f src="/frame" style="${at(10, 45, 80, 50)};border:0"></iframe>`;
const FRAME = `<!doctype html><body style="margin:0;background:#fff">
<input id=fcard name=cardnumber placeholder="Card number" style="${at(0, 0, 40, 20)}">
<label style="${at(50, 0, 20, 10)};border:0">Security code<input id=fcvc name=cvc style="${at(50, 10, 20, 20)}"></label>
<input id=fexp autocomplete=cc-exp placeholder="MM / YY" style="${at(0, 40, 40, 20)}">
<input id=fzip autocomplete=postal-code placeholder="ZIP" value="10001" style="${at(50, 40, 40, 20)}">`;

function site() {
  const s = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url.startsWith("/frame") ? FRAME : CHECKOUT);
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}
const covered = (rects, x, y) => rects.some(([a, b, w, h]) => x >= a && x <= a + w && y >= b && y <= b + h);

// Where each element's center is, as fractions of the main view.
async function centers(page) {
  const main = await page.evaluate(() => {
    const out = Object.fromEntries(["card", "zip", "holder", "split", "otp1", "otp2"].map((id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return [id, [(r.left + r.width / 2) / innerWidth, (r.top + r.height / 2) / innerHeight]];
    }));
    // The card number's own text in the paragraph, and the words before it.
    const node = document.getElementById("para").firstChild;
    const place = (from, to) => {
      const range = document.createRange();
      range.setStart(node, from); range.setEnd(node, to);
      const r = range.getBoundingClientRect();
      return [(r.left + r.width / 2) / innerWidth, (r.top + r.height / 2) / innerHeight];
    };
    const i = node.nodeValue.indexOf("4111");
    out.para = place(i, i + 19);
    out.words = place(0, 4);
    return out;
  });
  const frame = page.frames().find((f) => f.url().endsWith("/frame"));
  const box = await (await frame.frameElement()).boundingBox();
  const vw = await page.evaluate(() => [innerWidth, innerHeight]);
  const inner = await frame.evaluate(() => Object.fromEntries(["fcard", "fcvc", "fexp", "fzip"].map((id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return [id, [r.left + r.width / 2, r.top + r.height / 2]];
  })));
  for (const [id, [x, y]] of Object.entries(inner)) main[id] = [(box.x + x) / vw[0], (box.y + y) / vw[1]];
  return main;
}
// The pixel of a base64 JPEG at fractions (x, y), decoded in a page.
const pixel = (page, b64, x, y) => page.evaluate(async ([b, fx, fy]) => {
  const img = new Image();
  img.src = `data:image/jpeg;base64,${b}`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  return [...g.getImageData(Math.round(fx * c.width), Math.round(fy * c.height), 1, 1).data].slice(0, 3);
}, [b64, x, y]);
const near = (px, hex) => { const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); return px.every((v, i) => Math.abs(v - want[i]) < 28); };

test("coverRects finds the card fields in the page and its frame and a card number in text, not the ZIP or the name; a composed picture has them painted over", { skip: !runtime, timeout: 90_000 }, async () => {
  const server = await site();
  const browser = await patchright(runtime).chromium.launch({ headless: true });
  // Where tabs are captured (ui/capture/record.js coverPicture), stood in by a page of its own.
  let painter;
  const compose = (data, rects) => painter.evaluate(async ([d, r, color]) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(d), (ch) => ch.charCodeAt(0))], { type: "image/jpeg" }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d");
    g.drawImage(bmp, 0, 0);
    g.fillStyle = color;
    for (const [x, y, w, h] of r) g.fillRect(Math.floor(x * c.width), Math.floor(y * c.height), Math.ceil(w * c.width) + 1, Math.ceil(h * c.height) + 1);
    const b = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: 0.8 })).arrayBuffer());
    let s = ""; for (const x of b) s += String.fromCharCode(x);
    return btoa(s);
  }, [data, rects, COVER_COLOR]);
  try {
    painter = await browser.newPage();
    const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/checkout`);
    await page.frames().find((f) => f.url().endsWith("/frame"))?.waitForLoadState() ?? sleep(500);
    const rects = await coverRects(page);
    assert.ok(Array.isArray(rects) && rects.length, JSON.stringify(rects));
    const c = await centers(page);
    for (const id of ["card", "para", "split", "otp1", "otp2", "fcard", "fcvc", "fexp"]) assert.ok(covered(rects, ...c[id]), `${id} at ${c[id]} not covered: ${JSON.stringify(rects)}`);
    for (const id of ["zip", "holder", "fzip", "words"]) assert.ok(!covered(rects, ...c[id]), `${id} covered: ${JSON.stringify(rects)}`);
    // The page's scripts can't move the covers: what they change in their own world isn't what
    // the reads use.
    await page.addScriptTag({ content: "Element.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0); Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0); HTMLInputElement.prototype.querySelectorAll = () => []; Document.prototype.querySelectorAll = () => [];" });
    assert.equal(await page.evaluate(() => document.getElementById("card").getBoundingClientRect().width, undefined, undefined, false), 0, "patched in the page's own world");
    const again = await coverRects(page);
    for (const id of ["card", "split", "fcard"]) assert.ok(covered(again, ...c[id]), `${id} not covered after the page patched its DOM: ${JSON.stringify(again)}`);
    // Drawn where tabs are captured (here: a page of its own), the card field is the cover's
    // color, the ZIP stays white.
    const shot = (await page.screenshot({ type: "jpeg", quality: 80 })).toString("base64");
    const out = await compose(shot, rects);
    assert.equal(typeof out, "string");
    assert.ok(near(await pixel(page, out, ...c.card), COVER_COLOR), "card painted over");
    assert.ok(near(await pixel(page, out, ...c.fcvc), COVER_COLOR), "frame's security code painted over");
    assert.ok(near(await pixel(page, out, c.zip[0] + 0.1, c.zip[1]), "#ffffff"), "ZIP as it is");
    // An agent's result picture: a joiner's agent's has the card covered, the host's own is as taken.
    const joiners = await agentPicture(shot, page, true, { compose, before: [] });
    assert.ok(near(await pixel(page, joiners, ...c.card), COVER_COLOR), "a joiner's agent's picture: card covered");
    const hosts = await agentPicture(shot, page, false, { compose });
    assert.equal(hosts, shot, "the host's agent's picture as it is");
    assert.ok(!near(await pixel(page, hosts, ...c.card), COVER_COLOR));
    // More frames than are read: those past the limit are covered whole where they show.
    await page.evaluate(() => {
      for (let i = 0; i < 24; i++) {
        const f = document.createElement("iframe");
        f.srcdoc = "<p>frame</p>";
        f.style.cssText = `position:fixed;left:${2 + (i % 12) * 8}%;top:${i < 12 ? 2 : 96}%;width:6%;height:2%;border:0`;
        document.body.append(f);
      }
    }, undefined, undefined, false);
    await sleep(500);
    const many = await coverRects(page);
    assert.ok(many.length >= 3 && many.length < 40, `frames past the limit covered by their box: ${many.length}`);
    // A page that isn't there answers null (callers fail safe).
    await page.close();
    assert.equal(await coverRects(page), null);
  } finally {
    await browser.close();
    server.close();
  }
});

test("a timeline picture is kept with the card field covered", { skip: !runtime, timeout: 120_000 }, async () => {
  const server = await site();
  const base = testBase();
  mkdirSync(base, { recursive: true });
  const h = mkdtempSync(join(base, "cardpic-"));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  const executablePath = patchright(runtime).chromium.executablePath();
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, browserArgs: ["--headless=new"], display: "none" }));
  const daemon = spawnDaemon(h);
  const socketPath = join(h, "run", "browser.sock");
  for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
  const a = await session(socketPath, "w");
  const jpgs = () => {
    const out = [];
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".jpg") && p.includes(`timeline`)) out.push(p); } };
    try { walk(h); } catch {}
    return out.sort((x, y) => statSync(x).mtimeMs - statSync(y).mtimeMs);
  };
  const viewer = await patchright(runtime).chromium.launch({ headless: true });
  try {
    await a.tool("browser_navigate", { url: `http://127.0.0.1:${server.address().port}/checkout` });
    let files = [];
    for (let i = 0; i < 100 && !files.length; i++) { await sleep(100); files = jpgs(); }
    assert.ok(files.length, `no timeline picture under ${h}`);
    const b64 = readFileSync(files.at(-1)).toString("base64");
    const page = await viewer.newPage();
    // The card field's middle (25%, 15%) is the cover's color; the ZIP's (75%, 15%) is not.
    assert.ok(near(await pixel(page, b64, 0.25, 0.15), COVER_COLOR), `card: ${await pixel(page, b64, 0.25, 0.15)}`);
    assert.ok(!near(await pixel(page, b64, 0.8, 0.15), COVER_COLOR), "ZIP not covered");
  } finally {
    a.sock.destroy();
    await viewer.close();
    await stopDaemon(daemon);
    rmSync(h, { recursive: true, force: true });
    server.close();
  }
});
