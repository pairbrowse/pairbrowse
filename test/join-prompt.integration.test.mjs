// The corner prompt for a join request ("Sam wants to join (drive)", Allow / Deny / close): shown
// by the page script, answered only by a real click; and end to end, with a host helper and a
// joiner's (PAIRBROWSE_TEST_TUNNEL=direct, as in join.integration.test.mjs). Needs PAIRBROWSE_TEST_RUNTIME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import net from "node:net";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync, existsSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { hudScript } from "../scripts/browser.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A page that tries everything a page can: find the prompt, click it, fake one. It patches
// attachShadow and click() as early as it can (its scripts run after PairBrowse's, so the
// prompt's closed shadow root stays out of reach).
const HOSTILE = `<title>hostile</title><body style="height:2000px">page
<script>
  window.found = [];
  const orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (o) { const r = orig.call(this, o); window.found.push(r); return r; };
  window.tryEverything = () => {
    let hits = 0;
    for (const el of document.querySelectorAll("*")) {
      if (el.shadowRoot) hits++;
      for (const b of el.shadowRoot?.querySelectorAll("button") || []) { b.click(); hits++; }
    }
    // A synthetic click wherever the prompt's Allow is.
    const at = document.elementFromPoint(innerWidth - 120, innerHeight - 60);
    at?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 1, clientX: innerWidth - 120, clientY: innerHeight - 60 }));
    for (const r of window.found) for (const b of r.querySelectorAll("button")) { b.click(); hits++; }
    return { hits, text: document.documentElement.innerText.includes("wants to join") };
  };
</script></body>`;

test("the join prompt: shows on the page, goes by itself, can be dismissed, takes only a real click", { skip: !runtime, timeout: 90_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("playwright");
  const server = createServer((req, res) => {
    // Strict CSP and Trusted Types, as on YouTube or Google's apps.
    res.writeHead(200, { "content-type": "text/html", "content-security-policy": "require-trusted-types-for 'script'; default-src 'self' 'unsafe-inline'" });
    res.end(HOSTILE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ headless: true });
  try {
    const { source, name, token } = hudScript();
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript({ content: source });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const hud = (value, kind) => page.evaluate(([n, t, v, k]) => window[n](t, v, k), [name, token, value, kind]);
    const state = () => hud("", "join-state");
    // The answers recorded for the helper (a chain, newest first), and never in the page's input.
    const answers = async () => {
      assert.ok(!(await hud("", "user")).some((e) => /^join-/.test(e.kind)), "not in the input list");
      const out = [];
      for (let a = (await hud("", "join-answers")).a; a; a = a.next) out.push({ kind: a.kind, what: a.what });
      return out;
    };
    await hud(JSON.stringify({ items: [] }), "bar");
    const before = await page.evaluate(() => document.documentElement.children.length);

    // Shown: the page's DOM doesn't change (it's inside the bar's closed shadow root).
    assert.equal(await hud({ id: "r00aa01", who: "Sam (Claude Code)", role: "drive" }, "join"), true);
    assert.equal(await hud({ id: "nope", who: "x" }, "join"), false, "a bad id draws nothing");
    let s = await state();
    assert.equal(s.length, 1);
    assert.equal(s[0].who, "Sam (Claude Code)");
    assert.equal(await page.evaluate(() => document.documentElement.children.length), before, "no new element in the page");
    const shot = await page.screenshot();
    assert.ok(shot.length > 0);

    // The page can't see, click or fake it.
    await sleep(800); // armed
    const tried = await page.evaluate(() => window.tryEverything());
    assert.equal(tried.text, false, "the page can't read it");
    await page.evaluate(() => document.documentElement.click());
    assert.deepEqual(await answers(), [], "no answer from a page's clicks");
    assert.equal(await page.evaluate(([n]) => window[n]("guess", "", "join-state"), [name]), false, "no state without the key");
    assert.equal((await state()).length, 1, "still there");

    // A real click too soon after it showed doesn't count; nor from the keyboard.
    await hud({ id: "r00aa02", who: "Ann", role: "watch" }, "join");
    s = await state();
    assert.equal(s.length, 2);
    const ann = s.find((x) => x.id === "r00aa02"), sam = s.find((x) => x.id === "r00aa01");
    assert.ok(ann.allow.y < sam.allow.y, "the newest stacks on top; the older row doesn't move");
    await page.mouse.click(sam.allow.x, sam.allow.y);
    assert.deepEqual(await answers(), [], "the stack just changed: not yet");
    await page.keyboard.press("Enter");
    assert.deepEqual(await answers(), []);

    // A real click on Allow, once armed: recorded for the helper with the request's id.
    await sleep(800);
    await page.mouse.click(sam.allow.x, sam.allow.y);
    let got = await answers();
    assert.deepEqual(got.map((e) => [e.kind, e.what]), [["join-allow", "r00aa01"]]);
    // Answered (the helper takes it down).
    assert.equal(await hud("r00aa01", "join-off"), true);
    assert.equal((await state()).length, 1);

    // Covered by the page: the click isn't taken.
    await sleep(800);
    s = await state();
    await page.evaluate(([x, y]) => {
      const d = document.createElement("div");
      d.id = "cover";
      d.textContent = "Close";
      d.style.cssText = `position:fixed;left:${x - 60}px;top:${y - 20}px;width:120px;height:40px;z-index:2147483647;pointer-events:none;background:#fff`;
      document.body.append(d);
    }, [s[0].allow.x, s[0].allow.y]);
    await sleep(400);
    await page.mouse.click(s[0].allow.x, s[0].allow.y);
    assert.deepEqual(await answers(), [], "a covered prompt takes no click");
    await page.evaluate(() => document.getElementById("cover").remove());
    await sleep(400);

    // The close button dismisses it (nothing is answered).
    s = await state();
    await page.mouse.click(s[0].close.x, s[0].close.y);
    assert.equal((await state()).length, 0, "dismissed");
    assert.deepEqual(await answers(), []);

    // Deny, by a real click.
    await hud({ id: "r00aa03", who: "Eve", role: "drive" }, "join");
    await sleep(800);
    s = await state();
    await page.mouse.click(s[0].deny.x, s[0].deny.y);
    got = await answers();
    assert.deepEqual(got.map((e) => [e.kind, e.what]), [["join-deny", "r00aa03"]]);
    await hud("r00aa03", "join-off");

    // Goes by itself after about 10 seconds (the pointer away from it).
    await page.mouse.move(10, 10);
    await hud({ id: "r00aa04", who: "Kim", role: "watch" }, "join");
    await sleep(9000);
    assert.equal((await state()).length, 1, "still there at 9 s");
    await sleep(1800);
    assert.equal((await state()).length, 0, "gone after 10 s");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});

// ---- end to end: a host helper and a joiner's, each with its own headless browser -------------

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shortBase = existsSync("/Volumes/BACKUP/PairBrowse") ? "/Volumes/BACKUP/PairBrowse" : tmpdir();
function rpc(write, input) {
  const waiting = new Map();
  createInterface({ input }).on("line", (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  let seq = 0;
  return (method, params = {}, ms = 60_000) => new Promise((resolve, reject) => {
    const id = `t${++seq}`;
    const timer = setTimeout(() => reject(new Error(`timed out: ${method} ${params.name || ""}`)), ms);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";
const tool = (call, name, args = {}) => call("tools/call", { name, arguments: args });

test("a join request shows a corner prompt in the host's tab in front: only the person's own click answers it", { skip: !runtime, timeout: 240_000 }, async () => {
  const require = createRequire(join(runtime, "package.json"));
  const executablePath = require("playwright").chromium.executablePath();
  const fixture = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<title>${req.headers.host}</title><main>fixture</main>`); });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const chromeArgs = ["--headless=new", `--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${fixture.address().port}`];
  const homes = [];
  const home = (prefix, name) => {
    mkdirSync(shortBase, { recursive: true });
    const dir = mkdtempSync(join(shortBase, prefix));
    symlinkSync(runtime, join(dir, "runtime"), "dir");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ executablePath, chromeArgs, display: "none", screenshots: false, participantName: name, browserDriver: "playwright" }));
    homes.push(dir);
    return dir;
  };
  const daemons = [];
  const connect = async (h) => {
    const out = openSync(join(h, "daemon.stderr.log"), "a");
    daemons.push(spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: h, PAIRBROWSE_TEST_TUNNEL: "direct", PAIRBROWSE_TEST_JOIN_LOCAL: "1", PAIRBROWSE_TEST_JOIN_PROMPT: "1" }, stdio: ["ignore", out, out] }));
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 200 && !existsSync(socketPath); i++) await sleep(50);
    let sock;
    for (let i = 0; ; i++) {
      sock = net.createConnection(socketPath);
      if (await new Promise((r) => { sock.once("connect", () => r(true)); sock.once("error", () => r(false)); })) break;
      if (i > 50) throw new Error(`couldn't connect to ${socketPath}`);
      await sleep(200);
    }
    const call = rpc((l) => sock.write(l), sock);
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } });
    sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return { sock, call };
  };
  const until = async (what, check, ms = 30_000) => {
    let last;
    for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if ((last = await check())) return last;
    throw new Error(`timed out: ${what}`);
  };
  let host, joiner;
  try {
    host = await connect(home("ph-", "Bob"));
    joiner = await connect(home("pj-", "Alice"));
    assert.ok(!(await tool(host.call, "browser_navigate", { url: "http://one.pbtest.example/" })).result.isError);
    assert.ok(!(await tool(host.call, "browser_tabs", { action: "new" })).result.isError);
    assert.ok(!(await tool(host.call, "browser_navigate", { url: "http://two.pbtest.example/" })).result.isError);
    const prompts = async () => JSON.parse(text(await tool(host.call, "pairbrowse_test_join_prompt")));
    const rowsIn = async (re) => (await prompts()).find((p) => re.test(p.url))?.rows || [];
    const click = async (args) => text(await tool(host.call, "pairbrowse_test_join_prompt", args));
    const requests = async () => text(await tool(host.call, "pairbrowse_invite", { action: "list" }));
    const code = text(await tool(host.call, "pairbrowse_invite", { action: "create", role: "drive", label: "Alice", share: "code", mode: "follow" })).match(/Join code: (pb-join:[A-Za-z0-9_-]+)/)?.[1];
    assert.ok(code);
    const ask = async () => {
      await tool(host.call, "pairbrowse_test_join_prompt", { move: true }); // the pointer away from the corner
      assert.match(text(await tool(joiner.call, "pairbrowse_join", { action: "join", code })), /Asked Bob to let Alice in/);
      await until("the prompt", async () => (await rowsIn(/two\.pbtest/)).length === 1);
      return (await requests()).match(/request (r[0-9a-f]{6}): Alice \(Claude Code\), waiting/)?.[1];
    };

    // Shown in the tab in front only (the second one), with who asks and how.
    const first = await ask();
    assert.ok(first);
    const [row] = await rowsIn(/two\.pbtest/);
    assert.equal(row.id, first);
    assert.equal(row.who, "Alice (Claude Code)");
    assert.equal((await rowsIn(/one\.pbtest/)).length, 0, "not in the tab behind");
    await sleep(800);

    // A page script, an agent's click, a joiner's or the live view's replayed click: nothing.
    for (const as of ["page", "agent", "joiner", "liveview"]) {
      await click({ click: "allow", as });
      await sleep(1200);
      assert.match(await requests(), new RegExp(`request ${first}: Alice \\(Claude Code\\), waiting`), `${as}: still waiting`);
      if (as !== "page") await sleep(2200); // the buttons come back after a moment
    }
    // The person's own click lets them in, and the prompt goes.
    assert.equal(await click({ click: "allow" }), "clicked");
    await until("let in", async () => new RegExp(`request ${first}: Alice \\(Claude Code\\), let in`).test(await requests()));
    await until("the prompt goes", async () => (await rowsIn(/two\.pbtest/)).length === 0);

    // A new request: it goes by itself after about 10 s, and stays waiting for the side panel.
    const second = await ask();
    await sleep(9000);
    assert.equal((await rowsIn(/two\.pbtest/)).length, 1, "there at 9 s");
    await until("gone after 10 s", async () => (await rowsIn(/two\.pbtest/)).length === 0, 4000);
    assert.match(await requests(), new RegExp(`request ${second}: Alice \\(Claude Code\\), waiting`));

    // Dismissed with its close: nothing answered.
    const third = await ask();
    await sleep(800);
    await click({ click: "close" });
    await until("dismissed", async () => (await rowsIn(/two\.pbtest/)).length === 0, 4000);
    assert.match(await requests(), new RegExp(`request ${third}: Alice \\(Claude Code\\), waiting`));

    // Answered elsewhere (here: the agent's deny): the prompt goes.
    const fourth = await ask();
    assert.match(text(await tool(host.call, "pairbrowse_invite", { action: "deny", id: fourth })), /Turned Alice away/);
    await until("gone when answered elsewhere", async () => (await rowsIn(/two\.pbtest/)).length === 0, 5000);

    // Deny by the person's click.
    const fifth = await ask();
    await sleep(800);
    await click({ click: "deny" });
    await until("turned away", async () => new RegExp(`request ${fifth}: Alice \\(Claude Code\\), turned away`).test(await requests()));
    await until("the prompt goes", async () => (await rowsIn(/two\.pbtest/)).length === 0, 4000);

    // A revoke takes it down too.
    await ask();
    assert.match(text(await tool(host.call, "pairbrowse_invite", { action: "revoke_all" })), /Revoked/);
    await until("gone on revoke", async () => (await rowsIn(/two\.pbtest/)).length === 0, 5000);
  } finally {
    host?.sock.destroy();
    joiner?.sock.destroy();
    fixture.close();
    await Promise.all(daemons.map(async (d) => { if (d.exitCode === null) { d.kill("SIGTERM"); await Promise.race([new Promise((r) => d.once("exit", r)), sleep(10_000)]); } }));
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  }
});
