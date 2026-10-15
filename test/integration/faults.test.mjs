// A helper started on a home whose state files are corrupt and whose config.json has an unknown
// key and a wrong-typed value: it starts, answers calls, keeps every corrupt file aside (named in
// daemon.log), and pairbrowse_status names the config warnings. The kill cases are elsewhere: the
// browser killed mid-call in interruption.test.mjs, the helper killed mid-call under a bridge in
// connections.test.mjs. The faults without a browser: test/faults.test.mjs.
// Live: a real helper and browser (PAIRBROWSE_TEST_RUNTIME).
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { session } from "../helpers/live.mjs";
import { sleep, text } from "../helpers/util.mjs";
import { helperHome, spawnDaemon, stopDaemon } from "../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const BAD = '{"cut short": [1, 2';

test("a helper on corrupt state files and a config with mistakes: it starts, answers, keeps the files aside and says so", { skip: !runtime || process.platform === "win32", timeout: 180_000 }, async () => {
  const h = helperHome(runtime, { prefix: "pb-faults-", config: { sessionPicker: false, maxTabs: "20", maxTab: 5 } });
  // The default session's own files and the sharing state, each cut short.
  const corrupt = ["tabs.json", "people.json", "activity.json", "sharing.json", "recordings.json"].map((f) => join(h, f));
  mkdirSync(join(h, "runs"), { recursive: true });
  corrupt.push(join(h, "runs", ".current.json"));
  for (const f of corrupt) writeFileSync(f, BAD);
  const daemon = spawnDaemon(h);
  const server = createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(`<!doctype html><title>Faults</title><h1>${req.url}</h1>`); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const open = [];
  const logText = () => { try { return readFileSync(join(h, "daemon.log"), "utf8"); } catch { return ""; } };
  try {
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
    const a = await session(socketPath, "a");
    open.push(a);
    const nav = await a.tool("browser_navigate", { url: `http://127.0.0.1:${server.address().port}/one` }, 120_000);
    assert.ok(!nav.result?.isError, `the call is answered: ${text(nav).slice(0, 300)}`);
    const status = text(await a.tool("pairbrowse_status", { kind: "claude", text: "Checking" }));
    assert.match(status, /warning: config\.json: maxTabs is a whole number of 1 or more, not "20" \(a string\); using the default/);
    assert.match(status, /warning: config\.json: unknown key "maxTab"/);
    await sleep(2500); // the tabs and activity writers' debounce
    assert.equal(daemon.exitCode, null, "the helper is up");
    const log = logText();
    assert.match(log, /config\.json: maxTabs is a whole number/, "the refused value is in the log");
    assert.match(log, /unknown key "maxTab"/);
    for (const f of corrupt) {
      if (!existsSync(`${f}.corrupt`)) continue; // a file this start never read (its feature unused)
      assert.equal(readFileSync(`${f}.corrupt`, "utf8"), BAD, `${f}: what it held is kept`);
      assert.ok(log.includes(`${f} wasn't valid JSON: what it held is kept in ${f}.corrupt`), `${f}: the log says where`);
    }
    for (const f of ["tabs.json", "sharing.json", "activity.json"].map((n) => join(h, n))) assert.ok(existsSync(`${f}.corrupt`), `${f} was read at start and kept aside`);
    assert.match(readFileSync(join(h, "config.json"), "utf8"), /"maxTabs":"20"/, "config.json is never rewritten for it");
  } catch (e) {
    throw new Error(`${e.message}\n${logText().slice(-2500)}`);
  } finally {
    for (const s of open) s.sock.destroy();
    server.close();
    await stopDaemon(daemon);
    rmSync(h, { recursive: true, force: true });
  }
});
