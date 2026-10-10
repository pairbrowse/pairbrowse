// The browser is killed under a session (a crash): the call in flight is answered, nothing of the
// session's pictures stays, the helper lives on and the next action reopens the browser with the
// tabs back. Live: a real helper and browser (PAIRBROWSE_TEST_RUNTIME).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, symlinkSync, writeFileSync, rmSync, existsSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { session } from "./live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";

// The browser process under the helper: the helper's child that isn't a node process.
function browserPid(helperPid) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).trim().split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
  const kid = rows.find((r) => Number(r[2]) === helperPid && !/node/.test(r[3]) && !/--type=/.test(r[3]));
  return kid ? Number(kid[1]) : 0;
}

test("the browser killed under a session: the call is answered, pictures are forgotten, the next action brings it back with its tabs", { skip: !runtime || process.platform === "win32", timeout: 240_000 }, async () => {
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  const h = mkdtempSync(join(tmpdir(), "pb-crash-"));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new"], display: "none", sessionPicker: false }));
  const out = openSync(join(h, "daemon.stderr.log"), "a");
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: h, PAIRBROWSE_TEST_MEMORY: "1" }, stdio: ["ignore", out, out] });
  const server = createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(`<!doctype html><title>Page ${req.url}</title><h1>${req.url}</h1><button id="b">Go</button>`); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
  const open = [];
  try {
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
    const a = await session(socketPath, "a");
    open.push(a);
    assert.match(text(await a.tool("pairbrowse_session", { action: "new", clean: true })), /clean/);
    assert.ok(!(await a.tool("browser_navigate", { url: url("/one") })).result?.isError);
    assert.ok(!(await a.tool("browser_tabs", { action: "new" })).result?.isError);
    assert.ok(!(await a.tool("browser_navigate", { url: url("/two") })).result?.isError);
    const before = JSON.parse(text(await a.tool("pairbrowse_test_memory")));
    assert.equal(before.screenshots, 1, "a picture map for this session");
    // A long wait is in flight when the browser dies.
    const waiting = a.tool("browser_wait_for", { time: 30 }, 60_000);
    await sleep(500);
    const pid = browserPid(daemon.pid);
    assert.ok(pid, "the browser process is found");
    process.kill(pid, "SIGKILL");
    const answered = await waiting;
    assert.match(text(answered), /browser closed|closed while waiting/i, "the call in flight hears of it");
    // The helper lives on; its sessions end a moment later (the bridge would reconnect).
    await sleep(1500);
    assert.equal(daemon.exitCode, null, "the helper is still up");
    assert.ok(a.sock.destroyed || a.sock.readyState !== "open", "the session's connection ended with the browser");
    const b = await session(socketPath, "b");
    open.push(b);
    // Before the new session's first picture: nothing of the ended session's stays.
    const after = JSON.parse(text(await b.tool("pairbrowse_test_memory", {}, 120_000)));
    assert.equal(after.screenshots, 0, "nothing of the ended session's pictures stays");
    assert.equal(after.clients, 1, "only the new session is connected");
    const list = text(await b.tool("browser_tabs", { action: "list" }, 120_000));
    assert.match(list, /\/one/, `the tabs are back: ${list.slice(0, 300)}`);
    assert.match(list, /\/two/);
    assert.ok(!(await b.tool("browser_snapshot", {})).result?.isError, "the new session works in the reopened browser");
    assert.ok(after.close <= before.close + 1, `close listeners ${before.close} -> ${after.close}`);
  } catch (e) {
    throw new Error(`${e.message}\n${(() => { try { return readFileSync(join(h, "daemon.log"), "utf8").slice(-2500); } catch { return ""; } })()}`);
  } finally {
    for (const s of open) s.sock.destroy();
    server.close();
    if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await Promise.race([new Promise((r) => daemon.once("exit", r)), sleep(10_000)]); }
    rmSync(h, { recursive: true, force: true });
  }
});
