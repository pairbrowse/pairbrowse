// A join code outlives a restart of the host's helper: two temporary homes on this computer (a
// host and a joiner, each with its own real browser) in shared browser mode; the host's helper
// stops and starts again (an update, a crash), and the joiner is back in by itself, with no new
// code and no new approval, and their agent works in the host's browser again. Revoking ends it,
// saved state and all. The sharing tunnel is skipped (PAIRBROWSE_TEST_TUNNEL=direct). Needs
// PAIRBROWSE_TEST_RUNTIME.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync, existsSync, openSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shortBase = existsSync("/Volumes/BACKUP/PairBrowse") ? "/Volumes/BACKUP/PairBrowse" : tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP = `<title>App</title><button>Tap</button><input aria-label="Note">`;

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

test("shared browser: the joiner stays in through a restart of the host's helper, and revoking ends it", { skip: !runtime, timeout: 240_000 }, async () => {
  const require = createRequire(join(runtime, "package.json"));
  const executablePath = process.env.PAIRBROWSE_TEST_EXECUTABLE || require("patchright").chromium.executablePath();
  const fixture = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(APP); });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const chromeArgs = ["--headless=new", `--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${fixture.address().port}`];
  mkdirSync(shortBase, { recursive: true });
  const home = (prefix) => { const dir = mkdtempSync(join(shortBase, prefix)); symlinkSync(runtime, join(dir, "runtime"), "dir"); return dir; };
  const hostHome = home("rh-"), joinHome = home("rj-");
  const config = (name) => JSON.stringify({ executablePath, chromeArgs, display: "none", screenshots: false, participantName: name, sessionPicker: false });
  writeFileSync(join(hostHome, "config.json"), config("Bob"));
  writeFileSync(join(joinHome, "config.json"), config("Alice"));
  const env = (h) => ({ ...process.env, PAIRBROWSE_HOME: h, PAIRBROWSE_TEST_SCREEN: "1", PAIRBROWSE_TEST_TUNNEL: "direct", PAIRBROWSE_TEST_JOIN_LOCAL: "1" });
  const daemons = [];
  const start = (h) => { const out = openSync(join(h, "daemon.stderr.log"), "a"); const d = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: env(h), stdio: ["ignore", out, out] }); daemons.push(d); return d; };
  const attach = async (h) => {
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 100 && !existsSync(socketPath); i++) await sleep(50);
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
    for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if ((last = await check())) return last;
    throw new Error(`timed out: ${what}${last !== undefined ? ` (last: ${String(last).slice(0, 300)})` : ""}`);
  };
  let host, joiner, hostDaemon, stage = "start";
  try {
    hostDaemon = start(hostHome);
    host = await attach(hostHome);
    start(joinHome);
    joiner = await attach(joinHome);
    stage = "joined and approved";
    assert.ok(!(await tool(host.call, "browser_navigate", { url: "http://one.pbtest.example/app" })).result.isError);
    const code = text(await tool(host.call, "pairbrowse_invite", { action: "create", role: "drive", label: "Alice", share: "code" })).match(/Join code: (pb-join:[A-Za-z0-9_-]+)/)?.[1];
    assert.ok(code);
    await tool(joiner.call, "pairbrowse_join", { action: "join", code });
    const id = await until("the request", async () => text(await tool(host.call, "pairbrowse_invite", { action: "list" })).match(/request (r[0-9a-f]{6}): Alice/)?.[1]);
    assert.match(text(await tool(host.call, "pairbrowse_invite", { action: "approve", id })), /Let Alice in/);
    await until("the joiner in", async () => /You're in Bob's session/.test(text(await tool(joiner.call, "pairbrowse_join", { action: "status" }))));
    await tool(host.call, "pairbrowse_collaboration", { action: "release" });
    assert.match(text(await tool(joiner.call, "browser_snapshot")), /button "Tap"/, "the joiner's agent works in the host's browser");
    const saved = join(hostHome, "sharing.json");
    assert.ok(existsSync(saved), "the code is kept for a restart");
    assert.equal(statSync(saved).mode & 0o077, 0, "private to this account");
    assert.doesNotMatch(readFileSync(saved, "utf8"), /one\.pbtest|Tap/, "codes and yeses only, nothing of the pages");

    stage = "the host's helper restarts; the joiner is back in by itself";
    host.sock.destroy();
    hostDaemon.kill("SIGTERM");
    await new Promise((r) => hostDaemon.once("exit", r));
    assert.ok(existsSync(saved), "kept through the stop");
    hostDaemon = start(hostHome);
    host = await attach(hostHome);
    assert.ok(!(await tool(host.call, "browser_tabs", { action: "list" })).result.isError); // the browser (and its live view) starts
    await tool(host.call, "pairbrowse_liveview");
    if (!(await tool(host.call, "browser_tabs", { action: "list" })).result.isError) {
      const list = text(await tool(host.call, "browser_tabs", { action: "list" }));
      if (!/one\.pbtest\.example/.test(list)) await tool(host.call, "browser_navigate", { url: "http://one.pbtest.example/app" });
    }
    await tool(host.call, "pairbrowse_collaboration", { action: "release" });
    await until("the joiner in again", async () => /You're in Bob's session/.test(text(await tool(joiner.call, "pairbrowse_join", { action: "status" }))), 60_000);
    const list = text(await tool(host.call, "pairbrowse_invite", { action: "list" }));
    assert.doesNotMatch(list, /waiting/, `no new request to approve: ${list}`);
    assert.match(list, /Alice/, "the same invite");
    const snap = await until("the joiner's agent in the host's browser again", async () => { const s = text(await tool(joiner.call, "browser_snapshot")); return /button "Tap"/.test(s) && s; }, 30_000);
    assert.match(snap, /one\.pbtest\.example/);

    stage = "revoking ends it, saved state and all";
    await tool(host.call, "pairbrowse_invite", { action: "revoke_all" });
    assert.ok(!existsSync(saved), "nothing kept once it's over");
    await until("the joiner out", async () => /doesn't work any more|not in/i.test(text(await tool(joiner.call, "pairbrowse_join", { action: "status" }))), 30_000);
  } catch (e) {
    const log = (h) => { try { return readFileSync(join(h, "daemon.log"), "utf8").slice(-3000); } catch { return ""; } };
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
