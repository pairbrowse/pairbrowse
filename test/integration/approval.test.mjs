// A named final click asked in the browser as well as in the agent's app: the approval card in
// the page's bottom bar ("Claude wants to click", the target, the rule's reason, Allow / Deny / Ask
// in the terminal, ×), answered only by a person's own click; and end to end, with the helper, its
// PermissionRequest hook (scripts/guard.mjs, as Claude Code runs it) and a Codex session. Needs
// PAIRBROWSE_TEST_RUNTIME.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, readFileSync, rmSync, openSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { hudScript } from "../../scripts/browser.mjs";
import { ensureHud, inPage, testBase, attachDaemon } from "../helpers/live.mjs";
import { rpc, sleep, text } from "../helpers/util.mjs";
import { stopDaemon } from "../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const ID = (c) => `ap-${c.repeat(32)}`;

// A page that tries what a page can: find the card, click it, fake an answer.
const HOSTILE = `<title>hostile</title><body style="height:2000px">page
<script>
  window.found = [];
  const orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (o) { const r = orig.call(this, o); window.found.push(r); return r; };
  window.tryEverything = () => {
    for (const el of document.querySelectorAll("*")) for (const b of el.shadowRoot?.querySelectorAll("button") || []) b.click();
    for (let x = innerWidth - 10; x > innerWidth - 400; x -= 10) for (let y = innerHeight - 40; y > innerHeight - 260; y -= 20) {
      const at = document.elementFromPoint(x, y);
      at?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, detail: 1, clientX: x, clientY: y }));
    }
    for (const r of window.found) for (const b of r.querySelectorAll("button")) b.click();
    return { text: document.documentElement.innerText.includes("wants to click") };
  };
</script></body>`;

test("the approval card in the bottom bar: above its right end, takes only a person's armed click, alternates with join requests, hides for screenshots", { skip: !runtime, timeout: 90_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html", "content-security-policy": "require-trusted-types-for 'script'; default-src 'self' 'unsafe-inline'" });
    res.end(HOSTILE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ headless: true });
  try {
    const { source, name, token, tags } = hudScript();
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript({ content: source });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await ensureHud(page, source, name);
    const hud = (value, kind) => page.evaluate(([n, t, v, k]) => window[n](t, v, k), [name, token, value, kind]);
    const state = () => hud("", "approval-state");
    const answers = async () => {
      assert.ok(!(await hud("", "user")).some((e) => /^approval-/.test(e.kind)), "not in the input list");
      const got = await hud("", "approval-answers");
      const out = [];
      for (let a = got.a; a; a = a.next) out.push([a.kind, a.what]);
      return { list: out, ids: got.ids, dismissed: got.dismissed };
    };
    await hud(JSON.stringify({ items: [{ t: Date.now(), text: "Clicked **Next**", who: "" }] }), "bar");
    await hud("x", "claude");
    const before = await page.evaluate(() => document.documentElement.children.length);

    assert.equal(await hud({ id: ID("a"), who: "Alice · Codex", color: "#20c997", target: "Place order", reason: '"Pay: Place order" pays: a final action (pay)' }, "approval"), true);
    for (const bad of [{ id: "ap-1", who: "x" }, { id: "r00aa01", who: "x" }, { id: ID("A"), who: "x" }, null, "text"]) assert.equal(await hud(bad, "approval"), false, JSON.stringify(bad));
    let s = await state();
    assert.equal(s.length, 1);
    assert.equal(s[0].id, ID("a"));
    assert.equal(s[0].who, "Alice · Codex");
    assert.equal(s[0].target, "Place order");
    assert.match(s[0].reason, /final action \(pay\)/);
    assert.equal(s[0].more, 0);
    assert.ok(s[0].allow.y < 700 - 30 && s[0].allow.y > 700 - 260, `above the bar: ${JSON.stringify(s[0])}`);
    assert.ok(s[0].close.x > 1000 - 50 && s[0].allow.x > 1000 - 360 - 20, `at its right end, 360 px wide: ${JSON.stringify(s[0])}`);
    assert.ok(s[0].terminal.x > s[0].deny.x && s[0].deny.x > s[0].allow.x, "Allow, Deny, Ask in the terminal");
    assert.equal(await page.evaluate(() => document.documentElement.children.length), before, "no new element in the page");
    assert.equal(await page.evaluate(() => Object.keys(window).filter((k) => /approv/i.test(k)).length), 0, "no window property");
    const badgeBottom = await page.evaluate((tag) => document.querySelector(tag).getBoundingClientRect().bottom, tags.hud);
    assert.ok(badgeBottom < s[0].close.y - 6, `the badge (bottom ${badgeBottom}) is lifted above the card (close at ${s[0].close.y})`);

    // Too soon after it showed: a real click doesn't count.
    await page.mouse.click(s[0].allow.x, s[0].allow.y);
    assert.deepEqual((await answers()).list, [], "not armed yet");
    // The page can't see, click or fake it; keys don't answer it.
    await sleep(800);
    assert.equal((await inPage(page, () => window.tryEverything())).text, false, "the page can't read it");
    await page.keyboard.press("Enter");
    assert.deepEqual((await answers()).list, [], "no answer from the page's clicks or a key");
    assert.equal(await inPage(page, ([n]) => window[n]("guess", "", "approval-state"), [name]), false, "no state without the key");

    // A person's click, armed: recorded with the id, for the helper to check again.
    s = await state();
    await page.mouse.click(s[0].allow.x, s[0].allow.y);
    let got = await answers();
    assert.deepEqual(got.list, [["approval-allow", ID("a")]]);
    assert.equal(got.ids, ID("a"), "still shown until the helper takes it down");
    assert.equal(await hud(ID("a"), "approval-off"), true);
    assert.equal((await state()).length, 0);

    // A join request and an approval: the approval shows first, the join request after it.
    await hud({ id: "r00aa01", who: "Sam (Claude Code)", role: "drive" }, "join");
    assert.equal((await hud("", "join-state")).length, 1);
    await hud({ id: ID("b"), who: "Claude", color: "#e9763f", target: "Delete store", reason: "" }, "approval");
    assert.equal((await hud("", "join-state")).length, 0, "the approval goes first");
    s = await state();
    assert.equal(s[0].id, ID("b"));
    assert.equal(s[0].reason, "");
    await hud({ id: ID("c"), who: "Claude", color: "nope", target: "Send: x", reason: "r" }, "approval");
    s = await state();
    assert.equal(s[0].id, ID("c"), "the newest");
    assert.equal(s[0].more, 1);
    // Deny and Ask in the terminal, each by a person's armed click.
    await sleep(800);
    await page.mouse.click(s[0].deny.x, s[0].deny.y);
    assert.deepEqual((await answers()).list, [["approval-deny", ID("c")]]);
    await hud(ID("c"), "approval-off");
    await sleep(800);
    s = await state();
    assert.equal(s[0].id, ID("b"));
    await page.mouse.click(s[0].terminal.x, s[0].terminal.y);
    assert.deepEqual((await answers()).list, [["approval-terminal", ID("b")]]);
    await hud(ID("b"), "approval-off");
    assert.equal((await hud("", "join-state")).length, 1, "the join request is back");
    await hud("r00aa01", "join-off");

    // × hides it here (nothing answered; the terminal still asks).
    await hud({ id: ID("d"), who: "Claude", color: "#e9763f", target: "Place order", reason: "r" }, "approval");
    await sleep(800);
    s = await state();
    await page.mouse.click(s[0].close.x, s[0].close.y);
    got = await answers();
    assert.deepEqual(got.list, []);
    assert.equal(got.dismissed, `,${ID("d")}`);
    assert.equal((await state()).length, 0);

    // Claude Code (and an ask with no say, as before): the terminal asks too.
    await hud({ id: ID("f"), who: "Claude", color: "#e9763f", target: "Place order", reason: "r", terminal: true }, "approval");
    s = await state();
    assert.equal(s[0].terminalLabel, "Ask in the terminal");
    assert.equal(s[0].closeTitle, "Hide here (the terminal still asks)");
    await hud(ID("f"), "approval-off");
    // Codex and other apps have no terminal prompt: the third button hands the step over, and the
    // × says what really happens.
    await hud({ id: ID("9"), who: "Alice · Codex", color: "#20c997", target: "Place order", reason: "r", terminal: false }, "approval");
    s = await state();
    assert.equal(s[0].terminalLabel, "I'll do it myself");
    assert.equal(s[0].closeTitle, "Hide here (the agent waits, then hands this step to you)");
    assert.equal(await hud({ id: ID("8"), who: "x", terminal: "no" }, "approval"), true, "a non-boolean is ignored");
    s = await state();
    assert.equal(s[0].terminalLabel, "Ask in the terminal");
    await hud(ID("8"), "approval-off");
    await hud(ID("9"), "approval-off");
    assert.equal((await state()).length, 0);

    // While an agent takes a screenshot: hidden, and no click counts.
    await hud({ id: ID("e"), who: "Claude", color: "#e9763f", target: "Place order", reason: "r" }, "approval");
    await sleep(800);
    s = await state();
    assert.equal(s[0].visible, true);
    await hud("1", "peers-hidden");
    await sleep(300);
    const hidden = await state();
    assert.equal(hidden[0].visible, false, "hidden for the screenshot");
    await page.mouse.click(s[0].allow.x, s[0].allow.y);
    assert.deepEqual((await answers()).list, []);
    await hud("", "peers-hidden");
    await sleep(800);
    assert.equal((await state())[0].visible, true, "back after it");
    // No timer of its own: it stays until it's answered or taken down. A join request under it
    // isn't timed out unseen either (its 10 s start when it shows), even after the pointer leaves.
    await hud({ id: "r00aa02", who: "Sam (Claude Code)", role: "watch" }, "join");
    s = await state();
    await page.mouse.move(s[0].allow.x, s[0].allow.y);
    await page.mouse.move(10, 10);
    await sleep(11_000);
    assert.equal((await state()).length, 1, "no auto-hide");
    await hud(ID("e"), "approval-off");
    assert.equal((await hud("", "join-state")).length, 1, "the join request shows once the approval goes");
    await hud("r00aa02", "join-off");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});

// ---- end to end ----------------------------------------------------------------------------------

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const shortBase = testBase();
const tool = (call, name, args = {}) => call("tools/call", { name, arguments: args });
const refOf = (snap, label) => snap.match(new RegExp(`button "${label}"[^\\n]*?\\[ref=(\\w+)\\]`))?.[1];

test("a named click asked in the browser and the terminal at once: the first answer wins, the other goes; Codex waits for the card", { skip: !runtime, timeout: 300_000 }, async () => {
  const require = createRequire(join(runtime, "package.json"));
  const executablePath = require("patchright").chromium.executablePath();
  const fixture = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<title>Shop</title><main><h1>Checkout</h1><p id="s">Cart: 1 item</p><button type="button" onclick="document.getElementById('s').textContent='Ordered'">Place order</button></main>`);
  });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  mkdirSync(shortBase, { recursive: true });
  const home = mkdtempSync(join(shortBase, "pa-"));
  symlinkSync(runtime, join(home, "runtime"), "dir");
  writeFileSync(join(home, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new", `--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${fixture.address().port}`], display: "none", screenshots: false, participantName: "Bob" }));
  const env = { ...process.env, PAIRBROWSE_HOME: home, PAIRBROWSE_APPROVAL_WAIT_MS: "4000" };
  const out = openSync(join(home, "daemon.stderr.log"), "a");
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...env, PAIRBROWSE_TEST_APPROVAL: "1" }, stdio: ["ignore", out, out] });
  const socketPath = join(home, "run", "browser.sock");
  const connect = async (client) => {
    const sock = await attachDaemon({ socketPath, daemon, home });
    const call = rpc((l) => sock.write(l), sock);
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: client, version: "1" } });
    sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return { sock, call };
  };
  const until = async (what, check, ms = 20_000) => {
    let last;
    for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) if ((last = await check())) return last;
    throw new Error(`timed out: ${what}`);
  };
  // The hook as Claude Code runs it: its stdout, its exit.
  const hooks = [];
  const runHook = (ref) => {
    const child = spawn(process.execPath, [join(root, "scripts", "guard.mjs")], { env });
    const h = { out: "", exited: false, child };
    child.stdout.on("data", (d) => (h.out += d));
    h.done = new Promise((r) => child.on("exit", (code) => { h.exited = true; h.code = code; r(h); }));
    child.stdin.end(JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "s", permission_mode: "default", tool_name: "mcp__plugin_pairbrowse_browser__browser_click", tool_input: { element: "Pay: Place order", target: ref } }));
    hooks.push(h);
    return h;
  };
  let stage = "start", claude, codex;
  try {
    claude = await connect("claude-code");
    const t = (name, args) => tool(claude.call, name, args);
    const cards = async () => JSON.parse(text(await t("pairbrowse_test_approval"))).flatMap((p) => p.rows);
    const pending = async () => JSON.parse(text(await t("pairbrowse_test_approval", { pending: true })));
    const press = async (click, as) => text(await t("pairbrowse_test_approval", { click, ...(as ? { as } : {}) }));
    const fresh = async () => {
      assert.ok(!(await t("browser_navigate", { url: "http://shop.pbtest.example/" })).result.isError);
      const ref = refOf(text(await t("browser_snapshot")), "Place order");
      assert.ok(ref, "a ref for Place order");
      await t("pairbrowse_test_approval", { move: true });
      return ref;
    };
    const asked = async (h) => {
      const [card] = await until("the card", async () => { const c = await cards(); return c.length ? c : null; });
      const [item] = await pending();
      assert.ok(item, "an approval is pending");
      return { card, item, h };
    };

    stage = "(a) answered in the browser: only the person's own click counts";
    for (const as of ["page", "agent", "joiner", "liveview"]) {
      const h = runHook(await fresh());
      const { card, item } = await asked(h);
      if (as === "page") {
        assert.ok(card.who, "named for the session");
        assert.equal(card.target, "Place order");
        assert.equal(item.reason, '"Pay: Place order" pays: a final action (pay)');
        assert.match(item.id, /^ap-[0-9a-f]{32}$/);
        assert.deepEqual(Object.keys(item).sort(), ["agent", "at", "id", "kind", "reason", "tab", "target"]);
        assert.equal(item.tab.host, "shop.pbtest.example");
      }
      await sleep(800);
      await press("allow", as);
      await sleep(900);
      assert.equal((await pending()).length, 1, `${as}: still pending`);
      assert.equal(h.exited, false, `${as}: the hook still waits`);
      h.child.kill("SIGTERM");
      await h.done;
      await until(`${as}: withdrawn once the hook stopped`, async () => (await pending()).length === 0, 5000);
    }
    let ref = await fresh();
    let h = runHook(ref);
    await asked(h);
    await sleep(1500); // the agent's last action (the navigation) well past, as for a person's click
    assert.equal(await press("allow"), "clicked");
    await h.done;
    assert.deepEqual(JSON.parse(h.out), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    await until("the card goes", async () => (await cards()).length === 0, 5000);
    assert.deepEqual(await pending(), []);
    const clicked = await t("browser_click", { target: ref, element: "Pay: Place order" });
    assert.ok(!clicked.result.isError, text(clicked));
    assert.match(text(await t("browser_snapshot")), /Ordered/);

    stage = "(a2) allowed in the browser, then the tab went to another site: the click is refused, to be asked again";
    ref = await fresh();
    h = runHook(ref);
    await asked(h);
    await sleep(1500);
    assert.equal(await press("allow"), "clicked");
    await h.done;
    assert.equal(JSON.parse(h.out).hookSpecificOutput.decision.behavior, "allow");
    assert.ok(!(await t("browser_navigate", { url: "http://other.pbtest.example/" })).result.isError);
    await t("browser_snapshot");
    const moved = await t("browser_click", { target: ref, element: "Pay: Place order" });
    assert.ok(moved.result.isError, text(moved));
    assert.match(text(moved), /^Not done: the user allowed this in the PairBrowse browser for http:\/\/shop\.pbtest\.example, but the tab has changed since \(it is now on http:\/\/other\.pbtest\.example\)/);
    assert.doesNotMatch(text(await t("browser_snapshot")), /Ordered/, "nothing clicked");

    stage = "(b) answered in the terminal: the call arrives, the card goes, the hook says nothing";
    ref = await fresh();
    h = runHook(ref);
    await asked(h);
    const yes = await t("browser_click", { target: ref, element: "Pay: Place order" });
    assert.ok(!yes.result.isError, text(yes));
    await h.done;
    assert.equal(h.out, "");
    assert.equal(h.code, 0);
    assert.deepEqual(await pending(), []);
    await until("the card goes", async () => (await cards()).length === 0, 5000);

    stage = "(c) the terminal's no: the hook is stopped, the card goes";
    h = runHook(await fresh());
    await asked(h);
    h.child.kill("SIGTERM");
    await h.done;
    await until("withdrawn", async () => (await pending()).length === 0 && (await cards()).length === 0, 5000);

    stage = "(d) nobody answers in the browser: the hook says nothing after the wait, the card goes";
    h = runHook(await fresh());
    await asked(h);
    const from = Date.now();
    await h.done;
    assert.equal(h.out, "");
    assert.ok(Date.now() - from < 8000, `${Date.now() - from} ms`);
    await until("the card goes", async () => (await cards()).length === 0, 3000);

    stage = "(e) answered through the live view's route with the owner's key";
    const live = text(await t("pairbrowse_liveview")).match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)[0];
    h = runHook(await fresh());
    const { item } = await asked(h);
    const listed = await (await fetch(`${live}approvals.json`)).json();
    assert.deepEqual(listed.pending.map((p) => p.id), [item.id]);
    const answer = await fetch(`${live}approve`, { method: "POST", headers: { "content-type": "application/json", origin: new URL(live).origin }, body: JSON.stringify({ id: item.id, answer: "deny" }) });
    assert.equal(answer.status, 200);
    await h.done;
    assert.equal(JSON.parse(h.out).hookSpecificOutput.decision.behavior, "deny");
    assert.equal(JSON.parse(h.out).hookSpecificOutput.decision.message, "pairbrowse: Denied in the PairBrowse browser.");
    await until("the card goes", async () => (await cards()).length === 0, 5000);

    stage = "(f) Codex: the click waits for the card";
    codex = await connect("codex-mcp-client");
    const c = (name, args) => tool(codex.call, name, args);
    assert.ok(!(await c("browser_tabs", { action: "new", url: "http://shop.pbtest.example/" })).result.isError);
    const codexClick = async () => {
      const r = refOf(text(await c("browser_snapshot")), "Place order");
      assert.ok(r);
      await t("pairbrowse_test_approval", { move: true });
      return c("browser_click", { target: r, element: "Pay: Place order" });
    };
    let call = codexClick();
    await until("the Codex card", async () => (await cards()).length === 1);
    await sleep(1500);
    assert.equal(await press("allow"), "clicked");
    let res = await call;
    assert.ok(!res.result.isError, text(res));
    call = codexClick();
    await until("the Codex card", async () => (await cards()).length === 1);
    await sleep(1500);
    await press("deny");
    res = await call;
    assert.ok(res.result.isError);
    assert.match(text(res), /^Denied in the PairBrowse browser\. pairbrowse: "Pay: Place order" pays: a final action \(pay\)\. This needs the user's OK, which this app can't ask for\./);
    call = codexClick();
    await until("the Codex card", async () => (await cards()).length === 1);
    res = await call;
    assert.ok(res.result.isError);
    assert.match(text(res), /^pairbrowse: "Pay: Place order" pays: a final action \(pay\)\. This needs the user's OK, which this app can't ask for\./, "no answer: today's hand-off");
    await until("the card goes", async () => (await cards()).length === 0, 3000);
  } catch (e) {
    let log = ""; try { log = readFileSync(join(home, "daemon.log"), "utf8").slice(-3000); } catch {}
    // The evidence kept past the home's removal below: the helper's whole log and its stderr.
    const kept = join(tmpdir(), `pb-approval-fail-${Date.now()}`);
    for (const [from, to] of [["daemon.log", ".log"], ["daemon.stderr.log", ".stderr.log"]]) { try { copyFileSync(join(home, from), kept + to); } catch {} }
    throw new Error(`${stage}: ${e.message}\n(logs kept at ${kept}.log and ${kept}.stderr.log)\n${log}`);
  } finally {
    for (const h of hooks) if (!h.exited) h.child.kill("SIGKILL");
    claude?.sock.destroy();
    codex?.sock.destroy();
    fixture.close();
    await stopDaemon(daemon);
    rmSync(home, { recursive: true, force: true });
  }
});
