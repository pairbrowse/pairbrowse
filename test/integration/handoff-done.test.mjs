// A hand-off the person ends takes the window's "Your turn" down by itself (no agent status call):
// PairBrowse's own check (a CAPTCHA frame it saw on the page, which stays on screen after it is
// solved, as reCAPTCHA's green check does) and an agent's "you", each ended by Done on the phone
// (the viewer's turn-done route). The badge is read in the page as the person sees it
// (PAIRBROWSE_TEST_BADGE). A real helper and browser, hand-offs to a loopback webhook. Live:
// PAIRBROWSE_TEST_RUNTIME.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { attachDaemon, session } from "../helpers/live.mjs";
import { text, until } from "../helpers/util.mjs";
import { helperHome, spawnDaemon, stopDaemon } from "../helpers/daemon.mjs";
import { CHALLENGE_TURN } from "../../scripts/popups.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const SHOP = "http://shop.pbtest.example";

// The check's frame comes from a check maker's address (popups.mjs CHALLENGE), on screen at
// reCAPTCHA's checkbox size; solved, it shows its tick and stays.
const PAGES = {
  "/check": () => `<!doctype html><title>Check</title><body style="margin:0"><h1>Are you human?</h1>
<iframe src="http://recaptcha.pbtest.example/api2/anchor?k=test" style="position:absolute;left:20px;top:80px;width:304px;height:78px;border:1px solid #ccc"></iframe></body>`,
  "/anchor": () => `<!doctype html><body style="margin:0;font:14px sans-serif"><label style="display:block;padding:24px"><input type="checkbox"> I'm not a robot</label></body>`,
  "/login": () => `<!doctype html><title>Sign in</title><h1>Sign in</h1><button>Sign in</button>`,
};

async function startShop() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const html = String(req.headers.host).startsWith("recaptcha.") ? PAGES["/anchor"]() : PAGES[url.pathname]?.();
    res.writeHead(html ? 200 : 404, { "content-type": "text/html", "cache-control": "no-store" });
    res.end(html || "not here");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, close: () => { server.closeAllConnections?.(); server.close(); } };
}
async function startWebhook() {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => { try { got.push(JSON.parse(body)); } catch { got.push({ unreadable: body }); } res.writeHead(204); res.end(); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, got, close: () => { server.closeAllConnections?.(); server.close(); } };
}
function request(link, method, path = "", body) {
  const u = new URL(path, link);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path: u.pathname, headers: body !== undefined ? { "content-type": "application/json" } : {} }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (t += d));
      res.on("end", () => resolve({ status: res.statusCode, text: t }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test("Done on the phone takes the window's Your turn down by itself: PairBrowse's own check (its frame still on the page) and an agent's \"you\"", { skip: !runtime && "set PAIRBROWSE_TEST_RUNTIME", timeout: 180_000 }, async () => {
  const shop = await startShop();
  const hook = await startWebhook();
  const home = helperHome(runtime, { prefix: "pb-hdone-", config: {
    sessionPicker: false,
    browserArgs: [`--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${shop.port}`],
    handoff: { enabled: true, channels: [{ type: "webhook", urlSecret: "PAIRBROWSE_WEBHOOK_URL" }] },
  } });
  writeFileSync(join(home, "secrets.env"), `PAIRBROWSE_WEBHOOK_URL=${hook.url}\n`, { mode: 0o600 });
  const daemon = spawnDaemon(home, { env: { PAIRBROWSE_TEST_BADGE: "1" } });
  const why = () => { try { return `\n--- daemon.log ---\n${readFileSync(join(home, "daemon.log"), "utf8").slice(-3000)}`; } catch { return ""; } };
  let agent;
  try {
    const socketPath = join(home, "run", "browser.sock");
    (await attachDaemon({ socketPath, daemon, home })).destroy();
    agent = await session(socketPath, "a");
    // The badge each tab shows, as the person reads it there.
    const badgeAt = async (path) => JSON.parse(text(await agent.tool("pairbrowse_test_badge"))).find((t) => t.url.endsWith(path))?.badge ?? null;
    const turns = () => hook.got.filter((m) => m.event === "pairbrowse.turn");
    // Done on the phone: Take over, then Done, as the viewer sends them.
    const done = async (link) => {
      const r = await request(link, "POST", "redeem", {});
      assert.equal(r.status, 200, r.text);
      const view = new URL(JSON.parse(r.text).view, link).href;
      assert.equal((await request(view, "POST", "turn-done", {})).status, 200);
    };

    // 1. PairBrowse sees the check after the agent's call and hands it over.
    assert.ok(!(await agent.tool("browser_navigate", { url: `${SHOP}/check` })).result?.isError);
    const turn = await until("the check's message", async () => turns().find((m) => m.kind === "captcha") || (await agent.tool("browser_snapshot"), null), 30_000, 500);
    assert.equal(await until("the badge in the page", async () => (await badgeAt("/check")) || null, 10_000, 200), `Your turn: ${CHALLENGE_TURN}`);
    const waiting = agent.tool("browser_wait_for", {}, 60_000);
    await done(turn.link);
    assert.match(text(await waiting), new RegExp(`hand-off ${turn.id} ended \\(done\\)|ended: the person pressed Done`), "the waiting agent goes on");
    // Down by itself, though the check's frame is still on the page and no status was called.
    await until("the check's Your turn down", async () => (await badgeAt("/check")) === "", 10_000, 200);

    // 2. An agent's "you", Done on the phone: its Your turn goes too, its wait returns.
    assert.ok(!(await agent.tool("browser_navigate", { url: `${SHOP}/login` })).result?.isError);
    const said = text(await agent.tool("pairbrowse_status", { kind: "you", text: "Please sign in", step: "login" }));
    const id = said.match(/hand-off ([0-9a-f]{8})/)?.[1];
    assert.ok(id, said);
    assert.equal(await badgeAt("/login"), "Your turn: Please sign in");
    const turn2 = await until("the sign-in's message", () => turns().find((m) => m.id === id), 20_000, 100);
    const waiting2 = agent.tool("browser_wait_for", {}, 60_000);
    await done(turn2.link);
    assert.match(text(await waiting2), new RegExp(`hand-off ${id} ended`), "the waiting agent goes on");
    await until("the agent's Your turn down", async () => (await badgeAt("/login")) === "", 10_000, 200);
  } catch (e) { throw new Error(`${e.message}${why()}\nmessages: ${JSON.stringify(hook.got)}`, { cause: e }); } finally {
    agent?.sock?.destroy();
    await stopDaemon(daemon, 20_000);
    shop.close();
    hook.close();
    rmSync(home, { recursive: true, force: true });
  }
});
