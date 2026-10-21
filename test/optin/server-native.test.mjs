// Server mode, Phase A, on the native build (spec server-mode step 46): the PairBrowse browser for
// Linux runs headed on the helper's own virtual screen (display "xvfb", no DISPLAY) with its
// sandbox on: a page opens, the window fills the screen, no --headless or --no-sandbox on its
// command line, every renderer in a PID namespace of its own, no sandbox warning. Needs Linux with
// Xvfb and xauth, PAIRBROWSE_TEST_RUNTIME, PAIRBROWSE_TEST_ENGINE and PAIRBROWSE_TEST_EXECUTABLE (a
// native build for Linux); skipped otherwise. (In the A13 container, graphics-spike installs and
// launches the pinned Linux build the same way.)
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { session } from "../helpers/live.mjs";
import { sleep, text } from "../helpers/util.mjs";
import { SCREEN, browserPid, canRunXvfb, commandLine, logText, sandboxOf, screenRecord, serverHome, signalHelper, startServerHelper, startSite } from "../helpers/server.mjs";
import { nativeManifest } from "../../scripts/native-engine.mjs";
import { MEASURING_BUSY } from "../../scripts/daemon/browser/graphics.mjs";
import { GRAPHICS_STOP_MS, GRAPHICS_TIMEOUT_MS } from "../../scripts/native/check.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const engine = process.env.PAIRBROWSE_TEST_ENGINE;
const nativeExe = process.env.PAIRBROWSE_TEST_EXECUTABLE;
const native = (() => { try { return !!(runtime && engine && nativeExe && nativeManifest(nativeExe).version); } catch { return false; } })();
const SKIP = (!canRunXvfb() && "Linux with Xvfb and xauth only") || (!native && "set PAIRBROWSE_TEST_RUNTIME, PAIRBROWSE_TEST_ENGINE and PAIRBROWSE_TEST_EXECUTABLE (a native build for Linux)");

test("native build headed on Xvfb with its sandbox on", { skip: SKIP, timeout: 600_000 }, async () => {
  const site = await startSite();
  const home = serverHome(runtime, { prefix: "pbsn-", executablePath: nativeExe, config: { browserEngine: "pairbrowse" } });
  cpSync(engine, join(home, "engine"), { recursive: true });
  let helper = null, agent = null;
  try {
    helper = await startServerHelper(home);
    agent = await session(helper.socketPath, "a");
    // The first start per runtime measures graphics first (spec E4, step 44), refusing calls at
    // once while it runs; the agent retries, as the refusal tells it to.
    const deadline = Date.now() + GRAPHICS_TIMEOUT_MS + GRAPHICS_STOP_MS;
    let opened;
    while ((opened = text(await agent.tool("browser_navigate", { url: site.url("/size") }, 180_000))).includes(MEASURING_BUSY) && Date.now() < deadline) await sleep(3000);
    assert.ok(!opened.includes(MEASURING_BUSY), "the graphics measurement ended within its bound");
    assert.match(logText(home), /graphics: (software|hardware)|graphics not measured/, "the first start measured graphics (or said why not)");
    await agent.tool("browser_wait_for", { text: " end" });
    const m = /size: (\{.*?\}) end/s.exec(text(await agent.tool("browser_snapshot", {})));
    assert.ok(m, "the page showed its sizes");
    const size = JSON.parse(m[1].replace(/\\"/g, '"'));
    assert.deepEqual([size.sw, size.sh], [SCREEN.width, SCREEN.height], "the screen pages read is the virtual screen");
    const rec = screenRecord(home);
    assert.ok(rec, "on the helper's own Xvfb");
    const pid = browserPid(helper.daemon.pid);
    assert.ok(pid, "the browser runs");
    assert.doesNotMatch(commandLine(pid), /--headless/, "headed");
    assert.match(commandLine(pid), new RegExp(`--window-size=${SCREEN.width},${SCREEN.height}`), "the window fills the screen");
    const box = sandboxOf(pid);
    assert.equal(box.noSandboxSwitch, false, "no --no-sandbox");
    assert.ok(box.renderers > 0 && box.namespaced === box.renderers, `every renderer in its own namespaces: ${JSON.stringify(box)}`);
    if (process.arch === "x64") assert.equal(box.seccomp, box.renderers, "and under the seccomp filter");
    const status = text(await agent.tool("pairbrowse_status", { kind: "claude", text: "Checking" }));
    assert.match(status, new RegExp(`virtual screen ${rec.display} ${SCREEN.width}x${SCREEN.height}`));
    assert.doesNotMatch(status, /sandbox is off|sandbox stays on/i, "no sandbox warning");
  } catch (e) {
    throw new Error(`${e.message}\n--- daemon.log ---\n${logText(home).slice(-3000)}`, { cause: e });
  } finally {
    agent?.sock.destroy();
    if (helper && !(await signalHelper(helper.daemon, "SIGTERM"))) await signalHelper(helper.daemon, "SIGKILL");
    site.close();
    rmSync(home, { recursive: true, force: true });
  }
});
