// The session picker: the browser's first tab asks the person which session, unless an agent
// chose first. Live: a real helper and browser (PAIRBROWSE_TEST_RUNTIME).
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { panelExtensionId } from "../scripts/browser.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shortBase = existsSync("/Volumes/BACKUP/PairBrowse") ? "/Volumes/BACKUP/PairBrowse" : tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";
const EXTENSION = `chrome-extension://${panelExtensionId()}`;

// A home with something to go back to: the default session (with a saved tab) and "work".
function home(prefix, { saved = true } = {}) {
  mkdirSync(shortBase, { recursive: true });
  const dir = mkdtempSync(join(shortBase, prefix));
  symlinkSync(runtime, join(dir, "runtime"), "dir");
  if (saved) {
    mkdirSync(join(dir, "profile"), { recursive: true });
    mkdirSync(join(dir, "sessions", "work"), { recursive: true });
    writeFileSync(join(dir, "tabs.json"), JSON.stringify({ tabs: [{ url: "http://one.pbtest.example/home", title: "Home" }], active: 0 }));
    writeFileSync(join(dir, "sessions", "work.tabs.json"), JSON.stringify({ tabs: [{ url: "http://work.pbtest.example/a" }, { url: "http://work.pbtest.example/b" }], active: 1 }));
  }
  return dir;
}

function config(executablePath, port, extra = {}) {
  return JSON.stringify({ executablePath, chromeArgs: ["--headless=new", `--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${port}`], display: "none", screenshots: false, browserDriver: "playwright", ...extra });
}

// POST to the live view as a page at origin would (null: no Origin header).
function post(url, body, origin = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) } }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => { let json = null; try { json = JSON.parse(data); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function startDaemons() {
  const daemons = [];
  const connect = async (h, env = {}) => {
    const out = openSync(join(h, "daemon.stderr.log"), "a");
    daemons.push(spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: h, PAIRBROWSE_TEST_TUNNEL: "direct", PAIRBROWSE_TEST_JOIN_LOCAL: "1", ...env }, stdio: ["ignore", out, out] }));
    const socketPath = join(h, "run", "browser.sock");
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
    const waiting = new Map();
    createInterface({ input: sock }).on("line", (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    });
    let seq = 0;
    const call = (method, params = {}, ms = 60_000) => new Promise((resolve, reject) => {
      const id = `t${++seq}`;
      const timer = setTimeout(() => reject(new Error(`timed out: ${method} ${params.name || ""}`)), ms);
      waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
      sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } });
    sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tool = (name, args = {}, ms) => call("tools/call", { name, arguments: args }, ms);
    const live = async () => text(await tool("pairbrowse_liveview")).match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)[0];
    return { sock, tool, live };
  };
  const stop = () => Promise.all(daemons.map(async (d) => { if (d.exitCode === null) { d.kill("SIGTERM"); await Promise.race([new Promise((r) => d.once("exit", r)), sleep(10_000)]); } }));
  return { connect, stop };
}

const until = async (what, check, ms = 30_000) => {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if ((last = await check())) return last;
  throw new Error(`timed out: ${what}`);
};
// The live view lets the extension's origin in once the side panel connected (just after launch).
const panelConnected = (live) => until("the side panel connected", async () => (await post(`${live}pick`, { action: "noop" }, EXTENSION)).status === 409);
const logOf = (h) => { try { return readFileSync(join(h, "daemon.log"), "utf8").slice(-2500); } catch { return ""; } };

async function fixture() {
  const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<title>${req.headers.host}${req.url}</title><main>fixture</main>`); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server;
}

test("the picker shows when nobody chose, websites can't drive it, and the pick reaches the agent", { skip: !runtime, timeout: 120_000 }, async () => {
  const executablePath = createRequire(join(runtime, "package.json"))("playwright").chromium.executablePath();
  const site = await fixture();
  const h = home("pp-");
  writeFileSync(join(h, "config.json"), config(executablePath, site.address().port));
  const { connect, stop } = startDaemons();
  let stage = "start";
  try {
    const agent = await connect(h, { PAIRBROWSE_TEST_PICK_WAIT_MS: "4000" });
    const live = await agent.live();

    stage = "the first action waits, then says the browser is waiting for the person";
    const t0 = Date.now();
    const first = await agent.tool("browser_tabs", { action: "list" });
    assert.ok(Date.now() - t0 >= 3500, "it waited for the pick");
    assert.equal(first.result.isError, true);
    assert.match(text(first), /waiting for the person to pick a session.*Ask them in chat/s);

    stage = "the picker is the first tab, with the saved sessions";
    const state = await (await fetch(`${live}sessions.json`)).json();
    assert.equal(state.picking, true);
    const byName = Object.fromEntries(state.sessions.map((s) => [s.name, s]));
    assert.equal(byName.default.tabs, 1);
    assert.equal(byName.work.tabs, 2);
    assert.deepEqual(byName.work.sites, ["work.pbtest.example"]);
    assert.equal(byName.default.current, true);
    const tabs = await until("the picker tab", async () => {
      const t = (await (await fetch(`${live}state.json`)).json()).tabs;
      return t.some((x) => x.url === `${EXTENSION}/picker.html` && x.title === "Choose a session") && t;
    });
    assert.ok(!tabs.some((x) => /pbtest/.test(x.url)), "saved tabs wait until the person picks");

    stage = "websites can't pick";
    await panelConnected(live);
    for (const origin of ["https://evil.example", "http://evil.example", `chrome-extension://${"a".repeat(32)}`, "null"]) {
      assert.equal((await post(`${live}pick`, { action: "new" }, origin)).status, 403, origin);
      assert.equal((await post(`${live}pick`, { action: "join", code: "pb-join:x" }, origin)).status, 403, origin);
    }
    assert.equal((await post(live.replace(/\/[^/]+\/$/, "/wrongkey/pick"), { action: "new" }, EXTENSION)).status, 404, "without the key");
    assert.equal((await fetch(live.replace(/\/[^/]+\/$/, "/wrongkey/sessions.json"))).status, 404);
    assert.equal((await post(`${live}pick`, { action: "use", name: "../x" }, EXTENSION)).status, 409);
    assert.equal((await (await fetch(`${live}sessions.json`)).json()).picking, true, "nothing was picked");

    stage = "the person picks work in the picker";
    const waiting = agent.tool("browser_tabs", { action: "list" }, 60_000);
    await sleep(300); // the call is waiting for the pick
    const r = await post(`${live}pick`, { action: "use", name: "work" }, EXTENSION);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const done = await waiting;
    assert.ok(!done.result.isError, text(done));
    assert.match(text(done), /The person picked session "work" in the browser/);
    assert.match(text(await agent.tool("pairbrowse_session", { action: "list" })), /^\* work/m);
    await until("work's tabs", async () => /work\.pbtest\.example\/b/.test(text(await agent.tool("browser_tabs", { action: "list" }))));
    const after = await agent.live();
    assert.equal((await (await fetch(`${after}sessions.json`)).json()).picking, false);
    assert.equal((await post(`${after}pick`, { action: "new" }, EXTENSION)).status, 409, "no second pick");

    stage = "who used it is remembered for the picker, most recently used first";
    const later = await (await fetch(`${after}sessions.json`)).json();
    assert.equal(later.sessions[0].name, "work");
    const kinds = later.sessions[0].people.map((p) => `${p.kind}:${p.who}:${p.app}`);
    assert.ok(kinds.includes("you:You:"), kinds.join());
    assert.ok(kinds.includes("agent:Claude:Claude Code"), kinds.join());
    assert.ok(later.sessions[0].people.every((p) => !("url" in p) && !("tabs" in p)), "names and kinds only");
  } catch (e) {
    throw new Error(`${stage}: ${e.message}\n${logOf(h)}`);
  } finally {
    await stop();
    site.close();
    rmSync(h, { recursive: true, force: true });
  }
});

test("no picker when the agent chose first, when it's off, or on the very first start", { skip: !runtime, timeout: 120_000 }, async () => {
  const executablePath = createRequire(join(runtime, "package.json"))("playwright").chromium.executablePath();
  const site = await fixture();
  const homes = [home("pc-"), home("po-"), home("pf-", { saved: false })];
  writeFileSync(join(homes[0], "config.json"), config(executablePath, site.address().port));
  writeFileSync(join(homes[1], "config.json"), config(executablePath, site.address().port, { sessionPicker: false }));
  writeFileSync(join(homes[2], "config.json"), config(executablePath, site.address().port));
  const { connect, stop } = startDaemons();
  let stage = "agent chose";
  try {
    const agent = await connect(homes[0]);
    assert.match(text(await agent.tool("pairbrowse_session", { action: "new", clean: true })), /clean, throwaway browser/);
    const t0 = Date.now();
    const listed = await agent.tool("browser_tabs", { action: "list" });
    assert.ok(!listed.result.isError, text(listed));
    assert.ok(Date.now() - t0 < 15_000);
    assert.doesNotMatch(text(listed), /picker\.html/);
    assert.equal((await (await fetch(`${await agent.live()}sessions.json`)).json()).picking, false);

    for (const [i, what] of [[1, "picker off"], [2, "first start"]]) {
      stage = what;
      const a = await connect(homes[i]);
      const r = await a.tool("browser_tabs", { action: "list" });
      assert.ok(!r.result.isError, text(r));
      assert.doesNotMatch(text(r), /picker\.html/);
    }
  } catch (e) {
    throw new Error(`${stage}: ${e.message}\n${homes.map(logOf).join("\n---\n")}`);
  } finally {
    await stop();
    site.close();
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  }
});

test("joining from the picker takes the same code checks and the host's approval", { skip: !runtime, timeout: 180_000 }, async () => {
  const executablePath = createRequire(join(runtime, "package.json"))("playwright").chromium.executablePath();
  const site = await fixture();
  const hostHome = home("ph-", { saved: false });
  const joinHome = home("pj-");
  writeFileSync(join(hostHome, "config.json"), config(executablePath, site.address().port, { participantName: "Bob" }));
  writeFileSync(join(joinHome, "config.json"), config(executablePath, site.address().port, { participantName: "Alice" }));
  const { connect, stop } = startDaemons();
  let stage = "start";
  try {
    const host = await connect(hostHome);
    assert.ok(!(await host.tool("browser_navigate", { url: "http://one.pbtest.example/shared" })).result.isError);
    const code = text(await host.tool("pairbrowse_invite", { action: "create", role: "watch", label: "Alice", share: "code" })).match(/Join code: (pb-join:[A-Za-z0-9_-]+)/)?.[1];
    assert.ok(code);

    stage = "the joiner's agent waits on the picker";
    const joiner = await connect(joinHome);
    const live = await joiner.live();
    const waiting = joiner.tool("browser_tabs", { action: "list" }, 90_000);
    await until("the picker", async () => (await (await fetch(`${live}sessions.json`)).json()).picking);

    stage = "a bad code is refused, like pairbrowse_join";
    await panelConnected(live);
    const bad = await post(`${live}pick`, { action: "join", code: "pb-join:bad" }, EXTENSION);
    assert.equal(bad.status, 409);
    assert.match(bad.json.text, /Not joining/);
    assert.equal((await (await fetch(`${live}sessions.json`)).json()).picking, true);

    stage = "the person joins from the picker: the host has to approve";
    const asked = await post(`${live}pick`, { action: "join", code }, EXTENSION);
    assert.equal(asked.status, 200, JSON.stringify(asked.json));
    assert.match(asked.json.text, /Asked Bob to let Alice in \(watch\)\. They have to approve first\./);
    const done = await waiting;
    assert.match(text(done), /joined a shared session from the browser's session picker/);
    await until("waiting for approval", async () => /Waiting for Bob to approve/.test(text(await joiner.tool("pairbrowse_join", { action: "status" }))));
    await sleep(2000);
    assert.doesNotMatch(text(await joiner.tool("browser_tabs", { action: "list" })), /one\.pbtest\.example\/shared/, "nothing before approval");
    const id = await until("the request at the host", async () => text(await host.tool("pairbrowse_invite", { action: "list" })).match(/request (r[0-9a-f]{6}): Alice[^,\n]*, waiting/)?.[1]);

    stage = "approved: the shared tab opens";
    assert.match(text(await host.tool("pairbrowse_invite", { action: "approve", id })), /Let Alice in/);
    await until("the shared tab", async () => /one\.pbtest\.example\/shared/.test(text(await joiner.tool("browser_tabs", { action: "list" }))));

    stage = "the host's picker data: Alice used the session and is in it now, with her kind of computer";
    const hostLive = await host.live();
    const mine = (await (await fetch(`${hostLive}sessions.json`)).json()).sessions.find((s) => s.current);
    const computer = { darwin: "Mac", linux: "Linux", win32: "Windows" }[process.platform];
    assert.ok(mine.people.some((p) => p.kind === "guest" && p.who === "Alice" && p.computer === computer), JSON.stringify(mine.people));
    await until("Alice live", async () => (await (await fetch(`${hostLive}sessions.json`)).json()).sessions.find((s) => s.current).live.some((p) => p.who === "Alice"));
  } catch (e) {
    throw new Error(`${stage}: ${e.message}\nhost:\n${logOf(hostHome)}\njoiner:\n${logOf(joinHome)}`);
  } finally {
    await stop();
    site.close();
    rmSync(hostHome, { recursive: true, force: true });
    rmSync(joinHome, { recursive: true, force: true });
  }
});
