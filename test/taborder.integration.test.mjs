// Tab order in a shared session, in real browsers: a host helper and a drive joiner's helper, each
// with its own temporary home and headless browser (like join.integration.test.mjs; the sharing
// tunnel is skipped with PAIRBROWSE_TEST_TUNNEL=direct). The tab strip is read and moved through
// the side panel extension's worker, the same way the helpers mirror it, by a tool that exists only
// with PAIRBROWSE_TEST_TAB_ORDER=1. Needs PAIRBROWSE_TEST_RUNTIME.
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
const shortBase = existsSync("/Volumes/BACKUP/PairBrowse") ? "/Volumes/BACKUP/PairBrowse" : tmpdir(); // socket paths must stay short
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

test("tab order follows in a shared session: a move on the host reaches the joiner, a drive joiner's move reaches the host", { skip: !runtime, timeout: 240_000 }, async () => {
  const require = createRequire(join(runtime, "package.json"));
  const executablePath = require("patchright").chromium.executablePath();
  const fixture = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<title>${req.headers.host}${req.url}</title><main>shared fixture</main>`); });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const chromeArgs = ["--headless=new", `--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${fixture.address().port}`];
  const hostHome = home("th-");
  const joinHome = home("tj-");
  for (const [h, name] of [[hostHome, "Bob"], [joinHome, "Alice"]]) writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, chromeArgs, display: "none", screenshots: false, participantName: name }));
  const env = (h) => ({ ...process.env, PAIRBROWSE_HOME: h, PAIRBROWSE_TEST_TUNNEL: "direct", PAIRBROWSE_TEST_JOIN_LOCAL: "1", PAIRBROWSE_TEST_TAB_ORDER: "1" });
  const daemons = [];
  const connect = async (h) => {
    const out = openSync(join(h, "daemon.stderr.log"), "a");
    daemons.push(spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: env(h), stdio: ["ignore", out, out] }));
    const socketPath = join(h, "run", "browser.sock");
    // A busy machine (the whole suite at once) can take a while to start the helper.
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
    // The socket file can show a moment before the helper listens on it (a busy machine): retry.
    let sock;
    for (let i = 0; ; i++) {
      sock = net.createConnection(socketPath);
      const ok = await new Promise((r) => { sock.once("connect", () => r(true)); sock.once("error", () => r(false)); });
      if (ok) break;
      if (i > 50) throw new Error(`couldn't connect to ${socketPath}`);
      await sleep(200);
    }
    const call = rpc((l) => sock.write(l), sock);
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } });
    sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return { sock, call };
  };
  let last = "";
  const until = async (what, check, ms = 45_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) { const v = await check(); if (v) return v; }
    throw new Error(`timed out: ${what} (last seen ${last})`);
  };
  // The shared tabs as this browser's strip shows them (by host name: one, two, three).
  const strip = async (call) => {
    const r = await tool(call, "pairbrowse_test_tab_order", { action: "list" });
    assert.ok(!r.result?.isError, text(r));
    return JSON.parse(text(r)).map((u) => u.match(/^http:\/\/(\w+)\.pbtest\.example\//)?.[1]).filter(Boolean).join(",");
  };
  const stripIs = (call, want) => async () => (last = await strip(call)) === want;
  const move = async (call, url, before) => assert.equal(text(await tool(call, "pairbrowse_test_tab_order", { action: "move", url, before })), "moved");
  let host, joiner, stage = "start";
  try {
    host = await connect(hostHome);
    joiner = await connect(joinHome);
    stage = "host opens three tabs";
    assert.ok(!(await tool(host.call, "browser_navigate", { url: "http://one.pbtest.example/" })).result.isError);
    for (const url of ["http://two.pbtest.example/", "http://three.pbtest.example/"]) {
      assert.ok(!(await tool(host.call, "browser_tabs", { action: "new" })).result.isError);
      assert.ok(!(await tool(host.call, "browser_navigate", { url })).result.isError);
    }
    await until("the host's strip", stripIs(host.call, "one,two,three"));

    stage = "a drive joiner joins";
    const code = text(await tool(host.call, "pairbrowse_invite", { action: "create", role: "drive", label: "Alice", share: "code", mode: "follow" })).match(/Join code: (pb-join:[A-Za-z0-9_-]+)/)?.[1];
    assert.ok(code);
    assert.match(text(await tool(joiner.call, "pairbrowse_join", { action: "join", code })), /Asked Bob/);
    const id = await until("the request", async () => text(await tool(host.call, "pairbrowse_invite", { action: "list" })).match(/request (r[0-9a-f]{6}): Alice/)?.[1]);
    assert.match(text(await tool(host.call, "pairbrowse_invite", { action: "approve", id })), /Let Alice in/);
    await until("the joiner's copies, in the host's order", stripIs(joiner.call, "one,two,three"), 60_000);

    stage = "a move on the host reaches the joiner";
    await move(host.call, "http://three.pbtest.example/", "http://one.pbtest.example/");
    await until("the host's strip", stripIs(host.call, "three,one,two"));
    await until("the joiner follows", stripIs(joiner.call, "three,one,two"));

    stage = "a drive joiner's move reaches the host";
    await sleep(2000); // the joiner's own order check has seen the arranged order
    await move(joiner.call, "http://one.pbtest.example/", "http://three.pbtest.example/");
    await until("the joiner's strip", stripIs(joiner.call, "one,three,two"));
    await until("the host follows", stripIs(host.call, "one,three,two"));
    await sleep(6000); // past the joiner's hold: the order stays, nothing bounces back
    assert.equal(await strip(host.call), "one,three,two");
    assert.equal(await strip(joiner.call), "one,three,two");
  } catch (e) {
    const log = (h) => { try { return readFileSync(join(h, "daemon.log"), "utf8").slice(-2000); } catch { return ""; } };
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

test("a new agent starts on the tab the person looks at, unless another agent is in it; a released tab is free again; agents share a tab only on request", { skip: !runtime, timeout: 240_000 }, async () => {
  const require = createRequire(join(runtime, "package.json"));
  const executablePath = require("patchright").chromium.executablePath();
  const fixture = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<title>${req.headers.host}${req.url}</title><main>start fixture</main>`); });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const h = home("ts-");
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new", `--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${fixture.address().port}`], display: "none", screenshots: false, participantName: "Bob" }));
  const out = openSync(join(h, "daemon.stderr.log"), "a");
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: h, PAIRBROWSE_TEST_TAB_ORDER: "1" }, stdio: ["ignore", out, out] });
  const socks = [];
  const connect = async () => {
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
    let sock;
    for (let i = 0; ; i++) {
      sock = net.createConnection(socketPath);
      if (await new Promise((r) => { sock.once("connect", () => r(true)); sock.once("error", () => r(false)); })) break;
      if (i > 50) throw new Error(`couldn't connect to ${socketPath}`);
      await sleep(200);
    }
    socks.push(sock);
    const call = rpc((l) => sock.write(l), sock);
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } });
    sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return call;
  };
  // The tab an agent's first action lands in, by host name.
  const firstTab = async (call) => {
    const r = await tool(call, "browser_snapshot");
    assert.ok(!r.result?.isError, text(r));
    return text(r).match(/Page URL: http:\/\/(\w+)\.pbtest\.example\//)?.[1];
  };
  const show = async (call, url, before) => assert.equal(text(await tool(call, "pairbrowse_test_tab_order", { action: "front", url, before })), "shown");
  let stage = "start";
  try {
    const a = await connect();
    stage = "agent A opens three tabs";
    assert.ok(!(await tool(a, "browser_navigate", { url: "http://one.pbtest.example/" })).result.isError);
    for (const url of ["http://two.pbtest.example/", "http://three.pbtest.example/"]) {
      assert.ok(!(await tool(a, "browser_tabs", { action: "new" })).result.isError);
      assert.ok(!(await tool(a, "browser_navigate", { url })).result.isError);
    }
    stage = "the person looks at tab two: a new agent starts there";
    await show(a, "http://two.pbtest.example/");
    const b = await connect();
    assert.equal(await firstTab(b), "two");
    stage = "the person looks at A's tab: a new agent starts in a free tab instead";
    await show(a, "http://three.pbtest.example/");
    const c = await connect();
    assert.equal(await firstTab(c), "one");
    stage = "A releases: its tab, in front, is where the next agent starts";
    assert.ok(!(await tool(a, "pairbrowse_collaboration", { action: "release" })).result?.isError);
    const d = await connect();
    assert.equal(await firstTab(d), "three");
    stage = "the person opens a new tab: the next agent starts there";
    await show(a, "http://four.pbtest.example/", "new");
    await sleep(500);
    assert.equal(await firstTab(await connect()), "four");

    stage = "B acts in its tab (it holds it now)";
    assert.ok(!(await tool(b, "browser_navigate", { url: "http://two.pbtest.example/" })).result?.isError);
    stage = "told to, C shares B's tab: both act there and each hears of the other";
    const shared = await tool(c, "pairbrowse_collaboration", { action: "share", tab: 1 });
    assert.ok(!shared.result?.isError, text(shared));
    assert.match(text(shared), /together with Claude/, JSON.stringify(shared));
    const inC = await tool(c, "browser_navigate", { url: "http://two.pbtest.example/" });
    assert.ok(!inC.result?.isError, text(inC));
    assert.match(text(inC), /Page URL: http:\/\/two\.pbtest\.example\//);
    assert.match(text(inC), /also works in this tab/);
    const inB = await tool(b, "browser_snapshot");
    assert.ok(!inB.result?.isError, text(inB));
    assert.match(text(inB), /Page URL: http:\/\/two\.pbtest\.example\/[\s\S]*also works in this tab/);
    stage = "an agent not told to share still can't act in that tab";
    assert.ok(!(await tool(d, "browser_tabs", { action: "select", index: 1 })).result?.isError);
    const refused = await tool(d, "browser_navigate", { url: "http://two.pbtest.example/" });
    assert.ok(refused.result?.isError, text(refused));
    assert.match(text(refused), /Tab 1 is in use by/);
  } catch (e) {
    let log = "";
    try { log = readFileSync(join(h, "daemon.log"), "utf8").slice(-2000); } catch {}
    throw new Error(`${stage}: ${e.message}\n${log}`);
  } finally {
    for (const s of socks) s.destroy();
    fixture.close();
    if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await Promise.race([new Promise((r) => daemon.once("exit", r)), sleep(10_000)]); }
    rmSync(h, { recursive: true, force: true });
  }
});
