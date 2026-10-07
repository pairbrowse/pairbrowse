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
  } catch (e) {
    throw new Error(`${e.message}\n${(() => { try { return readFileSync(join(h, "daemon.log"), "utf8").slice(-2000); } catch { return ""; } })()}`);
  } finally {
    for (const s of open) s.sock.destroy();
    if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await Promise.race([new Promise((r) => daemon.once("exit", r)), sleep(10_000)]); }
    rmSync(h, { recursive: true, force: true });
  }
});
