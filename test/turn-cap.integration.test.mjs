// One call can't hold the shared queue forever: past the cap (PAIRBROWSE_TURN_MAX_MS) the helper
// answers it, resets the browser and lets the next agent go on. Live: a real helper and browser
// (PAIRBROWSE_TEST_RUNTIME).
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";

// A session on the helper's socket, as Claude Code would open one.
async function session(socketPath, name) {
  let sock;
  for (let i = 0; ; i++) {
    sock = net.createConnection(socketPath);
    if (await new Promise((r) => { sock.once("connect", () => r(true)); sock.once("error", () => r(false)); })) break;
    if (i > 50) throw new Error(`couldn't connect to ${socketPath}`);
    await sleep(200);
  }
  const waiting = new Map();
  const answers = [];
  createInterface({ input: sock }).on("line", (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined) answers.push(m.id);
    if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  let seq = 0;
  const call = (method, params = {}, ms = 60_000) => new Promise((resolve, reject) => {
    const id = `${name}${++seq}`;
    const timer = setTimeout(() => reject(new Error(`timed out: ${method} ${params.name || ""}`)), ms);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } });
  sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return { sock, answers, tool: (tool, args = {}, ms) => call("tools/call", { name: tool, arguments: args }, ms) };
}

test("a call that runs past the cap is answered, the browser resets, and the next agent goes on", { skip: !runtime, timeout: 240_000 }, async () => {
  const executablePath = createRequire(join(runtime, "package.json"))("playwright").chromium.executablePath();
  const base = existsSync("/Volumes/BACKUP/PairBrowse") ? "/Volumes/BACKUP/PairBrowse" : tmpdir();
  mkdirSync(base, { recursive: true });
  const h = mkdtempSync(join(base, "cap-"));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new"], display: "none", screenshots: false, browserDriver: "playwright" }));
  const out = openSync(join(h, "daemon.stderr.log"), "a");
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: h, PAIRBROWSE_TURN_MAX_MS: "20000" }, stdio: ["ignore", out, out] });
  const a = [];
  try {
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
    // The session is picked while Alice is alone (switching needs nobody else connected). Starting
    // the browser runs under the cap too: on a very busy computer it can pass it, and then the
    // helper resets as it should; Alice reconnects (as her bridge would) and picks it again.
    let alice, picked = "";
    for (let i = 0; i < 3 && !/clean/.test(picked); i++) {
      if (alice) { alice.sock.destroy(); a.splice(a.indexOf(alice), 1); }
      alice = await session(socketPath, `a${i}`);
      a.push(alice);
      picked = text(await alice.tool("pairbrowse_session", { action: "new", clean: true }));
      if (!/clean/.test(picked)) assert.match(picked, /didn't finish in 20 seconds/, picked);
    }
    assert.match(picked, /clean/);
    const bob = await session(socketPath, "b");
    a.push(bob);
    assert.ok(!(await alice.tool("browser_tabs", { action: "list" })).result?.isError, "the browser is up");

    // The cap leaves room for a busy computer to start the browser (the whole live suite at once
    // can take over 10 s). Alice's call waits 60 s, far past the 20 s cap; Bob's call queues behind it.
    const started = Date.now();
    const stuck = alice.tool("browser_wait_for", { time: 60 }, 90_000);
    await sleep(300);
    bob.tool("browser_tabs", { action: "list" }, 90_000).catch(() => {}); // ends with the reset; the bridge would fail it
    const r = await stuck;
    const took = Date.now() - started;
    assert.ok(r.result?.isError, text(r));
    assert.match(text(r), /didn't finish in 20 seconds, so PairBrowse reset the browser/, text(r));
    assert.ok(took >= 19_000 && took < 45_000, `answered at the cap, not after the wait (${took} ms)`);
    assert.match(readFileSync(join(h, "daemon.log"), "utf8"), /browser_wait_for held the browser for 20 seconds; resetting the browser/);

    // The reset ended both connections; reconnected (as each session's bridge does), the next
    // agent goes on at once instead of waiting behind the stuck call.
    for (let i = 0; i < 100 && !/browser closed/.test(readFileSync(join(h, "daemon.log"), "utf8")); i++) await sleep(100);
    for (const s of a.splice(0)) s.sock.destroy();
    const again = await session(socketPath, "c");
    a.push(again);
    const listed = await again.tool("browser_tabs", { action: "list" }, 45_000);
    assert.ok(!listed.result?.isError, text(listed));
    // (Its time includes starting the browser again, so only the stuck call's end bounds it.)
    assert.ok(Date.now() - started < 60_000, "the next call didn't wait for the stuck one's 60 s");
  } finally {
    if (process.env.PB_DEBUG) console.log("LOG\n" + (() => { try { return readFileSync(join(h, "daemon.log"), "utf8") + readFileSync(join(h, "daemon.stderr.log"), "utf8").slice(-3000); } catch { return ""; } })());
    for (const s of a) s.sock.destroy();
    if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await Promise.race([new Promise((r) => daemon.once("exit", r)), sleep(10_000)]); }
    rmSync(h, { recursive: true, force: true });
  }
});
