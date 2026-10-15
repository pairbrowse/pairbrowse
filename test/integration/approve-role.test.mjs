// The approve role end to end, with two temporary homes on this computer (a host helper and a
// joiner's helper, each with its own headless browser): the host makes an approve code, the
// joiner joins in shared browser mode, the host's Codex agent asks to click "Pay: Place order",
// and the card shows on the joiner's picture page; the joiner's own click there allows it and the
// host's click goes through, with "Allowed by Alice" in the host's Activity log. Then the host
// switches the invite back to drive: the next ask never reaches the joiner as a card, only as
// "Waiting for Bob to approve" while Claude Code's terminal asks. The sharing tunnel is skipped
// (PAIRBROWSE_TEST_TUNNEL=direct). Needs PAIRBROWSE_TEST_RUNTIME.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync, readFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { testBase, attachDaemon } from "../helpers/live.mjs";
import { rpc, sleep, text } from "../helpers/util.mjs";
import { spawnDaemon, stopDaemon } from "../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const shortBase = testBase();

const SHOP = `<title>Shop</title><main><h1>Checkout</h1><p id="s">Cart: 1 item</p><button type="button" onclick="document.getElementById('s').textContent='Ordered'">Place order</button></main>`;

const tool = (call, name, args = {}) => call("tools/call", { name, arguments: args });
const refOf = (snap, label) => snap.match(new RegExp(`button "${label}"[^\\n]*?\\[ref=(\\w+)\\]`))?.[1];

function home(prefix) {
  mkdirSync(shortBase, { recursive: true });
  const dir = mkdtempSync(join(shortBase, prefix));
  symlinkSync(runtime, join(dir, "runtime"), "dir");
  return dir;
}

test("approve role: a joiner allows the host's agent's Pay click by their own click; back to drive, they only see it wait", { skip: !runtime, timeout: 300_000 }, async () => {
  const require = createRequire(join(runtime, "package.json"));
  const executablePath = require("patchright").chromium.executablePath();
  const fixture = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(SHOP); });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const chromeArgs = ["--headless=new", `--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${fixture.address().port}`];
  const hostHome = home("ah-"), joinHome = home("aj-");
  writeFileSync(join(hostHome, "config.json"), JSON.stringify({ executablePath, chromeArgs, display: "none", screenshots: false, participantName: "Bob" }));
  writeFileSync(join(joinHome, "config.json"), JSON.stringify({ executablePath, chromeArgs, display: "none", screenshots: false, participantName: "Alice" }));
  const env = (h) => ({ ...process.env, PAIRBROWSE_HOME: h, PAIRBROWSE_TEST_SCREEN: "1", PAIRBROWSE_TEST_TUNNEL: "direct", PAIRBROWSE_TEST_JOIN_LOCAL: "1" });
  const daemons = new Map();
  const attach = async (h, app = "claude-code") => {
    const sock = await attachDaemon({ socketPath: join(h, "run", "browser.sock"), daemon: daemons.get(h), home: h });
    const call = rpc((l) => sock.write(l), sock, { ms: 90_000 });
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: app, version: "1" } });
    sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return { sock, call };
  };
  const start = (h) => {
    daemons.set(h, spawnDaemon(h, { env: env(h) }));
    return attach(h);
  };
  const until = async (what, check, ms = 30_000) => {
    let last;
    for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if ((last = await check())) return last;
    throw new Error(`timed out: ${what}`);
  };
  // Claude Code's PermissionRequest hook on the host, as Claude Code runs it.
  let hook = null;
  const conns = [];
  let stage = "start";
  try {
    const host = await start(hostHome);
    const joiner = await start(joinHome);
    conns.push(host, joiner);
    const h = (name, args) => tool(host.call, name, args);

    stage = "the host opens the shop and makes an approve code; Alice joins and is let in";
    assert.ok(!(await h("browser_navigate", { url: "http://shop.pbtest.example/" })).result.isError);
    const made = text(await h("pairbrowse_invite", { action: "create", role: "approve", label: "Alice", share: "code" }));
    assert.match(made, /\(approve\)/);
    assert.match(made, /can also answer your approval cards/);
    const inviteId = made.match(/Invite ([0-9a-f]{8})/)?.[1];
    const code = made.match(/Join code: (pb-join:[A-Za-z0-9_-]+)/)?.[1];
    assert.ok(code && inviteId, made);
    assert.match(text(await tool(joiner.call, "pairbrowse_join", { action: "join", code })), /shared browser/);
    const req = await until("the request", async () => text(await h("pairbrowse_invite", { action: "list" })).match(/request (r[0-9a-f]{6}): Alice/)?.[1]);
    assert.match(text(await h("pairbrowse_invite", { action: "approve", id: req })), /Let Alice in/);
    assert.match(text(await h("pairbrowse_invite", { action: "list" })), /Alice, can drive and approve, join code \(shared browser\)/);

    stage = "the joiner's picture page, in sight";
    const onScreen = async (args) => { const r = text(await tool(joiner.call, "pairbrowse_test_screen", args)); try { return JSON.parse(r); } catch { return null; } };
    const screen = await until("the picture page", async () => (await onScreen({}))?.index >= 0 && await onScreen({}));
    const live = text(await tool(joiner.call, "pairbrowse_liveview")).match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)[0];
    assert.ok((await fetch(`${live}tab`, { method: "POST", body: JSON.stringify({ i: screen.index }) })).ok);
    const card = async () => (await onScreen({ expr: "window.pbScreen && window.pbScreen.approvalState()" }))?.value || [];
    const notice = async () => (await onScreen({ expr: "window.pbScreen && window.pbScreen.noticeText()" }))?.value ?? null;

    stage = "the host's Codex agent asks to pay; the card shows on Alice's picture page";
    const codex = await attach(hostHome, "codex-mcp-client");
    conns.push(codex);
    const c = (name, args) => tool(codex.call, name, args);
    await h("pairbrowse_collaboration", { action: "release" });
    const ref = await until("Place order's ref for Codex", async () => refOf(text(await c("browser_snapshot")), "Place order"));
    const asked = c("browser_click", { target: ref, element: "Pay: Place order" });
    const [row] = await until("the card on the joiner's side", async () => { const r = await card(); return r.length ? r : null; });
    assert.match(row.who, /^Bob's /, "named as the host's agent");
    assert.equal(row.target, "Place order");
    assert.match(row.site, /shop\.pbtest\.example/);
    assert.equal(await notice(), "", "an approver gets the card, not the notice");

    stage = "Alice allows it with her own click: the host's click goes through";
    await until("the card armed (fully visible a moment)", async () => (await card())[0]?.visible === true, 10_000);
    await sleep(900);
    const [armed] = await card();
    assert.equal(text(await tool(joiner.call, "pairbrowse_test_screen", { clickAt: armed.allow })), "clicked");
    const res = await asked;
    assert.ok(!res.result.isError, text(res));
    assert.match(text(await c("browser_snapshot")), /Ordered/);
    await until("the card goes on Alice's side", async () => (await card()).length === 0, 10_000);
    const hostLive = text(await h("pairbrowse_liveview")).match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)[0];
    const activity = await (await fetch(`${hostLive}activity.json`)).text();
    assert.match(activity, /Allowed by Alice: Place order/);
    assert.match(readFileSync(join(hostHome, "daemon.log"), "utf8"), /approval: allow by Alice, who joined with invite/);

    stage = "back to drive: no card for Alice; Codex's ask isn't kept, Claude Code's shows her it waits";
    assert.match(text(await h("pairbrowse_invite", { action: "set_role", id: inviteId, role: "drive" })), /no longer answer/);
    await c("browser_navigate", { url: "http://shop.pbtest.example/" });
    const ref2 = await until("Place order's ref again", async () => refOf(text(await c("browser_snapshot")), "Place order"));
    const handed = await c("browser_click", { target: ref2, element: "Pay: Place order" });
    assert.ok(handed.result.isError, "nowhere to answer: handed to the user at once");
    assert.deepEqual(await card(), []);
    // Claude Code's hook asks (its terminal asks too): Alice sees it wait, nothing to click.
    const claudeRef = await until("Place order's ref for Claude Code", async () => refOf(text(await h("browser_snapshot")), "Place order"));
    hook = spawn(process.execPath, [join(root, "scripts", "guard.mjs")], { env: env(hostHome) });
    hook.stdin.end(JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "s", permission_mode: "default", tool_name: "mcp__plugin_pairbrowse_browser__browser_click", tool_input: { element: "Pay: Place order", target: claudeRef } }));
    await until("the notice on Alice's picture page", async () => (await notice()) === "Waiting for Bob to approve: Pay: Place order", 15_000);
    assert.deepEqual(await card(), [], "no card for a drive joiner");
    hook.kill("SIGTERM");
    await until("the notice goes once the terminal answered", async () => (await notice()) === "", 10_000);
  } catch (e) {
    const kept = join(tmpdir(), `pb-approve-role-fail-${Date.now()}`);
    for (const [hm, tag] of [[hostHome, "host"], [joinHome, "joiner"]]) for (const f of ["daemon.log", "daemon.stderr.log"]) { try { copyFileSync(join(hm, f), `${kept}-${tag}-${f}`); } catch {} }
    let log = ""; try { log = readFileSync(join(hostHome, "daemon.log"), "utf8").slice(-2500); } catch {}
    throw new Error(`${stage}: ${e.message}\n(logs kept at ${kept}-*)\n${log}`);
  } finally {
    if (hook && hook.exitCode === null) hook.kill("SIGKILL");
    for (const cn of conns) cn.sock.destroy();
    fixture.close();
    for (const d of daemons.values()) await stopDaemon(d);
    for (const hm of [hostHome, joinHome]) rmSync(hm, { recursive: true, force: true });
  }
});
