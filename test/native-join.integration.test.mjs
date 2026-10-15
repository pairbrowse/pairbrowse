// Joining with the PairBrowse build that has its own pages (no side panel extension; its own
// capture page, 550): a native host shares the tab live from its capture page (picture and sound,
// straight to the joiner), a native joiner shows it in its chrome://pairbrowse/screen/ tab, and
// recording on the native side records and saves a file. Three cases: native host with a Chromium
// (extension) joiner, the other way round, and native on both sides.
// Needs PAIRBROWSE_TEST_RUNTIME, PAIRBROWSE_TEST_ENGINE and PAIRBROWSE_TEST_EXECUTABLE naming a
// build whose manifest declares its own pages; skipped otherwise. Headed: real windows open and
// close on this screen.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync, openSync, readFileSync, cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { testBase, attachDaemon } from "./live.mjs";
import { chromePages, nativeManifest } from "../scripts/native-engine.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const engine = process.env.PAIRBROWSE_TEST_ENGINE;
const nativeExe = process.env.PAIRBROWSE_TEST_EXECUTABLE;
const native = (() => { try { return !!(runtime && engine && nativeExe && chromePages(nativeManifest(nativeExe))); } catch { return false; } })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NO_RECORD = /Recording isn't available in this PairBrowse browser yet/;
const APP = "<!doctype html><title>app</title><button id=tap style='position:fixed;left:0;top:0;width:100vw;height:40vh;font-size:40px' onclick=\"document.title='clicked'\">Tap</button>";

function rpc(sock) {
  const waiting = new Map();
  createInterface({ input: sock }).on("line", (line) => { let m; try { m = JSON.parse(line); } catch { return; } if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
  let seq = 0;
  return (method, params = {}, ms = 120_000) => new Promise((resolve, reject) => {
    const id = `n${++seq}`;
    const timer = setTimeout(() => reject(new Error(`timed out: ${method} ${params.name || ""}`)), ms);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";
const until = async (what, check, ms = 30_000) => {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if ((last = await check())) return last;
  throw new Error(`timed out: ${what} (${JSON.stringify(last)})`);
};

async function run({ nativeHost, nativeJoiner }) {
  const cft = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  const site = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(APP); });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const rules = `--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${site.address().port}`;
  const base = testBase();
  mkdirSync(base, { recursive: true });
  const homes = [], daemons = [], socks = [];
  const home = (prefix, who, isNative) => {
    const h = mkdtempSync(join(base, prefix));
    homes.push(h);
    symlinkSync(runtime, join(h, "runtime"), "dir");
    if (isNative) {
      cpSync(engine, join(h, "engine"), { recursive: true });
      const profile = join(homedir(), ".pairbrowse", "mac-host-profile.json");
      if (existsSync(profile)) cpSync(profile, join(h, "mac-host-profile.json"));
    }
    mkdirSync(join(h, "dl"));
    writeFileSync(join(h, "config.json"), JSON.stringify({ browserEngine: isNative ? "pairbrowse" : "chromium", executablePath: isNative ? nativeExe : cft, participantName: who, downloadsDir: join(h, "dl"), sessionPicker: false, screenshots: false, chromeArgs: [rules] }));
    return h;
  };
  const connect = async (h) => {
    const out = openSync(join(h, "daemon.stderr.log"), "a");
    const d = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: h, PAIRBROWSE_TEST_TUNNEL: "direct", PAIRBROWSE_TEST_JOIN_LOCAL: "1", PAIRBROWSE_TEST_SCREEN: "1" }, stdio: ["ignore", out, out] });
    daemons.push(d);
    const sock = await attachDaemon({ socketPath: join(h, "run", "browser.sock"), daemon: d, home: h, ms: 90_000 });
    socks.push(sock);
    const call = rpc(sock);
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } });
    sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return (name, args = {}, ms) => call("tools/call", { name, arguments: args }, ms).then(text);
  };
  const hostHome = home("nh-", "Bob", nativeHost), joinHome = home("nj-", "Alice", nativeJoiner);
  const nativeHome = nativeHost ? hostHome : joinHome;
  let stage = "start";
  try {
    const host = await connect(hostHome), joiner = await connect(joinHome);
    const nativeTool = nativeHost ? host : joiner;
    stage = "the host opens the app";
    assert.match(await host("browser_navigate", { url: "http://one.pbtest.example/app" }, 300_000), /app/);
    await joiner("browser_navigate", { url: "about:blank" }, 300_000).catch(() => "");

    stage = "recording on the native side records (its capture page) and saves a file";
    const started = await nativeTool("pairbrowse_record", { action: "start" });
    assert.doesNotMatch(started, NO_RECORD);
    assert.match(started, /Recording the browser \(\d+x\d+\)/, started);
    await sleep(1500);
    const saved = await nativeTool("pairbrowse_record", { action: "stop" }, 90_000);
    assert.match(saved, /Saved the recording \(\d+ s, [\d.]+ MB\) to /, saved);
    const files = readdirSync(join(nativeHome, "dl"));
    assert.equal(files.length, 1, files.join(", "));
    assert.ok(statSync(join(nativeHome, "dl", files[0])).size > 0, "a recording with something in it");

    stage = "invite (drive, code), join, approve";
    const made = await host("pairbrowse_invite", { action: "create", role: "drive", label: "Alice", share: "code" });
    // A native host's capture page sends the tab live, with its sound.
    if (nativeHost) assert.match(made, /picture and sound, sent straight to their PairBrowse/, made);
    assert.doesNotMatch(made, /no sound from this PairBrowse build yet/);
    const code = made.match(/Join code: (pb-join:[A-Za-z0-9_-]+)/)?.[1];
    assert.ok(code, made);
    assert.match(await joiner("pairbrowse_join", { action: "join", code, name: "Alice" }, 120_000), /shared browser/);
    const id = await until("the request", async () => (await host("pairbrowse_invite", { action: "list" })).match(/request (r[0-9a-f]{6}): Alice/)?.[1]);
    assert.match(await host("pairbrowse_invite", { action: "approve", id }), /Let Alice in/);
    await until("in", async () => /[1-9] shared tab/.test(await joiner("pairbrowse_join", { action: "status" })), 60_000);

    stage = "the joiner's picture page";
    const onScreen = async (args) => { const r = await joiner("pairbrowse_test_screen", args); try { return JSON.parse(r); } catch { return null; } };
    const screen = await until("the picture page", async () => { const s = await onScreen({}); return s?.index >= 0 && s; }, 60_000);
    const own = (await onScreen({ url: true }))?.url || "";
    if (nativeJoiner) assert.match(own, /^(chrome:\/\/pairbrowse\/screen\/|pairbrowse:\/\/screen)/, own);
    else assert.match(own, /^chrome-extension:\/\/[a-p]{32}\/screen\.html#/, own);
    const live = (await joiner("pairbrowse_liveview")).match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)?.[0];
    if (live) await fetch(`${live}tab`, { method: "POST", body: JSON.stringify({ i: screen.index }) }).catch(() => {});

    stage = "the host's tab live in the picture page";
    let lastState = null;
    const shown = await until("connected, or pictures through the channel", async () => {
      const s = (await onScreen({ expr: "(() => { const st = window.pbScreen && window.pbScreen.state(); const c = document.getElementById('still'), v = document.getElementById('v'); return st && { ...st, size: st.view === 'frames' ? [c.width, c.height] : [v.videoWidth, v.videoHeight], win: [innerWidth, innerHeight] }; })()" }))?.value;
      lastState = s;
      return s && ((s.conn === "connected" && s.size[0] > 0) || (s.view === "frames" && s.size[0] > 0)) && s;
    }, 20_000).catch((e) => { throw new Error(`${e.message}; last state ${JSON.stringify(lastState)}; joiner log: ${readFileSync(join(joinHome, "daemon.log"), "utf8").split("\n").filter((l) => /shared|screen|picture/i.test(l)).slice(-8).join(" | ")}`); });
    if (nativeHost) assert.equal(shown.conn, "connected", `a native host's capture page connects straight to the joiner (${JSON.stringify(shown)})`);
    // An extension host and a native joiner's picture tab that can't connect directly (it reports
    // no helper word, or runs as the extension's page): the helper takes the slower route at once,
    // so the picture comes within the same 20 s.

    stage = "a click through the picture clicks the host's button";
    const [fw, fh] = shown.size, [vw, vh] = shown.win;
    const k = Math.min(vw / fw, vh / fh), ox = (vw - fw * k) / 2, oy = (vh - fh * k) / 2;
    assert.equal(await joiner("pairbrowse_test_screen", { clickAt: { x: Math.round(ox + 0.5 * fw * k), y: Math.round(oy + 0.2 * fh * k) } }), "clicked");
    await until("the host's page clicked", async () => /clicked/.test(await host("browser_evaluate", { function: "() => document.title" })), 15_000);

    stage = "the native side's log";
    const log = readFileSync(join(nativeHome, "daemon.log"), "utf8");
    assert.doesNotMatch(log, /no side panel/);
    if (nativeHost) assert.doesNotMatch(log, /liveview guest/);
  } catch (e) {
    e.message = `${stage}: ${e.message}`;
    throw e;
  } finally {
    for (const s of socks) s.destroy();
    await Promise.all(daemons.map(async (d) => { if (d.exitCode === null) { d.kill("SIGTERM"); await Promise.race([new Promise((r) => d.once("exit", r)), sleep(15_000)]); } }));
    site.close();
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  }
}

test("native host, Chromium (extension) joiner: the tab live from the capture page, a click goes through", { skip: !native, timeout: 600_000 }, () => run({ nativeHost: true, nativeJoiner: false }));
test("Chromium (extension) host, native joiner: the picture in chrome://pairbrowse/screen/, a click goes through", { skip: !native, timeout: 600_000 }, () => run({ nativeHost: false, nativeJoiner: true }));
test("native host, native joiner", { skip: !native, timeout: 600_000 }, () => run({ nativeHost: true, nativeJoiner: true }));
