// Connections under attack: the bridge losing its helper, sessions churning, a client gone
// mid-call, a joiner's link to the host dropping or stalling, and garbage on the helper's socket.
// Live: real helpers and headless browsers in temporary homes (PAIRBROWSE_TEST_RUNTIME); join
// codes skip the tunnel (PAIRBROWSE_TEST_TUNNEL=direct) and go through a proxy here that can cut
// or stall the joiner's connection.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync, existsSync, openSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shortBase = existsSync("/Volumes/BACKUP/PairBrowse") ? "/Volumes/BACKUP/PairBrowse" : tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";
const INIT = { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } };
const STALLED_MS = 30_000; // serve.mjs: a disconnected participant's action may run this long

// Waits for check() to return something truthy. note(): what to say about the state on a timeout.
async function until(what, check, ms = 30_000, note = () => "") {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { const got = await check(); if (got) return got; }
  const last = await note();
  throw new Error(`timed out: ${what}${last ? ` (${String(last).slice(0, 300)})` : ""}`);
}

// JSON-RPC over a line stream. Resolves each answer by id; fails every waiting call when the
// stream ends.
function rpc(write, input, prefix = "t") {
  const waiting = new Map();
  const rl = createInterface({ input });
  rl.on("line", (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m?.id !== undefined && waiting.has(m.id)) { waiting.get(m.id).resolve(m); waiting.delete(m.id); }
  });
  rl.on("close", () => { for (const [, w] of waiting) w.reject(new Error("connection closed")); waiting.clear(); });
  let seq = 0;
  return (method, params = {}, ms = 60_000) => new Promise((resolve, reject) => {
    const id = `${prefix}${++seq}`;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`timed out: ${method} ${params.name || ""}`)); }, ms);
    waiting.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function setup() {
  const executablePath = process.env.PAIRBROWSE_TEST_EXECUTABLE || createRequire(join(runtime, "package.json"))("playwright").chromium.executablePath();
  mkdirSync(shortBase, { recursive: true });
  const homes = [];
  const daemons = [];
  const socks = [];
  const home = (prefix, config = {}) => {
    const h = mkdtempSync(join(shortBase, prefix));
    homes.push(h);
    symlinkSync(runtime, join(h, "runtime"), "dir");
    writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new"], display: "none", screenshots: false, browserDriver: "playwright", sessionPicker: false, ...config }));
    return h;
  };
  const socketOf = (h) => join(h, "run", "browser.sock");
  const start = (h, env = {}) => {
    const out = openSync(join(h, "daemon.stderr.log"), "a");
    const d = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: h, ...env }, stdio: ["ignore", out, out] });
    daemons.push(d);
    helperOf.set(h, d);
    return d;
  };
  const helperOf = new Map(); // home -> the helper started last there
  // A session on the helper's socket, as a bridge opens one.
  const attach = async (h, name = "t") => {
    // Until the helper listens: loading the browser runtime takes a while on a busy computer (the
    // whole suite at once), so this waits for it to accept or to exit, not for a fixed time.
    let sock;
    for (const end = Date.now() + 90_000; ; await sleep(100)) {
      const d = helperOf.get(h);
      if (d && d.exitCode !== null) throw new Error(`the helper exited (${d.exitCode}) before listening on ${socketOf(h)}`);
      sock = net.createConnection(socketOf(h));
      if (await new Promise((r) => { sock.once("connect", () => r(true)); sock.once("error", () => r(false)); })) break;
      sock.destroy();
      if (Date.now() > end) throw new Error(`couldn't connect to ${socketOf(h)}`);
    }
    sock.on("error", () => {});
    socks.push(sock);
    const call = rpc((l) => !sock.destroyed && sock.write(l), sock, name);
    await call("initialize", INIT);
    sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return { sock, call, tool: (tool, args = {}, ms) => call("tools/call", { name: tool, arguments: args }, ms) };
  };
  const logOf = (h) => { try { return readFileSync(join(h, "daemon.log"), "utf8"); } catch { return ""; } };
  const cleanup = async () => {
    for (const s of socks) s.destroy();
    await Promise.all(daemons.map(async (d) => { if (d.exitCode === null && d.signalCode === null) { d.kill("SIGTERM"); await Promise.race([new Promise((r) => d.once("exit", r)), sleep(10_000)]); } }));
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  };
  return { executablePath, home, socketOf, start, attach, logOf, cleanup };
}

test("the bridge survives its helper being killed mid-call, and a stale socket doesn't hang it", { skip: !runtime, timeout: 180_000 }, async () => {
  const t = setup();
  const h = t.home("cb-");
  // The helper's pid, as it starts (the bridge starts it detached): written by a module every
  // node process here loads.
  const pids = join(h, "pids");
  mkdirSync(pids);
  const mark = join(h, "pidmark.mjs");
  writeFileSync(mark, `import { writeFileSync } from "node:fs";\nif (process.argv[1]?.endsWith("daemon.mjs")) writeFileSync(${JSON.stringify(pids)} + "/" + process.pid, "");\n`);
  const helpers = () => readdirSync(pids).map(Number);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const bridges = [];
  const bridge = () => {
    const b = spawn(process.execPath, [join(root, "scripts", "launch.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: h, NODE_OPTIONS: `--import=${pathToFileURL(mark).href}` }, stdio: ["pipe", "pipe", "pipe"] });
    bridges.push(b);
    let err = "";
    b.stderr.on("data", (d) => { err += d; });
    const call = rpc((l) => b.stdin.write(l), b.stdout, "b");
    return { b, call, err: () => err, tool: (tool, args = {}, ms) => call("tools/call", { name: tool, arguments: args }, ms) };
  };
  try {
    let br = bridge();
    assert.ok((await br.call("initialize", INIT, 60_000)).result, "the bridge starts a helper and answers");
    br.b.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    assert.ok(!(await br.tool("browser_tabs", { action: "list" })).result?.isError);
    assert.equal(helpers().length, 1);
    const [first] = helpers();
    // Lines that aren't messages are skipped, not fatal.
    br.b.stdin.write("null\n42\nnot json\n");
    assert.ok(!(await br.tool("browser_tabs", { action: "list" })).result?.isError, `the bridge goes on: ${br.err()}`);
    assert.equal(br.b.exitCode, null);

    // A call in flight when the helper dies (SIGKILL: no goodbye) fails at once with an error.
    const inflight = br.tool("browser_wait_for", { time: 20 }, 30_000);
    await sleep(500);
    const killedAt = Date.now();
    process.kill(first, "SIGKILL");
    const failed = await inflight;
    assert.ok(failed.error || failed.result?.isError, `the call in flight fails: ${JSON.stringify(failed)}`);
    assert.match(text(failed), /restarted|Retry/i);
    assert.ok(Date.now() - killedAt < 5000, "and at once, not after its wait");
    // The next call starts a new helper and works.
    const again = await br.tool("browser_tabs", { action: "list" }, 60_000);
    assert.ok(!again.result?.isError, text(again));
    const second = helpers().find((p) => p !== first);
    assert.ok(second && alive(second), "a new helper");

    // A stale socket file (the helper killed, nothing behind it): a new bridge starts a helper
    // instead of hanging on it.
    br.b.stdin.end();
    await new Promise((r) => br.b.once("exit", r));
    process.kill(second, "SIGKILL");
    await until("the helper gone", () => !alive(second));
    assert.ok(existsSync(t.socketOf(h)), "the socket file is left behind");
    const t0 = Date.now();
    br = bridge();
    assert.ok((await br.call("initialize", INIT, 30_000)).result, `answers past the stale socket: ${br.err()}`);
    br.b.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const listed = await br.tool("browser_tabs", { action: "list" }, 60_000);
    assert.ok(!listed.result?.isError, text(listed));
    assert.ok(Date.now() - t0 < 45_000, "promptly");
    assert.equal(helpers().filter(alive).length, 1, "one helper running");
  } finally {
    for (const b of bridges) if (b.exitCode === null) b.kill("SIGTERM");
    for (const pid of existsSync(pids) ? readdirSync(pids).map(Number) : []) { try { process.kill(pid, "SIGTERM"); } catch {} }
    await until("helpers stopped", () => !(existsSync(pids) ? readdirSync(pids).map(Number) : []).some(alive), 15_000).catch(() => {
      for (const pid of readdirSync(pids).map(Number)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    });
    await t.cleanup();
  }
});

test("sessions churning (connect, drop mid-call, drop at once) leave the helper healthy", { skip: !runtime, timeout: 120_000 }, async () => {
  const t = setup();
  const h = t.home("cc-");
  t.start(h);
  try {
    const first = await t.attach(h, "f");
    assert.ok(!(await first.tool("browser_tabs", { action: "list" })).result?.isError, "the browser is up");
    first.sock.destroy();

    // Three rounds of 20 clients: some drop before saying anything, some mid-initialize, some
    // mid-call, some right after their call is answered.
    for (let round = 0; round < 3; round++) {
      await Promise.all(Array.from({ length: 20 }, async (_, i) => {
        const sock = net.createConnection(t.socketOf(h));
        sock.on("error", () => {});
        await new Promise((r) => { sock.once("connect", r); sock.once("error", r); });
        const call = rpc((l) => !sock.destroyed && sock.write(l), sock, `c${round}-${i}-`);
        const kind = i % 4;
        if (kind === 0) return sock.destroy();
        const init = call("initialize", INIT, 30_000).catch(() => null);
        if (kind === 1) { await sleep(i * 3); return sock.destroy(); }
        await init;
        sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        const tool = i % 8 < 4 ? "browser_tabs" : "pairbrowse_status";
        const answer = call("tools/call", { name: tool, arguments: tool === "browser_tabs" ? { action: "list" } : {} }, 30_000).catch(() => null);
        if (kind === 2) { await sleep(5 + i); return sock.destroy(); }
        await answer;
        sock.destroy();
      }));
    }

    // A fresh client: answered at once, alone in the session, nothing left holding the queue.
    const fresh = await t.attach(h, "n");
    const t0 = Date.now();
    const listed = await fresh.tool("browser_tabs", { action: "list" }, 30_000);
    assert.ok(!listed.result?.isError, text(listed));
    assert.ok(Date.now() - t0 < 10_000, `answered promptly (${Date.now() - t0} ms)`);
    const st = await until("the others gone", async () => { const s = JSON.parse(text(await fresh.tool("pairbrowse_collaboration", { action: "status" }))); return s.participants.length === 1 && s; }, 15_000);
    assert.equal(st.participants[0].id, st.self, "only this session is left");
    assert.equal(st.active?.id ?? st.self, st.self, "nobody else holds the queue");
    assert.equal(st.owner, null);
    // Every session that connected was let go (its browser server closed), not just forgotten.
    const notClosed = () => {
      const log = t.logOf(h);
      const on = [...log.matchAll(/participant connected ([0-9a-f]{16})/g)].map((m) => m[1]);
      const off = new Set([...log.matchAll(/participant disconnected ([0-9a-f]{16})/g)].map((m) => m[1]));
      return on.filter((id) => !off.has(id) && id !== st.self);
    };
    await until("every dropped session cleaned up", () => notClosed().length === 0, 15_000, () => `${notClosed().length} still open`);
  } finally {
    if (process.env.PB_DEBUG) console.log(t.logOf(h).slice(-4000));
    await t.cleanup();
  }
});

test("a client gone mid-call holds others up no longer than the watchdog", { skip: !runtime, timeout: 120_000 }, async () => {
  const t = setup();
  // A page that never answers: navigating to it runs until the navigation's own timeout (60 s).
  const hang = createServer(() => {});
  await new Promise((r) => hang.listen(0, "127.0.0.1", r));
  const h = t.home("cm-");
  t.start(h);
  try {
    const alice = await t.attach(h, "a");
    const bob = await t.attach(h, "b");
    assert.ok(!(await bob.tool("browser_tabs", { action: "list" })).result?.isError, "the browser is up");
    const stuck = alice.tool("browser_navigate", { url: `http://127.0.0.1:${hang.address().port}/` }, 90_000).catch(() => null);
    // Bob's call queues behind it; then Alice's client goes away.
    await sleep(1000);
    const queued = bob.tool("browser_tabs", { action: "list" }, STALLED_MS + 30_000).catch((e) => ({ error: { message: e.message } }));
    await sleep(500);
    const gone = Date.now();
    alice.sock.destroy();
    void stuck;
    // Bob's call waits behind it, at most for the watchdog (then the browser is reset).
    const r = await queued;
    const waited = Date.now() - gone;
    assert.ok(waited < STALLED_MS + 15_000, `answered within the watchdog (${waited} ms): ${text(r)}`);
    assert.match(t.logOf(h), /resetting browser after disconnected participant stalled/);
    // Whatever Bob got (the reset ends his connection; a bridge then reconnects), the next session
    // works at once.
    await until("the reset done", () => /browser closed/.test(t.logOf(h)), 15_000);
    const carol = await t.attach(h, "c");
    const t0 = Date.now();
    const listed = await carol.tool("browser_tabs", { action: "list" }, 30_000);
    assert.ok(!listed.result?.isError, text(listed));
    assert.ok(Date.now() - t0 < 15_000, "at once");
  } finally {
    if (process.env.PB_DEBUG) console.log(t.logOf(h).slice(-4000));
    hang.closeAllConnections?.();
    hang.close();
    await t.cleanup();
  }
});

// A TCP proxy between the joiner and the host's joiner port: pass, cut (every connection ends
// and new ones are refused) or stall (connections stay open, nothing crosses).
function joinProxy(targetPort) {
  let mode = "pass";
  const pairs = new Set();
  const server = net.createServer((client) => {
    client.on("error", () => {});
    if (mode === "cut") return client.destroy();
    const up = net.connect(targetPort, "127.0.0.1");
    up.on("error", () => {});
    const pair = { client, up };
    pairs.add(pair);
    const close = () => { client.destroy(); up.destroy(); pairs.delete(pair); };
    client.on("close", close);
    up.on("close", close);
    client.on("data", (d) => { if (mode === "pass") up.write(d); });
    up.on("data", (d) => { if (mode === "pass") client.write(d); });
  });
  return {
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    set(m) { mode = m; if (m === "cut") for (const p of [...pairs]) { p.client.destroy(); p.up.destroy(); } },
    get open() { return pairs.size; },
    close() { for (const p of pairs) { p.client.destroy(); p.up.destroy(); } server.close(); },
  };
}

test("a joiner's link to the host drops, stalls or the host's helper crashes: back in by itself, tabs resync; a revoked joiner stays out", { skip: !runtime, timeout: 300_000 }, async () => {
  const t = setup();
  const fixture = createServer((req, res) => {
    const name = String(req.headers.host || "").split(".")[0];
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<title>Page ${name}</title><button>Tap ${name}</button>`);
  });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const chromeArgs = ["--headless=new", `--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${fixture.address().port}`];
  const hostHome = t.home("ch-", { chromeArgs, participantName: "Bob" });
  const joinHome = t.home("cj-", { chromeArgs, participantName: "Alice" });
  const env = { PAIRBROWSE_TEST_SCREEN: "1", PAIRBROWSE_TEST_TUNNEL: "direct", PAIRBROWSE_TEST_JOIN_LOCAL: "1" };
  const tool = (s, name, args = {}, ms) => s.tool(name, args, ms);
  const status = async (j) => text(await tool(j, "pairbrowse_join", { action: "status" }));
  const titles = async (j) => text(await tool(j, "pairbrowse_test_screen", { list: true }));
  let proxy, stage = "start";
  try {
    let hostDaemon = t.start(hostHome, env);
    let host = await t.attach(hostHome, "h");
    t.start(joinHome, env);
    const joiner = await t.attach(joinHome, "j");
    assert.ok(!(await tool(host, "browser_navigate", { url: "http://one.pbtest.example/" })).result.isError);
    const code = text(await tool(host, "pairbrowse_invite", { action: "create", role: "drive", label: "Alice", share: "code" })).match(/Join code: (pb-join:[A-Za-z0-9_-]+)/)?.[1];
    assert.ok(code);
    // The code, pointed at the proxy in front of the host's joiner port.
    const packed = JSON.parse(Buffer.from(code.slice("pb-join:".length), "base64url").toString("utf8"));
    const guestPort = Number(new URL(packed.u).port);
    proxy = joinProxy(guestPort);
    const viaProxy = `pb-join:${Buffer.from(JSON.stringify({ ...packed, u: `http://127.0.0.1:${await proxy.listen()}` })).toString("base64url")}`;
    await tool(joiner, "pairbrowse_join", { action: "join", code: viaProxy });
    const id = await until("the request", async () => text(await tool(host, "pairbrowse_invite", { action: "list" })).match(/request (r[0-9a-f]{6}): Alice/)?.[1]);
    assert.match(text(await tool(host, "pairbrowse_invite", { action: "approve", id })), /Let Alice in/);
    await until("the joiner in", async () => /You're in Bob's session/.test(await status(joiner)));
    await tool(host, "pairbrowse_collaboration", { action: "release" });
    await until("the joiner's agent in the host's browser", async () => /button "Tap one"/.test(text(await tool(joiner, "browser_snapshot"))));
    await until("the host's tab here", async () => /Page one/.test(await titles(joiner)));
    const backIn = async (what, ms = 30_000) => {
      await until(`${what}: the joiner in again`, async () => /You're in Bob's session/.test(await status(joiner)), ms);
      const list = text(await tool(host, "pairbrowse_invite", { action: "list" }));
      assert.doesNotMatch(list, /waiting for the user's OK/, `${what}: no new request to approve`);
      await until(`${what}: the joiner's agent works there again`, async () => /button "Tap/.test(text(await tool(joiner, "browser_snapshot"))), 30_000);
    };

    stage = "the link is cut; the host opens a tab meanwhile";
    proxy.set("cut");
    await until("the joiner notices", async () => /dropped|reach|Retrying|Reconnecting/i.test(await status(joiner)), 15_000);
    assert.ok(!(await tool(host, "browser_tabs", { action: "new", url: "http://two.pbtest.example/" })).result.isError);
    await tool(host, "pairbrowse_collaboration", { action: "release" });
    proxy.set("pass");
    await backIn("after the cut");
    await until("the tab opened meanwhile shows here", async () => /Page two/.test(await titles(joiner)), 30_000);

    stage = "the link stalls (open, nothing crosses)";
    // Once the joiner has had a few of the host's heartbeats (1 s apart), three missed in a row
    // drop the link (relay.mjs); before that it waits for 40 s of silence.
    await sleep(3500);
    proxy.set("stall");
    await until("the joiner notices the silence", async () => /dropped|reach|Retrying|Reconnecting/i.test(await status(joiner)), 10_000, () => status(joiner));
    proxy.set("pass");
    await backIn("after the stall");

    stage = "the host's helper crashes (SIGKILL) and starts again";
    host.sock.destroy();
    hostDaemon.kill("SIGKILL");
    await new Promise((r) => hostDaemon.once("exit", r));
    hostDaemon = t.start(hostHome, env);
    host = await t.attach(hostHome, "h2");
    assert.ok(!(await tool(host, "browser_tabs", { action: "list" })).result.isError);
    await tool(host, "pairbrowse_liveview");
    const tabs = text(await tool(host, "browser_tabs", { action: "list" }));
    if (!/one\.pbtest\.example/.test(tabs)) await tool(host, "browser_navigate", { url: "http://one.pbtest.example/" });
    await tool(host, "pairbrowse_collaboration", { action: "release" });
    await backIn("after the crash", 60_000);
    await until("the host's tabs here", async () => /Page one/.test(await titles(joiner)), 30_000);

    stage = "callers that hang up on a refused channel don't take the host down";
    // The joiner port is what the public tunnel reaches: anyone may ask it for a channel with a
    // wrong key, and hang up (a reset) while the refusal is on its way.
    for (let i = 0; i < 30; i++) {
      const c = net.connect(guestPort, "127.0.0.1");
      c.on("error", () => {});
      c.once("connect", () => {
        c.write(`GET /${"0".repeat(64)}/events HTTP/1.1\r\nhost: 127.0.0.1\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-version: 13\r\nsec-websocket-key: ${Buffer.alloc(16, i).toString("base64")}\r\n\r\n`);
        setTimeout(() => c.resetAndDestroy(), i % 4);
      });
      await sleep(20);
    }
    await sleep(500);
    assert.ok(hostDaemon.exitCode === null && hostDaemon.signalCode === null, `the host's helper is still running:\n${readFileSync(join(hostHome, "daemon.stderr.log"), "utf8").slice(-1500)}`);
    assert.ok(!(await tool(host, "browser_tabs", { action: "list" })).result.isError, "and answers");
    assert.match(await status(joiner), /You're in Bob's session/, "the joiner stays in");

    stage = "revoked while cut off: they can't come back";
    const inviteId = text(await tool(host, "pairbrowse_invite", { action: "list" })).match(/^- (\S+): Alice/m)?.[1];
    assert.ok(inviteId);
    proxy.set("cut");
    await until("the joiner cut off", async () => /dropped|reach|Retrying|Reconnecting/i.test(await status(joiner)), 15_000);
    assert.match(text(await tool(host, "pairbrowse_invite", { action: "revoke", id: inviteId })), /Revoked/);
    proxy.set("pass");
    await until("the joiner out", async () => /doesn't work any more|Not in/i.test(await status(joiner)), 30_000);
    const snap = text(await tool(joiner, "browser_snapshot"));
    assert.doesNotMatch(snap, /Tap one|Tap two/, "the joiner's agent no longer works in the host's browser");
    assert.doesNotMatch(text(await tool(host, "pairbrowse_invite", { action: "list" })), /Alice/);
  } catch (e) {
    if (process.env.PB_DUMP) { writeFileSync(join(process.env.PB_DUMP, "host.log"), t.logOf(hostHome)); writeFileSync(join(process.env.PB_DUMP, "joiner.log"), t.logOf(joinHome)); }
    throw new Error(`${stage}: ${e.message}\nhost:\n${t.logOf(hostHome).slice(-3000)}\njoiner:\n${t.logOf(joinHome).slice(-3000)}`);
  } finally {
    proxy?.close();
    fixture.close();
    await t.cleanup();
  }
});

test("garbage on the helper's socket never takes it down nor holds the queue", { skip: !runtime, timeout: 120_000 }, async () => {
  const t = setup();
  const h = t.home("cg-");
  const daemon = t.start(h);
  const running = (after) => assert.ok(daemon.exitCode === null && daemon.signalCode === null, `the helper is still running after ${after}:\n${readFileSync(join(h, "daemon.stderr.log"), "utf8").slice(-1500)}`);
  try {
    const good = await t.attach(h, "g");
    assert.ok(!(await good.tool("browser_tabs", { action: "list" })).result?.isError, "the browser is up");
    const list = { name: "browser_tabs", arguments: { action: "list" } };
    const lines = [
      "not json at all",
      "null", "true", "42", '"a string"', "[]", "[1,2,3]", "{}",
      '{"jsonrpc":"2.0"', // cut short
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "no/such/method" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: null }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_tabs", arguments: "list" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: 42 } }),
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "pairbrowse_collaboration", arguments: { action: "nope" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 6, method: "initialize", params: null }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: null }),
      JSON.stringify({ jsonrpc: "2.0", id: 7, result: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 8, method: 5 }),
      '{"__proto__":{"polluted":1},"jsonrpc":"2.0","id":9,"method":"tools/list"}',
    ];
    // Tool calls the browser server can't read (it drops them without an answer): each must still
    // be answered, and none may hold the shared queue.
    const unreadable = [
      { jsonrpc: "2.0", id: { x: 1 }, method: "tools/call", params: list },
      { jsonrpc: "1.0", id: "u2", method: "tools/call", params: list },
      { jsonrpc: "2.0", id: "u3", method: "tools/call", params: list, extra: 1 },
      { jsonrpc: "2.0", id: "u4", method: "tools/call", params: { ...list, _meta: 7 } },
      { jsonrpc: "2.0", id: "u5", method: "tools/call", params: { ...list, _meta: { progressToken: {} } } },
    ];
    // Each on a connection of its own (before and after initialize), then all on one.
    for (const [i, line] of lines.entries()) {
      const sock = net.createConnection(t.socketOf(h));
      sock.on("error", () => {});
      await new Promise((r) => { sock.once("connect", r); sock.once("error", r); });
      if (i % 2) sock.write(JSON.stringify({ jsonrpc: "2.0", id: "i", method: "initialize", params: INIT }) + "\n");
      sock.write(line + "\n");
      await sleep(50);
      sock.destroy();
      running(line);
    }
    const raw = net.createConnection(t.socketOf(h));
    raw.on("error", () => {});
    await new Promise((r) => { raw.once("connect", r); raw.once("error", r); });
    raw.write(lines.join("\n") + "\n");
    raw.write(Buffer.from([0xff, 0xfe, 0x00, 0x0a, 0xc3, 0x28, 0x0a])); // not UTF-8
    raw.write("x".repeat(20 * 1024 * 1024) + "\n"); // one huge line
    raw.write('{"jsonrpc":"2.0","id":"p","method":"tools/li'); // and one cut short by the close
    await sleep(500);
    raw.destroy();
    running("a stream of garbage");

    // An open session sending calls the server can't read: each answered with an error, at once.
    const odd = await t.attach(h, "o");
    const answers = [];
    createInterface({ input: odd.sock }).on("line", (l) => { try { answers.push(JSON.parse(l)); } catch {} });
    for (const m of unreadable) odd.sock.write(JSON.stringify(m) + "\n");
    await until("each unreadable call answered", () => {
      const got = new Set(answers.filter((a) => a.error || a.result).map((a) => a.id ?? "null"));
      return ["null", "u2", "u3", "u4", "u5"].every((id) => got.has(id));
    }, 15_000).catch((e) => { throw new Error(`${e.message}: ${JSON.stringify(answers).slice(0, 600)}`); });

    // Nothing holds the queue: the session there all along and a new one are answered at once,
    // and the browser was never reset for a stalled caller.
    const t0 = Date.now();
    assert.ok(!(await good.tool("browser_tabs", { action: "list" }, 30_000)).result?.isError, "the first session still works");
    const fresh = await t.attach(h, "n");
    assert.ok(!(await fresh.tool("browser_tabs", { action: "list" }, 30_000)).result?.isError, "a new session works");
    assert.ok(Date.now() - t0 < 10_000, `promptly (${Date.now() - t0} ms)`);
    assert.doesNotMatch(t.logOf(h), /resetting/);
    running("all of it");
  } finally {
    if (process.env.PB_DEBUG) console.log(t.logOf(h).slice(-4000));
    await t.cleanup();
  }
});
