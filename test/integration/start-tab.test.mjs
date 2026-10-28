// The start tab's own late first load (a slow machine: the native build's new tab page loading after
// the launch counted as done) never cuts off an agent's first browser_navigate. START_TAB_LATE stands
// in for the slow machine: the start tab's own load (the engine's new tab page) comes that many ms
// after the launch. The first call waits for it (ready(), bounded); a call it still cuts off, past
// that bound (START_TAB_WAIT_MS), is sent once more and arrives. On the native build, a profile's
// first start installs the ad blocker a moment after the launch, which cut off the first page load
// on a slow machine with the start tab long loaded: the first call waits for that install too.
// Live: a real helper and browser (PAIRBROWSE_TEST_RUNTIME; the ad blocker: the native build,
// PAIRBROWSE_TEST_EXECUTABLE and PAIRBROWSE_TEST_ENGINE).
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { session } from "../helpers/live.mjs";
import { sleep, text } from "../helpers/util.mjs";
import { helperHome, nativeExe, spawnDaemon, stopDaemon } from "../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const LATE_LINE = "launch: the start tab's own load, late";

// A helper with env's switches, a page server whose first answer is held for holdMs after the
// start tab's late load began (or holdMs, if it never does; 0: not held), and one agent's first
// browser_navigate. arrivedAt: when each request came (ms).
async function firstNavigate(env, { holdMs }) {
  const h = helperHome(runtime, { prefix: "pb-start-", config: { sessionPicker: false } });
  const daemon = spawnDaemon(h, { env });
  const logText = () => { try { return readFileSync(join(h, "daemon.log"), "utf8"); } catch { return ""; } };
  const arrivals = []; // for each request: whether the start tab's late load had begun when it came
  const arrivedAt = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/favicon.ico") { res.statusCode = 404; return res.end(); }
    arrivedAt.push(Date.now());
    const lateBefore = logText().includes(LATE_LINE);
    arrivals.push(lateBefore);
    if (arrivals.length === 1 && holdMs) {
      for (let i = 0; i < 300 && !logText().includes(LATE_LINE); i++) await sleep(50);
      await sleep(holdMs);
    }
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><title>Arrived</title><h1>Arrived</h1>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let a;
  try {
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
    a = await session(socketPath, "a");
    const url = `http://127.0.0.1:${server.address().port}/arrive`;
    const nav = await a.tool("browser_navigate", { url }, 120_000);
    const tabs = text(await a.tool("browser_tabs", { action: "list" }));
    return { nav, tabs, url, log: logText(), arrivals, arrivedAt };
  } catch (e) {
    throw new Error(`${e.message}\n${logText().slice(-2500)}`);
  } finally {
    a?.sock.destroy();
    server.close();
    await stopDaemon(daemon);
    rmSync(h, { recursive: true, force: true });
  }
}

test("the first browser_navigate waits for the start tab's own late load, and arrives", { skip: !runtime || process.platform === "win32", timeout: 180_000 }, async () => {
  const { nav, tabs, url, log } = await firstNavigate({ PAIRBROWSE_TEST_START_TAB_LATE: "1500" }, { holdMs: 1500 });
  assert.ok(!nav.result?.isError, `arrived: ${text(nav).slice(0, 400)}`);
  assert.ok(tabs.includes(url), `the tab shows the address asked for:\n${tabs}`);
  const waited = Number(log.match(/launch: start tab loaded after (\d+) ms/)?.[1]);
  assert.ok(waited >= 1400, `the call waited for the start tab's load (${waited} ms)\n${log.slice(-1500)}`);
  assert.doesNotMatch(log, /browser_navigate cut off on the start tab/, "nothing was cut off");
});

test("a browser_navigate the start tab's late load still cuts off goes once more, and arrives", { skip: !runtime || process.platform === "win32", timeout: 180_000 }, async (t) => {
  // The wait gives up at 300 ms; the start tab's own load comes at 2.5 s, while the call's page is held.
  const { nav, tabs, url, log, arrivals } = await firstNavigate({ PAIRBROWSE_TEST_START_TAB_LATE: "2500", PAIRBROWSE_TEST_START_TAB_WAIT_MS: "300" }, { holdMs: 1500 });
  assert.ok(!nav.result?.isError, `arrived: ${text(nav).slice(0, 400)}\n${log.slice(-1500)}`);
  assert.ok(tabs.includes(url), `the tab shows the address asked for:\n${tabs}`);
  assert.match(log, /launch: start tab timeout after \d+ ms/, "the bounded wait gave up first");
  if (arrivals[0]) return t.diagnostic("the call went out after the start tab's late load began (a slow run): nothing to cut off");
  assert.match(log, /browser_navigate cut off on the start tab \(ERR_ABORTED\): sent again, arrived/, log.slice(-1500));
  assert.equal(arrivals.length, 2, "asked for twice: once cut off, once sent again");
});

test("on a profile's first start the first browser_navigate waits for the ad blocker's install, and arrives", { skip: !runtime || !nativeExe || process.platform === "win32", timeout: 180_000 }, async () => {
  const { nav, tabs, url, log, arrivedAt } = await firstNavigate({}, { holdMs: 0 });
  assert.ok(!nav.result?.isError, `arrived: ${text(nav).slice(0, 400)}`);
  assert.ok(tabs.includes(url), `the tab shows the address asked for:\n${tabs}`);
  // The launch found its start tab loaded at once; the call still waited for the install.
  const line = log.split("\n").find((l) => /launch: start tab loaded, ad blocker up after \d+ ms/.test(l));
  assert.ok(line, `the first call waited for the ad blocker:\n${log.slice(-1500)}`);
  const upAt = Date.parse(line.slice(0, 24));
  assert.ok(arrivedAt[0] >= upAt, `the page was asked for after the ad blocker came up (${arrivedAt[0] - upAt} ms)`);
  assert.doesNotMatch(log, /browser_navigate cut off on the start tab/, "nothing was cut off");
});
