// The phone hand-off end to end through a real Cloudflare Quick Tunnel, the phone side a real
// browser emulating an iPhone (touch, its user agent, 393 px wide): a hand-off in a clean session
// (whose links were 404: the live view matched grants against the shown name "Clean session"); a
// chat app's link preview (TelegramBot) and the phone's first open both get the landing page with
// the tab's picture; Take over; the live picture fits the phone's width and keeps coming; a tap on
// one tile of a 3x3 grid toggles that tile and no other (the picture's coordinates map to the
// page's); typing through the type box reaches the focused field; Done hands back (the waiting
// agent goes on). Screenshots of each step in PAIRBROWSE_TEST_SHOTS (a folder) when set.
// Needs the network, cloudflared, PAIRBROWSE_TEST_RUNTIME and PAIRBROWSE_TEST_REAL_TUNNEL=1.
// Cloudflare limits fresh Quick Tunnels: run it sparingly.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { attachDaemon, session, patchright } from "../helpers/live.mjs";
import { text, until } from "../helpers/util.mjs";
import { helperHome, spawnDaemon, stopDaemon, driverBrowserPath } from "../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const skip = !runtime || process.env.PAIRBROWSE_TEST_REAL_TUNNEL !== "1";
const shots = process.env.PAIRBROWSE_TEST_SHOTS || null;
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const TELEGRAM_BOT = "TelegramBot (like TwitterBot)";
const TILE = 120, GRID_X = 20, GRID_Y = 60; // the grid's tiles and where they sit in the frame
const PICK = 5; // the tile the person taps (row 1, column 2)

// The check: a page with text around a verification frame (same origin) holding a 3x3 grid of
// tiles that toggle on a click and a field; every change reported with where the frame sits.
const FRAME = { x: 440, y: 180, w: 400, h: 520 };
async function startCheck() {
  const reports = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/ev") { reports.push(JSON.parse(url.searchParams.get("v"))); res.writeHead(204); return res.end(); }
    res.writeHead(200, { "content-type": "text/html" });
    if (url.pathname === "/frame") {
      const tiles = Array.from({ length: 9 }, (_, i) => `<button class=t data-i=${i} style="left:${GRID_X + (i % 3) * TILE}px;top:${GRID_Y + Math.floor(i / 3) * TILE}px">${i}</button>`).join("");
      return res.end(`<!doctype html><style>body{margin:0;font:16px sans-serif;background:#fff}.t{position:absolute;width:${TILE - 4}px;height:${TILE - 4}px;border:0;background:#4a7;color:#fff;font-size:28px}.t.on{background:#14c;outline:6px solid #fc0}</style>
<p style="margin:0;padding:14px 20px;background:#1a73e8;color:#fff;font-size:18px">Select all squares with tile 5</p>${tiles}
<input id=note aria-label=Note style="position:absolute;left:${GRID_X}px;top:${GRID_Y + 3 * TILE + 12}px;width:${3 * TILE - 10}px;height:36px;font-size:18px">
<script>const on=new Set();const rep=()=>fetch("/ev?v="+encodeURIComponent(JSON.stringify({on:[...on].sort(),note:document.getElementById("note").value,w:parent.innerWidth})));
document.querySelectorAll(".t").forEach(b=>b.onclick=()=>{const i=+b.dataset.i;on.has(i)?on.delete(i):on.add(i);b.classList.toggle("on");rep();});
let was="";setInterval(()=>{const v=document.getElementById("note").value;if(v!==was){was=v;rep();}},200);rep();</script>`);
    }
    res.end(`<!doctype html><title>Verify you are human</title><body style="margin:0;font:16px sans-serif">
<h1 style="margin:24px 40px;font-size:26px">A site that wants a check</h1><p style="margin:0 40px;width:360px;color:#444">${"Some words about the site. ".repeat(30)}</p>
<iframe src="/frame" style="position:absolute;left:${FRAME.x}px;top:${FRAME.y}px;width:${FRAME.w}px;height:${FRAME.h}px;border:1px solid #ccc"></iframe>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, last: () => reports.at(-1) ?? null, close: () => { server.closeAllConnections?.(); server.close(); } };
}
// WCAG contrast of two "rgb(r, g, b)" colors.
function contrast(a, b) {
  const lum = (c) => { const [r, g, bl] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
async function startWebhook() {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => { try { got.push(JSON.parse(body)); } catch {} res.writeHead(204); res.end(); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, got, close: () => server.close() };
}

test("the phone hand-off in a clean session through a real Quick Tunnel: preview and first open work, the live picture fits and streams, a tile tap lands on that tile, typing and Done", { skip, timeout: 600_000 }, async (t) => {
  const check = await startCheck();
  const hook = await startWebhook();
  const home = helperHome(runtime, { prefix: "pb-phone-", config: {
    sessionPicker: false,
    browserArgs: [`--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${check.port}`, "--window-size=1280,900"],
    handoff: { enabled: true, away: true, publicLink: true, channels: [{ type: "webhook", urlSecret: "PAIRBROWSE_WEBHOOK_URL" }] },
  } });
  writeFileSync(join(home, "secrets.env"), `PAIRBROWSE_WEBHOOK_URL=${hook.url}\n`, { mode: 0o600 });
  const tools = join(homedir(), ".pairbrowse", "tools");
  if (existsSync(tools)) symlinkSync(tools, join(home, "tools"), "dir");
  if (shots) mkdirSync(shots, { recursive: true });
  const log = () => { try { return readFileSync(join(home, "daemon.log"), "utf8"); } catch { return ""; } };
  let daemon = null, agent = null, phone = null, page = null, stage = "start";
  const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
  try {
    stage = "the helper, a clean session and the agent's tab";
    daemon = spawnDaemon(home);
    const socketPath = join(home, "run", "browser.sock");
    (await attachDaemon({ socketPath, daemon, home })).destroy();
    agent = await session(socketPath, "a");
    assert.match(text(await agent.tool("pairbrowse_session", { action: "new", clean: true }, 120_000)), /clean/i);
    assert.ok(!(await agent.tool("browser_navigate", { url: "http://check.pbtest.example/" })).result?.isError);

    stage = "the hand-off: its link is public";
    const said = text(await agent.tool("pairbrowse_status", { kind: "you", text: "Solve the check", step: "captcha" }, 120_000));
    assert.match(said, /Your turn (sent \(webhook\)|is on its way)/, said);
    const turn = await until("the webhook's message", () => hook.got.find((m) => m.event === "pairbrowse.turn"), 120_000, 100);
    assert.match(turn.link, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/[0-9a-f]{64}\/$/, JSON.stringify(turn));

    stage = "a chat app's link preview, then the phone's first open";
    const preview = await fetch(turn.link, { headers: { "user-agent": TELEGRAM_BOT }, signal: AbortSignal.timeout(30_000) });
    assert.equal(preview.status, 200, "the preview gets the landing page");
    assert.match(await preview.text(), /Take over/);
    const pw = patchright(runtime);
    phone = await pw.chromium.launch({ executablePath: driverBrowserPath(runtime), headless: true });
    const phoneCtx = (w, h, scheme) => phone.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA, colorScheme: scheme });
    // The landing page on a small phone in dark mode too: readable, with the tab's picture.
    for (const [w, h, scheme] of [[360, 800, "dark"], [393, 852, "light"]]) {
      const ctx = await phoneCtx(w, h, scheme);
      const p = await ctx.newPage();
      const r = await p.goto(turn.link, { timeout: 60_000 });
      assert.equal(r.status(), 200, `the first open on the phone (${w}x${h} ${scheme})`);
      await p.getByRole("button", { name: "Take over" }).waitFor({ timeout: 30_000 });
      const c = await p.evaluate(() => { const h1 = getComputedStyle(document.querySelector("h1")).color, card = getComputedStyle(document.querySelector(".card")).backgroundColor; return { h1, card }; });
      assert.ok(contrast(c.h1, c.card) >= 4.5, `the title reads on its card (${JSON.stringify(c)}: ${contrast(c.h1, c.card).toFixed(2)})`);
      await until("the tab's picture on the landing page", () => p.evaluate(() => document.getElementById("peek").dataset.ready === "true" && document.getElementById("peek-img").naturalWidth > 0), 30_000, 200);
      await shot(p, `01-landing-${w}x${h}-${scheme}`);
      if (w === 393) { page = p; break; }
      await ctx.close();
    }

    stage = "Take over: the live picture, zoomed to the verification";
    await page.getByRole("button", { name: "Take over" }).tap();
    const img = page.locator("#screen");
    await until("the picture", () => img.evaluate((i) => !i.hidden && i.naturalWidth > 0).catch(() => false), 60_000, 200);
    await until("the first zoom", () => page.locator("#zoom-level").textContent().then((t) => parseFloat(t) > 1), 15_000, 200);
    await sleepMs(800);
    await shot(page, "02-viewer-393x852");
    const zoomed = await page.locator("#zoom-level").textContent();
    const stageBox = await page.locator("#stage").boundingBox().catch(() => null) ?? await page.locator(".stage").boundingBox();
    const box = await img.boundingBox();
    t.diagnostic(`picture on the phone at ${zoomed}: ${JSON.stringify(box)}; stage ${JSON.stringify(stageBox)}`);
    assert.ok(box.height >= stageBox.height * 0.5, "the picture fills at least half the screen");
    // Pictures keep coming: the picture's changes are counted while the person taps and types.
    await page.evaluate(() => { window.__frames = 0; new MutationObserver(() => window.__frames++).observe(document.getElementById("screen"), { attributes: true, attributeFilter: ["src"] }); });

    stage = "a tap on one tile, at the first zoom";
    const scale = box.width / check.last().w;
    const tileAt = (i) => ({ x: FRAME.x + 1 + GRID_X + (i % 3) * TILE + TILE / 2, y: FRAME.y + 1 + GRID_Y + Math.floor(i / 3) * TILE + TILE / 2 });
    const visible = (pt) => { const x = box.x + pt.x * scale, y = box.y + pt.y * scale; return x > stageBox.x && x < stageBox.x + stageBox.width && y > stageBox.y && y < stageBox.y + stageBox.height ? { x, y } : null; };
    for (let i = 0; i < 9; i++) assert.ok(visible(tileAt(i)), `tile ${i} is on screen at the first zoom`);
    const at = visible(tileAt(PICK));
    await page.touchscreen.tap(at.x, at.y);
    await until("tile 5 toggled, and no other", () => JSON.stringify(check.last()?.on) === JSON.stringify([PICK]), 30_000, 100);
    await sleepMs(1500);
    await shot(page, "03-tile-tapped-393x852");

    stage = "typing through the type box";
    const field = visible({ x: FRAME.x + 1 + GRID_X + 100, y: FRAME.y + 1 + GRID_Y + 3 * TILE + 30 });
    assert.ok(field, "the field is on screen");
    await page.touchscreen.tap(field.x, field.y);
    await sleepMs(800);
    await page.locator("#type-box").tap();
    await page.keyboard.type("from my phone");
    await until("the typed text in the page", () => check.last()?.note === "from my phone", 30_000, 100);
    await sleepMs(1500);
    const frames = await page.evaluate(() => window.__frames);
    t.diagnostic(`picture updates during the tap and typing: ${frames}`);
    assert.ok(frames >= 3, "the picture kept streaming");
    await shot(page, "04-typed-393x852");
    await page.setViewportSize({ width: 360, height: 800 });
    await sleepMs(1500);
    await shot(page, "04-typed-360x800");

    stage = "Done hands back";
    const waiting = agent.tool("browser_wait_for", {}, 120_000);
    await page.locator("#turn-done").tap();
    const woke = text(await waiting);
    assert.match(woke, /ended \(done\)|pressed Done/, woke);
    await sleepMs(1000);
    assert.equal(await page.locator("#overlay-title").textContent(), "Done. The agent continues.");
    for (const sel of ["#turn-left", "#turn-done", "#turnkeys"]) assert.equal(await page.locator(sel).isVisible(), false, `${sel} gone after the end`);
    await shot(page, "05-done-360x800");
  } catch (e) {
    throw new Error(`${stage}: ${e.message}\n--- daemon.log ---\n${log().slice(-4000)}`);
  } finally {
    await phone?.close().catch(() => {});
    agent?.sock.destroy();
    await stopDaemon(daemon);
    check.close();
    hook.close();
    rmSync(home, { recursive: true, force: true });
  }
});
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
