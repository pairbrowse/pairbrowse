// Patchright drives every other live test, as it does for users. "browserDriver": "playwright"
// stays an explicit opt-in: a real helper launches with it, clicks and reads a page, and says
// nothing of a fallback (that note is only for a Node.js too old for Patchright).
// Live: PAIRBROWSE_TEST_RUNTIME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
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

test("the Playwright opt-in still launches the browser and works", { skip: !runtime, timeout: 120_000 }, async () => {
  // Its own Chromium build, as a user who opts in would have it installed.
  const executablePath = createRequire(join(runtime, "package.json"))("playwright").chromium.executablePath();
  const server = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<title>Opt-in</title><button onclick="document.title='clicked'">Go</button>`); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = existsSync("/Volumes/BACKUP/PairBrowse") ? "/Volumes/BACKUP/PairBrowse" : tmpdir();
  mkdirSync(base, { recursive: true });
  const h = mkdtempSync(join(base, "pw-"));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new"], display: "none", screenshots: false, browserDriver: "playwright" }));
  const out = openSync(join(h, "daemon.stderr.log"), "a");
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: h }, stdio: ["ignore", out, out] });
  let s;
  try {
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
    s = await session(socketPath, "p");
    assert.match(text(await s.tool("pairbrowse_session", { action: "new", clean: true })), /clean/);
    const went = await s.tool("browser_navigate", { url: `http://127.0.0.1:${server.address().port}/` });
    assert.ok(!went.result?.isError, text(went));
    const ref = text(await s.tool("browser_snapshot")).match(/button "Go" \[ref=(e\d+)\]/)?.[1];
    assert.ok(ref, "the button is in the snapshot");
    assert.ok(!(await s.tool("browser_click", { target: ref, element: "Go" })).result?.isError);
    let title = "";
    for (let i = 0; i < 40 && title !== "clicked"; i++, await sleep(100)) title = text(await s.tool("browser_evaluate", { function: "() => document.title" })).match(/### Result\n"?([^"\n]*)/)?.[1];
    assert.equal(title, "clicked");
    assert.doesNotMatch(readFileSync(join(h, "daemon.log"), "utf8"), /instead of Patchright/, "an opt-in, not a fallback");
  } finally {
    s?.sock.destroy();
    server.close();
    if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await Promise.race([new Promise((r) => daemon.once("exit", r)), sleep(10_000)]); }
    rmSync(h, { recursive: true, force: true });
  }
});
