// A plugin update handed over (scripts/handoff.mjs), live: a real helper with an agent connected
// stays on its version when a newer bridge says hello, and pairbrowse_status says a newer one
// waits; once nobody uses it, the newer bridge (connectLocal) has it stop cleanly (its tabs saved,
// its lock and socket gone), starts the helper from its own copy, and the saved tabs come back.
// Live: a real helper and browser (PAIRBROWSE_TEST_RUNTIME).
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { session } from "../helpers/live.mjs";
import { sleep, text, until } from "../helpers/util.mjs";
import { helperHome, spawnDaemon } from "../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
// The home is chosen before the project's modules load (paths.mjs reads PAIRBROWSE_HOME then).
const home = runtime ? helperHome(runtime, { prefix: "pb-ho-", config: { sessionPicker: false } }) : null;
if (home) process.env.PAIRBROWSE_HOME = home;
const { askVersion, pendingLine } = await import("../../scripts/handoff.mjs");
const { connectLocal } = await import("../../scripts/launcher/daemon-connect.mjs");
const { paths } = await import("../../scripts/paths.mjs");
const { pidAlive } = await import("../../scripts/util.mjs");
const { tabsFile } = await import("../../scripts/sessions.mjs");

function startSite() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Handoff ${req.url.slice(1)}</title><h1>Page ${req.url}</h1>`);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}
const hello = (version) => new Promise((resolve, reject) => {
  const s = net.connect(paths.socket, () => resolve(askVersion(s, version, 3000)));
  s.once("error", reject);
});
const lockPid = () => { try { return Number(readFileSync(paths.daemonLock, "utf8")) || 0; } catch { return 0; } };

test("a newer bridge waits while an agent is connected, then hands over once nobody uses the helper; the tabs come back", { skip: !runtime && "set PAIRBROWSE_TEST_RUNTIME", timeout: 180_000 }, async () => {
  const site = await startSite();
  const first = spawnDaemon(home);
  let second = 0;
  try {
    await until("the first helper listens", () => existsSync(paths.socket), 60_000, 50);
    const agent = await session(paths.socket, "a");
    await agent.tool("browser_navigate", { url: `${site.base}/one` });
    await agent.tool("browser_navigate", { url: `${site.base}/two` });

    // Equal version: nothing. Newer while the agent is there: stays, says why.
    assert.deepEqual(await hello(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version), { restart: false, why: "same version" });
    assert.deepEqual(await hello("99.0.0"), { restart: false, why: "an agent is connected" });
    const status = text(await agent.tool("pairbrowse_status", { kind: "claude", text: "Checking" }));
    assert.ok(status.includes(pendingLine("99.0.0")), status);
    assert.equal(first.exitCode, null, "still running");

    // Nobody left: the newer bridge's connectLocal stops it and starts its own copy.
    agent.sock.destroy();
    await sleep(800);
    const said = [];
    const sock = await connectLocal((m) => said.push(m), { version: "99.0.0", agent: null, handoff: true });
    sock.destroy();
    await until("the first helper exited", () => first.exitCode !== null || first.signalCode !== null, 10_000, 50);
    assert.equal(first.exitCode, 0, "a clean shutdown");
    assert.ok(said.some((m) => /99\.0\.0 is installed; the helper restarts on it/.test(m)), said.join(" | "));
    second = lockPid();
    assert.ok(second && second !== first.pid && pidAlive(second), "a new helper holds the lock");

    const log = readFileSync(paths.daemonLog, "utf8");
    assert.match(log, /version: a bridge has PairBrowse 99\.0\.0 \(this helper [\d.]+\), but an agent is connected: staying on/);
    assert.match(log, /version: a bridge has PairBrowse 99\.0\.0 \(this helper [\d.]+\) and nobody is using the browser: stopping/);
    assert.match(log, /shutdown: browser closed cleanly/);
    const saved = JSON.parse(readFileSync(tabsFile("default"), "utf8"));
    assert.ok(saved.tabs.some((t) => t.url === `${site.base}/two`), `the tab was saved at the stop: ${JSON.stringify(saved)}`);

    // The new helper brings the tab back.
    const again = await session(paths.socket, "b");
    const tabs = await until("the saved tab is open again", async () => {
      const t = text(await again.tool("browser_tabs", { action: "list" }));
      return t.includes(`${site.base}/two`) ? t : null;
    }, 60_000, 1000);
    assert.ok(tabs.includes(`${site.base}/two`));
    again.sock.destroy();
  } finally {
    if (first.exitCode === null) first.kill("SIGTERM");
    if (second && pidAlive(second)) {
      process.kill(second, "SIGTERM");
      await until("the second helper exited", () => !pidAlive(second), 15_000, 100).catch(() => {});
    }
    site.close();
    rmSync(home, { recursive: true, force: true });
  }
});
