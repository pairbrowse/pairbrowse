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
const TILE = 120, GRID_X = 40, GRID_Y = 120; // the grid's tiles and where it sits, in page pixels
const PICK = 5; // the tile the person taps (row 1, column 2)

// The check: a 3x3 grid of tiles that toggle on a click, and a field; every change reported.
async function startCheck() {
  const reports = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/ev") { reports.push(JSON.parse(url.searchParams.get("v"))); res.writeHead(204); return res.end(); }
    const tiles = Array.from({ length: 9 }, (_, i) => `<button class=t data-i=${i} style="left:${GRID_X + (i % 3) * TILE}px;top:${GRID_Y + Math.floor(i / 3) * TILE}px">${i}</button>`).join("");
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Select all squares</title><style>body{margin:0;font:16px sans-serif}.t{position:absolute;width:${TILE - 4}px;height:${TILE - 4}px;border:0;background:#4a7;color:#fff;font-size:28px}.t.on{background:#14c;outline:6px solid #fc0}</style>
<h1 style="margin:16px 40px;font-size:22px">Select all squares with tile 5</h1>${tiles}
<input id=note aria-label=Note style="position:absolute;left:${GRID_X}px;top:${GRID_Y + 3 * TILE + 20}px;width:${3 * TILE - 10}px;height:40px;font-size:18px">
<script>const on=new Set();const rep=()=>fetch("/ev?v="+encodeURIComponent(JSON.stringify({on:[...on].sort(),note:document.getElementById("note").value,w:innerWidth})));rep();
document.querySelectorAll(".t").forEach(b=>b.onclick=()=>{const i=+b.dataset.i;on.has(i)?on.delete(i):on.add(i);b.classList.toggle("on");rep();});
let was="";setInterval(()=>{const v=document.getElementById("note").value;if(v!==was){was=v;rep();}},200);</script>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, last: () => reports.at(-1) ?? null, close: () => { server.closeAllConnections?.(); server.close(); } };
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
  let daemon = null, agent = null, phone = null, stage = "start";
  const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
  try {
    stage = "the helper, a clean session and the agent's tab";
    daemon = spawnDaemon(home);
    const socketPath = join(home, "run", "browser.sock");
    (await attachDaemon({ socketPath, daemon, home })).destroy();
    agent = await session(socketPath, "a");
    assert.match(text(await agent.tool("pairbrowse_session", { action: "new", clean: true }, 120_000)), /clean/i);
    assert.ok(!(await agent.tool("browser_navigate", { url: "http://check.pbtest.example/grid" })).result?.isError);

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
    const ctx = await phone.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });
    const page = await ctx.newPage();
    const first = await page.goto(turn.link, { timeout: 60_000 });
    assert.equal(first.status(), 200, "the first open on the phone");
    await page.getByRole("button", { name: "Take over" }).waitFor({ timeout: 30_000 });
    await shot(page, "01-landing");

    stage = "Take over: the live picture";
    await page.getByRole("button", { name: "Take over" }).tap();
    const img = page.locator("#screen");
    await until("the picture", () => img.evaluate((i) => !i.hidden && i.naturalWidth > 0).catch(() => false), 60_000, 200);
    await shot(page, "02-viewer");
    const box = await img.boundingBox();
    t.diagnostic(`picture on the phone: ${JSON.stringify(box)}`);
    assert.ok(box.x >= 0 && box.x + box.width <= 393 + 1, "the picture fits the phone's width");
    assert.ok(box.width > 300, "and uses it");
    // Pictures keep coming: count the picture's changes for five seconds while the page changes.
    await page.evaluate(() => { window.__frames = 0; new MutationObserver(() => window.__frames++).observe(document.getElementById("screen"), { attributes: true, attributeFilter: ["src"] }); });

    stage = "a tap on one tile";
    const natural = await img.evaluate((i) => ({ w: i.naturalWidth, h: i.naturalHeight }));
    // The picture is the page's viewport: page pixels scale by box.width / the page's own width.
    const scale = box.width / check.last().w;
    const cx = GRID_X + (PICK % 3) * TILE + TILE / 2, cy = GRID_Y + Math.floor(PICK / 3) * TILE + TILE / 2;
    await page.touchscreen.tap(box.x + cx * scale, box.y + cy * scale);
    await until("tile 5 toggled", () => JSON.stringify(check.last()?.on) === JSON.stringify([PICK]), 30_000, 100);
    t.diagnostic(`picture ${natural.w}x${natural.h}; tile ${PICK} on: ${JSON.stringify(check.last())}`);
    await sleepMs(1500);
    await shot(page, "03-tile-tapped");

    stage = "typing through the type box";
    const nx = GRID_X + 100, ny = GRID_Y + 3 * TILE + 40;
    await page.touchscreen.tap(box.x + nx * scale, box.y + ny * scale);
    await sleepMs(800);
    await page.locator("#type-box").tap();
    await page.keyboard.type("from my phone");
    await until("the typed text in the page", () => check.last()?.note === "from my phone", 30_000, 100);
    await sleepMs(1500);
    const frames = await page.evaluate(() => window.__frames);
    t.diagnostic(`picture updates during the tap and typing: ${frames}`);
    assert.ok(frames >= 3, "the picture kept streaming");
    await shot(page, "04-typed");

    stage = "Done hands back";
    const waiting = agent.tool("browser_wait_for", {}, 120_000);
    await page.locator("#turn-done").tap();
    const woke = text(await waiting);
    assert.match(woke, /ended \(done\)|pressed Done/, woke);
    await sleepMs(1000);
    await shot(page, "05-done");
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
