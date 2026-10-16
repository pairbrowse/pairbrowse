// Hidden, blocked and unknown browser tools are refused by the helper itself, not only by the
// hook: Claude Code in bypass-permissions mode (which lets every "ask" through) still never runs a
// page script or takes an unchecked screenshot. Live: a real helper and browser
// (PAIRBROWSE_TEST_RUNTIME).
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { session, testBase } from "../helpers/live.mjs";
import { sleep, text } from "../helpers/util.mjs";
import { spawnDaemon, stopDaemon } from "../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;

test("browser_evaluate, the other hidden tools and unknown browser tools are refused by the helper", { skip: !runtime, timeout: 180_000 }, async () => {
  let hits = 0;
  const site = createServer((req, res) => {
    if (req.url.startsWith("/leak")) hits++;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>Form</title><input type=password value=hunter2>");
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const base = testBase();
  mkdirSync(base, { recursive: true });
  const h = mkdtempSync(join(base, "hid-"));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, browserArgs: ["--headless=new"], display: "none", screenshots: false, sessionPicker: false }));
  const daemon = spawnDaemon(h);
  let a;
  try {
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
    a = await session(socketPath, "h");
    const url = `http://127.0.0.1:${site.address().port}/`;
    await a.tool("browser_navigate", { url });
    const leak = `() => { fetch(${JSON.stringify(url)} + "leak?p=" + document.querySelector("input").value); return document.title; }`;
    const r = await a.tool("browser_evaluate", { function: leak });
    assert.match(text(r), /browser_evaluate isn't available in PairBrowse/);
    assert.equal(r.result?.isError, true);
    for (const t of ["browser_take_screenshot", "browser_network_requests", "browser_console_messages", "browser_close", "browser_storage_state", "browser_cookie_list"]) {
      const x = await a.tool(t, {});
      assert.match(text(x), /isn't available in PairBrowse/, t);
    }
    await sleep(500);
    assert.equal(hits, 0, "the page script never ran");
    // The browser still works after all of that.
    assert.match(text(await a.tool("browser_snapshot", {})), /Form/);
  } finally {
    a?.sock.destroy();
    await stopDaemon(daemon);
    site.close();
    rmSync(h, { recursive: true, force: true });
  }
});
