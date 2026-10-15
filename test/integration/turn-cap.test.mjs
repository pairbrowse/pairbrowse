// One call can't hold the shared queue forever: past the cap (PAIRBROWSE_TEST_TURN_MAX_MS) the helper
// answers it, resets the browser and lets the next agent go on. Live: a real helper and browser
// (PAIRBROWSE_TEST_RUNTIME).
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { session, testBase } from "../helpers/live.mjs";
import { sleep, text } from "../helpers/util.mjs";
import { spawnDaemon, stopDaemon } from "../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;

test("a call that runs past the cap is answered, the browser resets, and the next agent goes on", { skip: !runtime, timeout: 240_000 }, async () => {
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  const base = testBase();
  mkdirSync(base, { recursive: true });
  const h = mkdtempSync(join(base, "cap-"));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new"], display: "none", screenshots: false }));
  const daemon = spawnDaemon(h, { env: { PAIRBROWSE_TEST_TURN_MAX_MS: "20000" } });
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
    await stopDaemon(daemon);
    rmSync(h, { recursive: true, force: true });
  }
});
