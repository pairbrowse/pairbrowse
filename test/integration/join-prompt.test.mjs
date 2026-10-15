// A join request in the page's bottom bar ("Sam wants to join (drive)", Allow / Deny / close, at
// the bar's right end): shown by the page script, answered only by a real click; and end to end,
// with a host helper and a joiner's (PAIRBROWSE_TEST_TUNNEL=direct, as in
// join.test.mjs): the bar while the browser has the focus, else a notification with
// Allow / Deny, one at a time. Needs PAIRBROWSE_TEST_RUNTIME.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { hudScript } from "../../scripts/browser.mjs";
import { ensureHud, inPage, testBase, attachDaemon } from "../helpers/live.mjs";
import { rpc, sleep, text } from "../helpers/util.mjs";
import { spawnDaemon, stopDaemon } from "../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;

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
    // Synthetic clicks all along the bar's right end, where its Allow is.
    for (let x = innerWidth - 10; x > innerWidth - 400; x -= 10) {
      const at = document.elementFromPoint(x, innerHeight - 15);
      at?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 1, clientX: x, clientY: innerHeight - 15 }));
    }
    for (const r of window.found) for (const b of r.querySelectorAll("button")) { b.click(); hits++; }
    return { hits, text: document.documentElement.innerText.includes("wants to join") };
  };
</script></body>`;

test("the join request in the bottom bar: shows as a card above its right end, goes by itself, can be dismissed, takes only a real click", { skip: !runtime, timeout: 90_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const server = createServer((req, res) => {
    // Strict CSP and Trusted Types, as on YouTube or Google's apps.
    res.writeHead(200, { "content-type": "text/html", "content-security-policy": "require-trusted-types-for 'script'; default-src 'self' 'unsafe-inline'" });
    res.end(HOSTILE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ headless: true });
  try {
    const { source, name, token, tags: hudScriptTags } = hudScript();
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript({ content: source });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await ensureHud(page, source, name);
    const hud = (value, kind) => page.evaluate(([n, t, v, k]) => window[n](t, v, k), [name, token, value, kind]);
    const state = () => hud("", "join-state");
    // The answers recorded for the helper (a chain, newest first), and never in the page's input.
    const answers = async () => {
      assert.ok(!(await hud("", "user")).some((e) => /^join-/.test(e.kind)), "not in the input list");
      const out = [];
      for (let a = (await hud("", "join-answers")).a; a; a = a.next) out.push({ kind: a.kind, what: a.what });
      return out;
    };
    await hud(JSON.stringify({ items: [{ t: Date.now(), text: "Clicked **Next**", who: "" }] }), "bar");
    await hud("x", "claude"); // the badge, which must sit above the card
    const before = await page.evaluate(() => document.documentElement.children.length);

    // Shown as a card above the bar's right end, the bar's own content kept in place: the page's DOM doesn't
    // change (it's inside the bar's closed shadow root).
    assert.equal(await hud({ id: "r00aa01", who: "Sam (Claude Code)", role: "drive" }, "join"), true);
    assert.equal(await hud({ id: "nope", who: "x" }, "join"), false, "a bad id draws nothing");
    let s = await state();
    assert.equal(s.length, 1);
    assert.equal(s[0].who, "Sam (Claude Code)");
    assert.equal(s[0].more, 0);
    assert.ok(s[0].allow.y < 700 - 30 && s[0].allow.y > 700 - 140 && s[0].close.x > 1000 - 40 && s[0].allow.x > 500, `a card above the bottom bar's right end: ${JSON.stringify(s[0])}`);
    assert.equal(await page.evaluate(() => document.documentElement.children.length), before, "no new element in the page");
    // The badge never covers the card: its bottom is above the card's top (the close sits near it).
    const badgeBottom = await page.evaluate((tag) => document.querySelector(tag).getBoundingClientRect().bottom, hudScriptTags.hud);
    assert.ok(badgeBottom < s[0].close.y - 6, `the badge (bottom ${badgeBottom}) is above the card (close at ${s[0].close.y})`);
    // The pointer near the bottom: the bar doesn't fade while it asks.
    await page.mouse.move(100, 690);
    await sleep(300);
    const shot = await page.screenshot();
    assert.ok(shot.length > 0);

    // The page can't see, click or fake it.
    await sleep(800); // armed
    const tried = await inPage(page, () => window.tryEverything());
    assert.equal(tried.text, false, "the page can't read it");
    await inPage(page, () => document.documentElement.click());
    assert.deepEqual(await answers(), [], "no answer from a page's clicks");
    assert.equal(await inPage(page, ([n]) => window[n]("guess", "", "join-state"), [name]), false, "no state without the key");
    assert.equal((await state()).length, 1, "still there");

    // A newer request: the bar shows it, with "+1 more"; a real click just then doesn't count
    // (what's under the pointer just changed); nor from the keyboard.
    await hud({ id: "r00aa02", who: "Ann", role: "watch" }, "join");
    s = await state();
    assert.equal(s.length, 1);
    assert.equal(s[0].id, "r00aa02", "the newest");
    assert.equal(s[0].more, 1);
    await page.mouse.click(s[0].allow.x, s[0].allow.y);
    assert.deepEqual(await answers(), [], "it just changed: not yet");
    await page.keyboard.press("Enter");
    assert.deepEqual(await answers(), []);

    // A real click on Allow, once armed: recorded for the helper with the shown request's id.
    await sleep(800);
    s = await state();
    await page.mouse.click(s[0].allow.x, s[0].allow.y);
    let got = await answers();
    assert.deepEqual(got.map((e) => [e.kind, e.what]), [["join-allow", "r00aa02"]]);
    // Answered (the helper takes it down): the bar shows the one before.
    assert.equal(await hud("r00aa02", "join-off"), true);
    s = await state();
    assert.equal(s.length, 1);
    assert.equal(s[0].id, "r00aa01");
    assert.equal(s[0].more, 0);

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

    // The close button dismisses it (nothing is answered); the bar is back to normal.
    s = await state();
    await page.mouse.click(s[0].close.x, s[0].close.y);
    assert.equal((await state()).length, 0, "dismissed");
    assert.deepEqual(await answers(), []);
    assert.equal((await hud("", "join-answers")).gone, "", "dismissed, not timed out");

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
    assert.match((await hud("", "join-answers")).gone, /r00aa04/, "its time ran out (the helper may ask again)");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});

// ---- end to end: a host helper and a joiner's, each with its own headless browser -------------
const shortBase = testBase();
const tool = (call, name, args = {}) => call("tools/call", { name, arguments: args });

test("a join request: the bar in the host's tab in front when the browser has the focus (no notification), else a notification; only the person's own click answers", { skip: !runtime, timeout: 240_000 }, async () => {
  const require = createRequire(join(runtime, "package.json"));
  const executablePath = require("patchright").chromium.executablePath();
  const fixture = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<title>${req.headers.host}</title><main>fixture</main>`); });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const chromeArgs = ["--headless=new", `--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${fixture.address().port}`];
  const homes = [];
  const home = (prefix, name) => {
    mkdirSync(shortBase, { recursive: true });
    const dir = mkdtempSync(join(shortBase, prefix));
    symlinkSync(runtime, join(dir, "runtime"), "dir");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ executablePath, chromeArgs, display: "none", screenshots: false, participantName: name }));
    homes.push(dir);
    return dir;
  };
  const daemons = [];
  const connect = async (h) => {
    daemons.push(spawnDaemon(h, { env: { PAIRBROWSE_TEST_TUNNEL: "direct", PAIRBROWSE_TEST_JOIN_LOCAL: "1", PAIRBROWSE_TEST_JOIN_PROMPT: "1" } }));
    const socketPath = join(h, "run", "browser.sock");
    const sock = await attachDaemon({ socketPath, daemon: daemons.at(-1), home: h });
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
    const hostHome = home("ph-", "Bob");
    host = await connect(hostHome);
    // The join notifications the host's helper sent (its log), by request.
    const notified = (id) => existsSync(join(hostHome, "daemon.log")) && new RegExp(`notification sent \\(join request ${id}`).test(readFileSync(join(hostHome, "daemon.log"), "utf8"));
    const notifiedAny = () => existsSync(join(hostHome, "daemon.log")) && /notification sent \(join request/.test(readFileSync(join(hostHome, "daemon.log"), "utf8"));
    joiner = await connect(home("pj-", "Alice"));
    assert.ok(!(await tool(host.call, "browser_navigate", { url: "http://one.pbtest.example/" })).result.isError);
    assert.ok(!(await tool(host.call, "browser_tabs", { action: "new" })).result.isError);
    assert.ok(!(await tool(host.call, "browser_navigate", { url: "http://two.pbtest.example/" })).result.isError);
    const prompts = async () => JSON.parse(text(await tool(host.call, "pairbrowse_test_join_prompt")));
    const rowsIn = async (re) => (await prompts()).find((p) => re.test(p.url))?.rows || [];
    const click = async (args) => text(await tool(host.call, "pairbrowse_test_join_prompt", args));
    const requests = async () => text(await tool(host.call, "pairbrowse_invite", { action: "list" }));
    // The person looks at the browser (a headless browser has no window focus to read: set here).
    assert.equal(await click({ focus: true }), "focus true");
    // A no stays for that invite (Alice asking again on it is turned away at once): after each
    // no, a new code.
    const newCode = async () => text(await tool(host.call, "pairbrowse_invite", { action: "create", role: "drive", label: "Alice", share: "code", mode: "follow" })).match(/Join code: (pb-join:[A-Za-z0-9_-]+)/)?.[1];
    let code = await newCode();
    assert.ok(code);
    const ask = async () => {
      await tool(host.call, "pairbrowse_test_join_prompt", { move: true }); // the pointer away from the bar
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
    assert.equal(notified(first), false, "the bar asked: no notification");

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
    assert.match(text(await tool(joiner.call, "pairbrowse_join", { action: "join", code })), /didn't let you in/, "asking again on that invite: the same no");
    code = await newCode();

    // Deny by the person's click.
    const fifth = await ask();
    await sleep(800);
    await click({ click: "deny" });
    await until("turned away", async () => new RegExp(`request ${fifth}: Alice \\(Claude Code\\), turned away`).test(await requests()));
    await until("the prompt goes", async () => (await rowsIn(/two\.pbtest/)).length === 0, 4000);
    code = await newCode();

    // One alert at a time: none of those sent a notification.
    assert.equal(notifiedAny(), false, "no notification while the bar asked");

    // The person in another app: a notification with Allow / Deny, nothing in the page; back in
    // the browser, the bar asks for the request still waiting, and no second notification.
    assert.equal(await click({ focus: false }), "focus false");
    await tool(host.call, "pairbrowse_test_join_prompt", { move: true });
    assert.match(text(await tool(joiner.call, "pairbrowse_join", { action: "join", code })), /Asked Bob to let Alice in/);
    const away = await until("the request", async () => (await requests()).match(/request (r[0-9a-f]{6}): Alice \(Claude Code\), waiting/)?.[1]);
    await until("the notification", async () => notified(away), 15_000);
    const notes = JSON.parse(text(await tool(host.call, "pairbrowse_test_join_prompt", { notes: true })));
    assert.deepEqual(notes, [away], "a notification with Allow / Deny for that request");
    await sleep(1500);
    assert.equal((await rowsIn(/two\.pbtest/)).length, 0, "nothing in the page while no one looks");
    assert.equal(await click({ focus: true }), "focus true");
    await until("the bar asks on return", async () => (await rowsIn(/two\.pbtest/))[0]?.id === away, 8000);
    await sleep(800);
    assert.equal(await click({ click: "allow" }), "clicked");
    await until("let in", async () => new RegExp(`request ${away}: Alice \\(Claude Code\\), let in`).test(await requests()));
    await until("its notification goes", async () => { const n = JSON.parse(text(await tool(host.call, "pairbrowse_test_join_prompt", { notes: true }))); return Array.isArray(n) && n.length === 0; }, 8000);
    const log = readFileSync(join(hostHome, "daemon.log"), "utf8");
    assert.equal(log.match(new RegExp(`notification sent \\(join request ${away}`, "g"))?.length, 1, "one notification, once");

    // The notification's own Allow button, pressed while the person is in another app.
    assert.equal(await click({ focus: false }), "focus false");
    await tool(joiner.call, "pairbrowse_join", { action: "leave" });
    const code2 = text(await tool(host.call, "pairbrowse_invite", { action: "create", role: "drive", label: "Alice", share: "code", mode: "follow" })).match(/Join code: (pb-join:[A-Za-z0-9_-]+)/)?.[1];
    assert.match(text(await tool(joiner.call, "pairbrowse_join", { action: "join", code: code2 })), /Asked Bob to let Alice in/);
    const pressed = await until("the second request", async () => (await requests()).match(/request (r[0-9a-f]{6}): Alice \(Claude Code\), waiting/)?.[1]);
    await until("its notification", async () => notified(pressed), 15_000);
    assert.equal(text(await tool(host.call, "pairbrowse_test_join_prompt", { press: "allow", request: pressed })), "true", "the button's press went through");
    await until("let in by the notification", async () => new RegExp(`request ${pressed}: Alice \\(Claude Code\\), let in`).test(await requests()));
    assert.equal(await click({ focus: true }), "focus true");

    // A revoke takes it down too.
    await ask();
    assert.match(text(await tool(host.call, "pairbrowse_invite", { action: "revoke_all" })), /Revoked/);
    await until("gone on revoke", async () => (await rowsIn(/two\.pbtest/)).length === 0, 5000);

    // Then the person asks to switch session (the side panel's "Switch session...", the live view's
    // picker route): the host's agent still gets an answer at once or after the pick's wait (the
    // picker is waiting, or the tabs), never a call held behind the join's cleanup.
    const live = text(await tool(host.call, "pairbrowse_liveview")).match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)[0];
    assert.equal((await fetch(live + "picker", { method: "POST" })).status, 200);
    const asked = Date.now();
    const tabs = text(await tool(host.call, "browser_tabs", { action: "list" }).catch((e) => ({ error: { message: String(e) } })));
    assert.ok(Date.now() - asked < 20_000, `browser_tabs answered after ${Date.now() - asked} ms`);
    assert.match(tabs, /waiting for the person to pick a session|pbtest/, `the picker is waiting, or the tabs: ${tabs.slice(0, 200)}`);
  } finally {
    host?.sock.destroy();
    joiner?.sock.destroy();
    fixture.close();
    await Promise.all(daemons.map(async (d) => { await stopDaemon(d); }));
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  }
});
