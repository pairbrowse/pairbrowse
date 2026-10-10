// Sessions that come and go leave nothing behind: each session's browser server listens for the
// browser's end, and those listeners (and with them the whole server, about 1 MB) used to stay
// for as long as the browser ran. Live: a real helper and browser (PAIRBROWSE_TEST_RUNTIME).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { session } from "./live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";

test("sessions that came and went leave no listeners on the browser", { skip: !runtime, timeout: 240_000 }, async () => {
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  const base = existsSync("/Volumes/BACKUP/PairBrowse") ? "/Volumes/BACKUP/PairBrowse" : tmpdir();
  mkdirSync(base, { recursive: true });
  const h = mkdtempSync(join(base, "mem-"));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new"], display: "none", screenshots: false }));
  const out = openSync(join(h, "daemon.stderr.log"), "a");
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: h, PAIRBROWSE_TEST_MEMORY: "1" }, stdio: ["ignore", out, out] });
  const open = [];
  try {
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
    const owner = await session(socketPath, "own");
    open.push(owner);
    assert.match(text(await owner.tool("pairbrowse_session", { action: "new", clean: true })), /clean/);
    assert.ok(!(await owner.tool("browser_tabs", { action: "list" })).result?.isError);
    const count = async () => JSON.parse(text(await owner.tool("pairbrowse_test_memory")));
    const before = await count();
    for (let i = 0; i < 8; i++) {
      const a = await session(socketPath, `a${i}x`);
      assert.ok(!(await a.tool("browser_tabs", { action: "list" })).result?.isError);
      a.sock.destroy();
    }
    let after;
    for (let i = 0; i < 50; i++) { after = await count(); if (after.close <= before.close && after.disconnected <= before.disconnected) break; await sleep(200); }
    assert.ok(after.close <= before.close, `close listeners ${before.close} -> ${after.close}`);
    assert.ok(after.disconnected <= before.disconnected, `disconnected listeners ${before.disconnected} -> ${after.disconnected}`);
    assert.equal(after.clients, 1, "the sessions that went are gone");
  } catch (e) {
    throw new Error(`${e.message}\n${(() => { try { return readFileSync(join(h, "daemon.log"), "utf8").slice(-2000); } catch { return ""; } })()}`);
  } finally {
    for (const s of open) s.sock.destroy();
    if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await Promise.race([new Promise((r) => daemon.once("exit", r)), sleep(10_000)]); }
    rmSync(h, { recursive: true, force: true });
  }
});

// Each session's screenshot map (what pairbrowse_click_at clicks on) goes with the session: a
// session that took pictures and left leaves none behind, whether it ended cleanly or was cut.
test("sessions that took pictures and left leave no screenshot maps behind", { skip: !runtime, timeout: 240_000 }, async () => {
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  const base = existsSync("/Volumes/BACKUP/PairBrowse") ? "/Volumes/BACKUP/PairBrowse" : tmpdir();
  const h = mkdtempSync(join(base, "shot-"));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new"], display: "none" }));
  const out = openSync(join(h, "daemon.stderr.log"), "a");
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: h, PAIRBROWSE_TEST_MEMORY: "1" }, stdio: ["ignore", out, out] });
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(`<!doctype html><title>Pictures</title><h1>${req.url}</h1><button>Go</button>`); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const open = [];
  try {
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
    const owner = await session(socketPath, "own");
    open.push(owner);
    assert.match(text(await owner.tool("pairbrowse_session", { action: "new", clean: true })), /clean/);
    assert.ok(!(await owner.tool("browser_navigate", { url: `http://127.0.0.1:${server.address().port}/p` })).result?.isError);
    const count = async () => JSON.parse(text(await owner.tool("pairbrowse_test_memory")));
    assert.equal((await count()).screenshots, 1, "the owner's map");
    const gone = [];
    for (let i = 0; i < 4; i++) {
      const a = await session(socketPath, `s${i}x`);
      assert.ok(!(await a.tool("browser_tabs", { action: "new" })).result?.isError);
      assert.ok(!(await a.tool("browser_navigate", { url: `http://127.0.0.1:${server.address().port}/s${i}` })).result?.isError);
      assert.ok((await a.tool("browser_snapshot", {})).result?.content?.some((c) => c.type === "image"), "a picture went to the session");
      gone.push(a);
    }
    assert.equal((await count()).screenshots, 5, "a map per session that got a picture");
    gone[0].sock.destroy(); // cut
    gone[1].sock.end(); // closed cleanly
    gone[2].sock.destroy();
    gone[3].sock.end();
    let after;
    for (let i = 0; i < 50; i++) { after = await count(); if (after.screenshots === 1 && after.clients === 1) break; await sleep(200); }
    assert.equal(after.screenshots, 1, `only the owner's map stays: ${after.screenshots}`);
    assert.equal(after.clients, 1);
    // The owner's own map goes with its tab (the close's result carries a picture of the tab
    // shown next, so at most that one map stays).
    assert.ok(!(await owner.tool("browser_tabs", { action: "close" })).result?.isError);
    after = await count();
    assert.ok(after.screenshots <= 1, `a closed tab's map is gone: ${after.screenshots}`);
    assert.equal(after.clients, 1);
  } catch (e) {
    throw new Error(`${e.message}\n${(() => { try { return readFileSync(join(h, "daemon.log"), "utf8").slice(-2000); } catch { return ""; } })()}`);
  } finally {
    for (const s of open) s.sock.destroy();
    server.close();
    if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await Promise.race([new Promise((r) => daemon.once("exit", r)), sleep(10_000)]); }
    rmSync(h, { recursive: true, force: true });
  }
});

// The driver (Patchright) kept every execution context a tab ever had: a few per navigation,
// each with its handles and waits, for as long as the tab lived (scripts/daemon/contexts.mjs).
test("a tab's navigations leave no execution contexts behind in the driver", { skip: !runtime, timeout: 240_000 }, async () => {
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  const base = existsSync("/Volumes/BACKUP/PairBrowse") ? "/Volumes/BACKUP/PairBrowse" : tmpdir();
  const h = mkdtempSync(join(base, "ctx-"));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new"], display: "none", screenshots: false }));
  const out = openSync(join(h, "daemon.stderr.log"), "a");
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: h, PAIRBROWSE_TEST_MEMORY: "1" }, stdio: ["ignore", out, out] });
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(`<!doctype html><title>Page ${req.url}</title><h1>${req.url}</h1><input name="q">`); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = (i) => `http://127.0.0.1:${server.address().port}/p${i}`;
  let owner;
  try {
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
    owner = await session(socketPath, "ctx");
    assert.match(text(await owner.tool("pairbrowse_session", { action: "new", clean: true })), /clean/);
    const probe = async () => JSON.parse(text(await owner.tool("pairbrowse_test_memory")));
    assert.ok(!(await owner.tool("browser_navigate", { url: url(0) })).result?.isError);
    assert.ok(!(await owner.tool("browser_snapshot", {})).result?.isError);
    const before = await probe();
    assert.ok(before.contexts >= 0, `the probe counts contexts: ${JSON.stringify(before)}`);
    for (let i = 1; i <= 12; i++) {
      assert.ok(!(await owner.tool("browser_navigate", { url: url(i) })).result?.isError, `navigation ${i}`);
      assert.ok(!(await owner.tool("browser_snapshot", {})).result?.isError);
    }
    const after = await probe();
    assert.ok(after.contexts <= before.contexts + 4, `execution contexts held by the driver: ${before.contexts} -> ${after.contexts} after 12 navigations`);
  } catch (e) {
    throw new Error(`${e.message}\n${(() => { try { return readFileSync(join(h, "daemon.log"), "utf8").slice(-2000); } catch { return ""; } })()}`);
  } finally {
    owner?.sock.destroy();
    server.close();
    if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await Promise.race([new Promise((r) => daemon.once("exit", r)), sleep(10_000)]); }
    rmSync(h, { recursive: true, force: true });
  }
});
