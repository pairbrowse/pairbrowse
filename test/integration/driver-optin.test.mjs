// Patchright drives every other live test, as it does for users. "browserDriver": "playwright"
// stays an explicit opt-in: a real helper launches with it, clicks and reads a page, and says
// nothing of a fallback (that note is only for a Node.js too old for Patchright).
// Live: PAIRBROWSE_TEST_RUNTIME.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { session, testBase } from "../helpers/live.mjs";
import { sleep, text } from "../helpers/util.mjs";
import { spawnDaemon, stopDaemon } from "../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;

test("the Playwright opt-in still launches the browser and works", { skip: !runtime, timeout: 120_000 }, async () => {
  // Its own build of the engine, as a user who opts in would have it installed.
  const executablePath = createRequire(join(runtime, "package.json"))("playwright").chromium.executablePath();
  const server = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<title>Opt-in</title><button onclick="document.title='clicked'">Go</button>`); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = testBase();
  mkdirSync(base, { recursive: true });
  const h = mkdtempSync(join(base, "pw-"));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, browserArgs: ["--headless=new"], display: "none", screenshots: false, browserDriver: "playwright" }));
  const daemon = spawnDaemon(h);
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
    for (let i = 0; i < 40 && title !== "clicked"; i++, await sleep(100)) title = text(await s.tool("browser_snapshot")).match(/^- Page Title: (.*)$/m)?.[1]?.replace(/^.* · /, "");
    assert.equal(title, "clicked");
    assert.doesNotMatch(readFileSync(join(h, "daemon.log"), "utf8"), /instead of Patchright/, "an opt-in, not a fallback");
  } finally {
    s?.sock.destroy();
    server.close();
    await stopDaemon(daemon);
    rmSync(h, { recursive: true, force: true });
  }
});
