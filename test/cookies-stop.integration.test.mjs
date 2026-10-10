// A login (a persistent cookie) made just before the helper stops, or just before a session
// switch, is there in the next browser. Chromium writes its cookies every ~30 s and on a clean
// exit: the helper closes the browser cleanly on SIGTERM, SIGINT and a session switch, and only
// then exits (daemon.mjs shutdown, context.mjs close and switchTo). Live: a real helper and
// browser (PAIRBROWSE_TEST_RUNTIME).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, symlinkSync, writeFileSync, existsSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { session } from "./live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";
const cookieLine = (r) => text(r).match(/cookies: [^\n"]*/)?.[0] || "(no cookie line)";

// A site that sets a persistent cookie (a login) and shows what came back.
function startSite() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html", "set-cookie": ["login=kept; Path=/; Max-Age=86400"] });
    res.end(`<!doctype html><title>Cookie probe</title><h1>Cookie probe</h1><p>cookies: ${req.headers.cookie || "(none)"}</p>`);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "pb-cookies-"));
  symlinkSync(runtime, join(home, "runtime"), "dir");
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  writeFileSync(join(home, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new"], display: "none", screenshots: false, sessionPicker: false }));
  return home;
}

async function startDaemon(home) {
  const out = openSync(join(home, "daemon.stderr.log"), "a");
  const child = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: home }, stdio: ["ignore", out, out] });
  const socketPath = join(home, "run", "browser.sock");
  for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
  return { child, socketPath };
}

// Stops the helper with a signal; returns how long it took to exit.
async function stop(child, signal) {
  const started = Date.now();
  child.kill(signal);
  const exited = await Promise.race([new Promise((r) => child.once("exit", () => r(true))), sleep(15_000).then(() => false)]);
  assert.ok(exited, `the helper exited on ${signal}`);
  return Date.now() - started;
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`a cookie set just before the helper stops on ${signal} survives the restart`, { skip: !runtime && "set PAIRBROWSE_TEST_RUNTIME", timeout: 120_000 }, async () => {
    const site = await startSite();
    const home = makeHome();
    let daemon = await startDaemon(home);
    try {
      let agent = await session(daemon.socketPath, "a");
      assert.match(text(await agent.tool("pairbrowse_session", { action: "new", name: "shop" })), /Created and switched/);
      await agent.tool("browser_navigate", { url: `${site.base}/login` });
      assert.equal(cookieLine(await agent.tool("browser_navigate", { url: `${site.base}/login` })), "cookies: login=kept", "the site set the cookie");
      agent.sock.destroy();
      const took = await stop(daemon.child, signal); // at once: no time for Chromium's own ~30 s write
      assert.ok(took < 6000, `a clean close within the grace period (took ${took} ms)`);
      daemon = await startDaemon(home);
      agent = await session(daemon.socketPath, "b");
      assert.match(text(await agent.tool("pairbrowse_session", { action: "use", name: "shop" })), /Now using session "shop"/);
      assert.equal(cookieLine(await agent.tool("browser_navigate", { url: `${site.base}/login` })), "cookies: login=kept", "the cookie came back after the restart");
      agent.sock.destroy();
    } finally {
      if (daemon.child.exitCode === null) await stop(daemon.child, "SIGTERM").catch(() => {});
      site.close();
    }
  });
}

test("a cookie set just before a session switch is there when the session is used again", { skip: !runtime && "set PAIRBROWSE_TEST_RUNTIME", timeout: 120_000 }, async () => {
  const site = await startSite();
  const home = makeHome();
  const daemon = await startDaemon(home);
  try {
    const agent = await session(daemon.socketPath, "a");
    assert.match(text(await agent.tool("pairbrowse_session", { action: "new", name: "shop" })), /Created and switched/);
    await agent.tool("browser_navigate", { url: `${site.base}/login` });
    assert.equal(cookieLine(await agent.tool("browser_navigate", { url: `${site.base}/login` })), "cookies: login=kept");
    assert.match(text(await agent.tool("pairbrowse_session", { action: "new", name: "other" })), /Created and switched/);
    assert.equal(cookieLine(await agent.tool("browser_navigate", { url: `${site.base}/login` })), "cookies: (none)", "the new session has no logins");
    assert.match(text(await agent.tool("pairbrowse_session", { action: "use", name: "shop" })), /Now using session "shop"/);
    assert.equal(cookieLine(await agent.tool("browser_navigate", { url: `${site.base}/login` })), "cookies: login=kept", "the cookie survived the switch away and back");
    agent.sock.destroy();
  } finally {
    if (daemon.child.exitCode === null) await stop(daemon.child, "SIGTERM").catch(() => {});
    site.close();
  }
});
