// End to end, two helpers on this computer (a host and a drive joiner, each with its own headless
// browser), for the owner's rules in shared sessions: an agent on one computer holding a tab makes
// the other computer's agents wait or hear "in use" (never typing into their copy); where each
// person reads crosses; a payment form's "Submit order" is a final action by structure; a card
// number replacing a plain value leaves no stale value and echoes nothing. Like
// join.integration.test.mjs: PAIRBROWSE_TEST_RUNTIME, the upstream Playwright driver, no tunnel.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync, existsSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shortBase = existsSync("/Volumes/BACKUP/PairBrowse") ? "/Volumes/BACKUP/PairBrowse" : tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A checkout: a plain "Pay with" note field, a card field, and "Submit order" (no word list
// names it); a long page to scroll.
const CHECKOUT = `<title>Checkout</title><main><h1>Checkout</h1><form action="/submitted">
<label>Pay with <input id="pay" name="paywith"></label>
<label>Card number <input id="card" name="cardnumber" autocomplete="cc-number"></label>
<label>Notes <input id="notes" name="notes"></label>
<button>Submit order</button></form><div style="height:5000px"></div></main>`;

// A multi-step form's "Next" and a sign-up's last step: only the commit is asked for.
const WIZARD = `<title>Sign up</title><main><form method="post" action="/wizard/2"><label>First name <input name="first"></label>
<label>Last name <input name="last"></label><button>Next</button></form>
<form method="post" action="/wizard/done"><label>Email <input name="email"></label><label>Company <input name="company"></label><button>Create account</button></form></main>`;

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
function home(prefix) {
  mkdirSync(shortBase, { recursive: true });
  const dir = mkdtempSync(join(shortBase, prefix));
  symlinkSync(runtime, join(dir, "runtime"), "dir");
  return dir;
}

test("shared sessions: agent turns across computers, scroll presence, payment forms by structure, card values", { skip: !runtime, timeout: 300_000 }, async () => {
  const require = createRequire(join(runtime, "package.json"));
  const executablePath = require("playwright").chromium.executablePath();
  let submitted = 0;
  const fixture = createServer((req, res) => {
    if (req.url.startsWith("/submitted")) submitted++;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url.startsWith("/checkout") ? CHECKOUT : req.url.startsWith("/wizard") ? WIZARD : `<title>${req.headers.host}${req.url}</title><main>fixture</main>`);
  });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const port = fixture.address().port;
  const chromeArgs = ["--headless=new", `--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${port}`];
  const hostHome = home("sh-");
  const joinHome = home("sj-");
  writeFileSync(join(hostHome, "config.json"), JSON.stringify({ executablePath, chromeArgs, display: "none", screenshots: false, participantName: "Bob", browserDriver: "playwright" }));
  writeFileSync(join(joinHome, "config.json"), JSON.stringify({ executablePath, chromeArgs, display: "none", screenshots: false, participantName: "Alice", browserDriver: "playwright" }));
  const env = (h) => ({ ...process.env, PAIRBROWSE_HOME: h, PAIRBROWSE_TEST_TUNNEL: "direct", PAIRBROWSE_TEST_JOIN_LOCAL: "1" });
  const daemons = [];
  const connect = async (h) => {
    const out = openSync(join(h, "daemon.stderr.log"), "a");
    daemons.push(spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: env(h), stdio: ["ignore", out, out] }));
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 100 && !existsSync(socketPath); i++) await sleep(50);
    const sock = net.createConnection(socketPath);
    await new Promise((ok, no) => { sock.once("connect", ok); sock.once("error", no); });
    const call = rpc((l) => sock.write(l), sock);
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } });
    sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return { sock, call };
  };
  const tabs = async (call) => [...text(await tool(call, "browser_tabs", { action: "list" })).matchAll(/^- (\d+):( \(current\))? \[([^\n]*)\]\(([^)\s]*)\)/gm)].map((m) => ({ index: Number(m[1]), title: m[3], url: m[4] }));
  const until = async (what, check, ms = 30_000) => {
    let last;
    for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if ((last = await check())) return last;
    throw new Error(`timed out: ${what}`);
  };
  const select = async (call, re) => {
    const t = (await tabs(call)).find((x) => re.test(x.url));
    assert.ok(t, `a tab matching ${re}`);
    assert.ok(!(await tool(call, "browser_tabs", { action: "select", index: t.index })).result.isError);
    return t;
  };
  const snap = async (call) => text(await tool(call, "browser_snapshot"));
  const ref = (snapshot, role, name) => snapshot.match(new RegExp(`${role} "${name}"[^\\n]*\\[ref=(f?\\d*e\\d+)\\]`))?.[1];
  let host, joiner, stage = "start";
  try {
    host = await connect(hostHome);
    joiner = await connect(joinHome);
    assert.ok(!(await tool(host.call, "browser_navigate", { url: "http://shop.pbtest.example/checkout" })).result.isError);

    stage = "Alice joins to drive; a watcher's channel shows what crosses";
    const codeOf = (made) => made.match(/Join code: (pb-join:[A-Za-z0-9_-]+)/)?.[1];
    const code = codeOf(text(await tool(host.call, "pairbrowse_invite", { action: "create", role: "drive", label: "Alice", share: "code" })));
    assert.match(text(await tool(joiner.call, "pairbrowse_join", { action: "join", code, name: "Alice" })), /Asked Bob to let Alice in/);
    const aliceReq = await until("Alice's request", async () => text(await tool(host.call, "pairbrowse_invite", { action: "list" })).match(/request (r[0-9a-f]{6}): Alice/)?.[1]);
    await tool(host.call, "pairbrowse_invite", { action: "approve", id: aliceReq });
    const { parseJoinCode } = await import("../scripts/join.mjs");
    const carolCode = parseJoinCode(codeOf(text(await tool(host.call, "pairbrowse_invite", { action: "create", role: "watch", label: "Carol", share: "code" }))), { allowLocal: true });
    const carolHeaders = { "x-pairbrowse-joiner": "c".repeat(32), "x-pairbrowse-name": "Carol", "x-pairbrowse-app": "" };
    await fetch(`${carolCode.url}/${carolCode.key}/tabs`, { headers: carolHeaders });
    const carolReq = await until("Carol's request", async () => text(await tool(host.call, "pairbrowse_invite", { action: "list" })).match(/request (r[0-9a-f]{6}): Carol/)?.[1]);
    await tool(host.call, "pairbrowse_invite", { action: "approve", id: carolReq });
    const seen = { tabs: null, forms: new Map(), pointers: [] };
    const { connect: wsConnect } = await import("../scripts/ws.mjs");
    const channel = await wsConnect(`${carolCode.url}/${carolCode.key}/events`, { headers: carolHeaders });
    channel.onMessage((raw) => {
      const { event, data } = JSON.parse(raw);
      if (event === "tabs") seen.tabs = data;
      if (event === "form") seen.forms.set(data.id, data);
      if (event === "pointers") seen.pointers = data;
    });
    await until("Alice's copy", async () => (await tabs(joiner.call)).some((t) => /shop\.pbtest\.example\/checkout/.test(t.url)));
    await select(joiner.call, /shop\.pbtest\.example\/checkout/);
    await sleep(3000); // the copy settles

    stage = "Bob's agent holds the tab: Alice's agent waits its turn, never types into her copy";
    await select(host.call, /shop\.pbtest\.example\/checkout/);
    let s = await snap(host.call);
    assert.ok(!(await tool(host.call, "browser_type", { target: ref(s, "textbox", "Notes"), text: "gift" })).result.isError);
    await until("Bob's turn reaches Alice's helper", async () => seen.tabs?.tabs.some((t) => t.agent && t.left > 0), 10_000);
    await sleep(1000);
    let js = await snap(joiner.call);
    const refused = await tool(joiner.call, "browser_type", { target: ref(js, "textbox", "Pay with"), text: "Alice's" });
    assert.ok(refused.result.isError, text(refused));
    assert.match(text(refused), /in use by [^\n]*\(in Bob's browser\)/);
    await sleep(1500);
    assert.doesNotMatch(await snap(host.call), /Alice's/, "nothing typed into her copy crossed");
    assert.doesNotMatch(await snap(joiner.call), /textbox "Pay with"[^\n]*: Alice's/, "nor was it typed there");

    stage = "Bob's agent lets go: Alice's agent goes on";
    await tool(host.call, "pairbrowse_collaboration", { action: "release" });
    await until("Alice's agent may act", async () => {
      js = await snap(joiner.call);
      return !(await tool(joiner.call, "browser_type", { target: ref(js, "textbox", "Pay with"), text: "abc" })).result.isError;
    }, 15_000);

    stage = "now Alice's agent holds it: Bob's agent hears it's in use, then goes on once she lets go";
    await sleep(1500); // her turn reaches the host
    s = await snap(host.call);
    const hostRefused = await tool(host.call, "browser_type", { target: ref(s, "textbox", "Notes"), text: "more" });
    assert.ok(hostRefused.result.isError, text(hostRefused));
    assert.match(text(hostRefused), /in use by [^\n]*\(in Alice's browser\)/);
    await tool(joiner.call, "pairbrowse_collaboration", { action: "release" });
    await until("Bob's agent may act", async () => { s = await snap(host.call); return !(await tool(host.call, "browser_hover", { target: ref(s, "textbox", "Notes") })).result.isError; }, 15_000);

    stage = "a card number replaces the plain value: no stale value in Alice's copy, nothing echoed back";
    await until("abc on the host", async () => /textbox "Pay with"[^\n]*: abc/.test(await snap(host.call)));
    s = await snap(host.call);
    assert.ok(!(await tool(host.call, "browser_type", { target: ref(s, "textbox", "Pay with"), text: "4242424242424242" })).result.isError);
    await until("Alice's copy drops abc and shows it filled", async () => { const x = await snap(joiner.call); return !/: abc/.test(x) && /filled by Bob/.test(x); }, 15_000);
    await sleep(3000);
    const payField = (await until("the form on Carol's channel", async () => [...seen.forms.values()].find((f) => f.fields.some((x) => x.k === "#pay")))).fields.find((x) => x.k === "#pay");
    assert.deepEqual([payField.m, payField.filled], [1, true], "the host's card stands: no empty value came back from Alice");

    stage = "Submit order sends a payment form: refused unless called a payment, by click or Enter";
    s = await snap(host.call);
    const click = await tool(host.call, "browser_click", { target: ref(s, "button", "Submit order"), element: "Submit order" });
    assert.ok(click.result.isError);
    assert.match(text(click), /card or billing\/shipping fields: a final action \(pay\)[^\n]*Retry with "Pay"/);
    const enter = await tool(host.call, "browser_type", { target: ref(s, "textbox", "Notes"), text: "x", submit: true });
    assert.ok(enter.result.isError);
    assert.match(text(enter), /^Refused: Enter here would/);
    await sleep(1000);
    assert.equal(submitted, 0, "nothing submitted");

    stage = "scroll presence: where Alice reads and where Bob reads cross, named";
    const live = text(await tool(joiner.call, "pairbrowse_liveview")).match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)[0];
    const copy = (await tabs(joiner.call)).find((t) => /shop\.pbtest\.example\/checkout/.test(t.url));
    assert.ok((await fetch(`${live}tab`, { method: "POST", body: JSON.stringify({ i: copy.index }) })).ok);
    const aliceView = await until("Alice's view reaches Carol", async () => {
      await fetch(`${live}input`, { method: "POST", body: JSON.stringify([{ type: "mouse", action: "mouseMoved", x: 300, y: 300 }, { type: "wheel", x: 300, y: 300, dy: 600 }]) });
      return seen.pointers.find((p) => p.v === 1 && p.who === "Alice" && p.y > 0);
    }, 15_000);
    assert.deepEqual(Object.keys(aliceView).sort(), ["color", "h", "id", "k", "t", "v", "who", "x", "y"], "a position, a height, a name and a color only");
    const hostView = text(await tool(host.call, "pairbrowse_liveview")).match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)[0];
    const hostTab = (await tabs(host.call)).find((t) => /shop\.pbtest\.example\/checkout/.test(t.url));
    assert.ok((await fetch(`${hostView}tab`, { method: "POST", body: JSON.stringify({ i: hostTab.index }) })).ok);
    await until("Bob's view reaches Carol", async () => {
      await fetch(`${hostView}input`, { method: "POST", body: JSON.stringify([{ type: "mouse", action: "mouseMoved", x: 200, y: 200 }, { type: "wheel", x: 200, y: 200, dy: 900 }]) });
      return seen.pointers.find((p) => p.v === 1 && p.k === "host-view" && p.who === "Bob" && p.y > 0);
    }, 15_000);
    const t0 = Date.now();
    await tool(host.call, "browser_press_key", { key: "Shift" });
    assert.ok(Date.now() - t0 < 1500, `scrolling pauses no agent (${Date.now() - t0} ms)`);

    stage = "a step through a form goes without asking; the commit that ends it is asked for";
    assert.ok(!(await tool(host.call, "browser_navigate", { url: "http://shop.pbtest.example/wizard" })).result.isError);
    s = await snap(host.call);
    assert.ok(ref(s, "button", "Next"), s.slice(0, 1500));
    const next = await tool(host.call, "browser_click", { target: ref(s, "button", "Next"), element: "Next" });
    assert.ok(!next.result.isError, text(next));
    await until("the next step", async () => /wizard\/2/.test(text(await tool(host.call, "browser_tabs", { action: "list" }))));
    assert.ok(!(await tool(host.call, "browser_navigate", { url: "http://shop.pbtest.example/wizard" })).result.isError);
    s = await snap(host.call);
    const create = await tool(host.call, "browser_click", { target: ref(s, "button", "Create account"), element: "Create account" });
    assert.ok(create.result.isError);
    assert.match(text(create), /it submits a form: a final action \(submit\)[^\n]*Retry with "Submit"/);
    channel.close();
  } catch (e) {
    const log = (h) => { try { return readFileSync(join(h, "daemon.log"), "utf8").slice(-2500); } catch { return ""; } };
    throw new Error(`${stage}: ${e.message}\nhost:\n${log(hostHome)}\njoiner:\n${log(joinHome)}`);
  } finally {
    host?.sock.destroy();
    joiner?.sock.destroy();
    fixture.close();
    await Promise.all(daemons.map(async (d) => { if (d.exitCode === null) { d.kill("SIGTERM"); await Promise.race([new Promise((r) => d.once("exit", r)), sleep(10_000)]); } }));
    rmSync(hostHome, { recursive: true, force: true });
    rmSync(joinHome, { recursive: true, force: true });
  }
});
