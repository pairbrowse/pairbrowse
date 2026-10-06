// After an update, the browser must run the side panel worker on disk, not the copy it cached
// (Chromium keeps an extension's worker script in the profile and goes on running it): a helper
// from an earlier PairBrowse (its worker without a build and without the join notification's
// Allow and Deny) starts the browser in a profile, then the current helper starts it in the same
// profile, and the worker is the current one, with the live view handed over and join
// notifications with their buttons. Then a worker found old while running: its record goes, so
// the next start loads it anew. Headless, in a temporary home. Needs PAIRBROWSE_TEST_RUNTIME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import net from "node:net";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, readFileSync, rmSync, existsSync, openSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { panelBuild } from "../scripts/browser.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

// An earlier PairBrowse: this one's scripts with the side panel worker as it was before builds
// (no PB_BUILD, no join notification buttons).
function earlierCopy(base) {
  const dir = join(base, "old");
  for (const part of ["scripts", "package.json"]) cpSync(join(root, part), join(dir, part), { recursive: true });
  const file = join(dir, "scripts", "browser", "panel", "background.js");
  const source = readFileSync(file, "utf8");
  const old = source.replace(/^const PB_BUILD = .*\n^globalThis\.pbBuild = PB_BUILD;\n/m, "").replace("globalThis.pbNotifyJoin = (", "globalThis.pbNotifyJoinNotYet = (");
  assert.notEqual(old, source);
  assert.doesNotMatch(old, /PB_BUILD|pbNotifyJoin =/);
  writeFileSync(file, old);
  return dir;
}

test("after an update the browser runs the side panel's current worker, not its cached copy, and join notifications have their buttons", { skip: !runtime, timeout: 180_000 }, async () => {
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  const fixture = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<title>fixture</title><main>fixture</main>"); });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  mkdirSync(shortBase, { recursive: true });
  const base = mkdtempSync(join(shortBase, "pr-"));
  const home = join(base, "home");
  mkdirSync(home);
  symlinkSync(runtime, join(home, "runtime"), "dir");
  writeFileSync(join(home, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new"], display: "none", screenshots: false, participantName: "Bob", sessionPicker: false }));
  const logText = () => (existsSync(join(home, "daemon.log")) ? readFileSync(join(home, "daemon.log"), "utf8") : "");
  const fail = (what) => new Error(`timed out: ${what}\n${logText().split("\n").slice(-30).join("\n")}`);
  let helper = null;
  const start = async (from) => {
    const out = openSync(join(home, "daemon.stderr.log"), "a");
    const daemon = spawn(process.execPath, [join(from, "scripts", "daemon.mjs")], { cwd: from, env: { ...process.env, PAIRBROWSE_HOME: home, PAIRBROWSE_TEST_PANEL: "1" }, stdio: ["ignore", out, out] });
    const socketPath = join(home, "run", "browser.sock");
    let sock;
    for (let i = 0; ; i++) {
      if (existsSync(socketPath)) {
        sock = net.createConnection(socketPath);
        if (await new Promise((r) => { sock.once("connect", () => r(true)); sock.once("error", () => r(false)); })) break;
      }
      if (i > 100) throw new Error(`couldn't connect to ${socketPath}`);
      await sleep(200);
    }
    const call = rpc((l) => sock.write(l), sock);
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } });
    sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tool = async (name, args = {}) => text(await call("tools/call", { name, arguments: args }));
    helper = { daemon, sock, tool };
    return helper;
  };
  const stop = async () => {
    if (!helper) return;
    const { daemon, sock } = helper;
    helper = null;
    sock.destroy();
    if (daemon.exitCode === null) { daemon.kill(); await new Promise((r) => daemon.once("exit", r)); }
    rmSync(join(home, "run", "browser.sock"), { force: true });
  };
  const state = async (h) => { try { return JSON.parse(await h.tool("pairbrowse_test_panel")); } catch { return null; } };
  const until = async (what, check, ms = 40_000) => {
    let last;
    for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if ((last = await check())) return last;
    throw fail(what);
  };
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  try {
    const build = panelBuild();
    assert.match(build, /^[0-9a-f]{16}$/);

    // The earlier PairBrowse: its worker, cached in the profile.
    const old = await start(earlierCopy(base));
    await old.tool("browser_navigate", { url });
    const before = await until("the earlier side panel", async () => { const s = await state(old); return s?.view && s; });
    assert.equal(before.build, null);
    assert.equal(before.notifyJoin, "undefined");
    await stop();

    // The update: the current helper, same profile. The cached worker is dropped before the launch.
    const now = await start(root);
    await now.tool("browser_navigate", { url });
    const after = await until("the current side panel", async () => { const s = await state(now); return s?.view && s; });
    assert.equal(after.build, build, "the worker on disk, not the cached copy");
    assert.equal(after.notifyJoin, "function");
    assert.match(logText(), /side panel: its worker changed since the last start; the browser loads it anew/);
    assert.doesNotMatch(logText(), /runs an old copy of its worker/);
    // The join notification goes with its Allow and Deny, not the system's text-only one.
    assert.equal(await now.tool("pairbrowse_test_panel", { notifyJoin: "r00aa01" }), "sent");
    await until("the notification", async () => /notification sent \(join request r00aa01, with Allow and Deny\)/.test(logText()), 15_000);
    assert.doesNotMatch(logText(), /answered "no buttons"/);
    const profile = join(home, "profile");
    assert.equal(readFileSync(join(profile, "PairBrowse panel build"), "utf8"), build);

    // An old worker found while running: noticed, and its record goes, so the next start drops it.
    assert.equal(await now.tool("pairbrowse_test_panel", { stale: true }), "stale");
    assert.match(logText(), /the browser runs an old copy of its worker \(build none, not [0-9a-f]{16}\); it's loaded anew at the next browser start/);
    assert.equal(existsSync(join(profile, "PairBrowse panel build")), false);
    await stop();

    // The next start: dropped again, current again.
    const again = await start(root);
    await again.tool("browser_navigate", { url });
    const third = await until("the side panel after the restart", async () => { const s = await state(again); return s?.view && s; });
    assert.equal(third.build, build);
    assert.equal(third.notifyJoin, "function");
    assert.equal(logText().match(/the browser loads it anew/g).length, 2);
  } finally {
    await stop().catch(() => {});
    fixture.close();
    rmSync(base, { recursive: true, force: true });
  }
});
