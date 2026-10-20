// A browser profile's settings as pages read them on the native build (spec server-mode Phase D,
// "Applied values"; D3): a profile's time zone, languages, screen and pixel ratio are what a page
// reads; a pinned seed gives the same device values in two fresh sessions; and the same pinned seed
// is refused in a second instance while the first has it open (the identity lock, before any browser
// starts there). Needs PAIRBROWSE_TEST_RUNTIME, PAIRBROWSE_TEST_ENGINE and PAIRBROWSE_TEST_EXECUTABLE
// (a native build); skipped otherwise. Headed: a real window opens and closes on this screen, one at
// a time, under an account folder of the test's own ($HOME pointed at it).
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, existsSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { session, testBase, attachDaemon } from "../helpers/live.mjs";
import { text } from "../helpers/util.mjs";
import { root, stopDaemon } from "../helpers/daemon.mjs";
import { profilesCli } from "../helpers/profiles-live.mjs";
import { nativeManifest } from "../../scripts/native-engine.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const engine = process.env.PAIRBROWSE_TEST_ENGINE;
const nativeExe = process.env.PAIRBROWSE_TEST_EXECUTABLE;
const native = (() => { try { return !!(runtime && engine && nativeExe && nativeManifest(nativeExe).version); } catch { return false; } })();
const SKIP = !native && "set PAIRBROWSE_TEST_RUNTIME, PAIRBROWSE_TEST_ENGINE and PAIRBROWSE_TEST_EXECUTABLE (a native build)";

const SEED = "pb-optin-desk-7";
const PINNED = {
  browser: { kind: "pairbrowse" },
  locale: { languages: ["de-DE", "de"], timezone: "Pacific/Auckland", source: "set" },
  screen: { width: 1600, height: 1000, availWidth: 1600, availHeight: 960, colorDepth: 24, devicePixelRatio: 2 },
  persona: { source: "seed", seed: SEED },
};

// A page that shows what it reads: "values: {json} end".
const PAGE = `<!doctype html><title>values</title><p id=v>values: waiting</p><script>
const gl = (() => { try { const c = document.createElement("canvas").getContext("webgl"); const e = c.getExtension("WEBGL_debug_renderer_info"); return c.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : c.RENDERER); } catch { return null; } })();
document.getElementById("v").textContent = "values: " + JSON.stringify({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, langs: navigator.languages, w: screen.width, h: screen.height, dpr: devicePixelRatio,
  cores: navigator.hardwareConcurrency, mem: navigator.deviceMemory ?? null, gl, platform: navigator.platform }) + " end";
</script>`;
const read = async (agent, url) => {
  const went = text(await agent.tool("browser_navigate", { url }, 120_000));
  await agent.tool("browser_wait_for", { text: " end" });
  const shown = text(await agent.tool("browser_snapshot", {}));
  const m = /values: (\{.*?\}) end/s.exec(shown);
  assert.ok(m, `the page showed its values:\n${went.slice(0, 1500)}\n${shown.slice(0, 1500)}`);
  return JSON.parse(m[1].replace(/\\"/g, '"'));
};

test("a profile's time zone, languages, screen and DPR are what pages read; a pinned seed reproduces the same values in two fresh sessions and is refused in a second instance", { skip: SKIP, timeout: 300_000 }, async () => {
  const site = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const base = testBase();
  mkdirSync(base, { recursive: true });
  const account = mkdtempSync(join(base, "pbn-"));
  const shared = join(account, ".pairbrowse");
  mkdirSync(join(account, "Downloads"), { recursive: true });
  mkdirSync(shared, { recursive: true });
  symlinkSync(runtime, join(shared, "runtime"), "dir");
  cpSync(engine, join(shared, "engine"), { recursive: true });
  const hostProfile = join(homedir(), ".pairbrowse", "mac-host-profile.json");
  if (existsSync(hostProfile)) cpSync(hostProfile, join(shared, "mac-host-profile.json"));
  const envOf = (name) => { const env = { ...process.env, HOME: account, PAIRBROWSE_INSTANCE: name }; delete env.PAIRBROWSE_HOME; return env; };
  const homeOf = (name) => join(shared, "instances", name);
  for (const name of ["na", "nb"]) {
    mkdirSync(homeOf(name), { recursive: true });
    writeFileSync(join(homeOf(name), "config.json"), JSON.stringify({ browserEngine: "pairbrowse", executablePath: nativeExe, downloadsDir: join(account, "Downloads"), sessionPicker: false, screenshots: false }));
  }
  const running = [];
  const start = async (name) => {
    const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: account, env: envOf(name), stdio: "ignore" });
    running.push(daemon);
    const sock = await attachDaemon({ socketPath: join(homeOf(name), "run", "browser.sock"), daemon, home: homeOf(name), ms: 90_000 });
    sock.destroy();
    return daemon;
  };
  try {
    for (const name of ["na", "nb"]) assert.equal(profilesCli(null, ["create", "desk", "--settings", JSON.stringify(PINNED)], envOf(name)).code, 0);

    const a = await start("na");
    const agent = await session(join(homeOf("na"), "run", "browser.sock"), "a");
    assert.match(text(await agent.tool("pairbrowse_session", { action: "new", name: "one", profile: "desk" }, 120_000)), /on browser profile "desk"/);
    const one = await read(agent, url);
    assert.equal(one.tz, "Pacific/Auckland");
    assert.deepEqual(one.langs, ["de-DE", "de"]);
    assert.deepEqual([one.w, one.h, one.dpr], [1600, 1000, 2]);

    // The second instance: the same pinned seed, refused while instance na has it open.
    const b = await start("nb");
    const other = await session(join(homeOf("nb"), "run", "browser.sock"), "b");
    const refused = text(await other.tool("pairbrowse_session", { action: "new", name: "two", profile: "desk" }, 120_000)) + text(await other.tool("browser_navigate", { url }, 60_000));
    assert.match(refused, /pins its seed, so it runs in one browser at a time, and session "one" of PairBrowse instance "na" \(process \d+\) has it open now/);
    other.sock.destroy();
    await stopDaemon(b);

    // A second fresh session on it in instance na: the same device values.
    assert.match(text(await agent.tool("pairbrowse_session", { action: "new", name: "two", profile: "desk" }, 120_000)), /on browser profile "desk"/);
    await agent.tool("browser_tabs", { action: "new" }); // the switch closed the agent's tab with session one's browser
    const two = await read(agent, url);
    assert.deepEqual(two, one, "the pinned seed gives the same values in a fresh session");
    agent.sock.destroy();
    await stopDaemon(a);
  } finally {
    for (const d of running) await stopDaemon(d);
    site.close();
    rmSync(account, { recursive: true, force: true });
  }
});
