// Shared browser mode end to end, with two temporary homes on this computer (a host helper and a
// joiner's helper, each with its own real browser): the joiner joins with a shared browser code,
// sees the host's tab live over a direct (WebRTC) connection, and their clicks, keys and a drag
// on a canvas happen in the host's own page. The sharing tunnel is skipped
// (PAIRBROWSE_TEST_TUNNEL=direct). Needs PAIRBROWSE_TEST_RUNTIME.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync, existsSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shortBase = existsSync("/Volumes/BACKUP/PairBrowse") ? "/Volumes/BACKUP/PairBrowse" : tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The host's page: a button over the top half, a text field below it, a canvas at the bottom that
// draws where a pressed pointer moves (like a whiteboard).
const APP = `<title>App</title><body style="margin:0">
<button id="b" style="display:block;width:100vw;height:30vh" onclick="document.title='clicked'">Tap</button>
<input id="i" aria-label="Note" style="display:block;width:100vw;height:20vh;font-size:30px">
<canvas id="c" width="800" height="300" style="display:block;width:100vw;height:40vh;background:#fff"></canvas>
<input type="file" id="f" aria-label="Photo" style="display:block;width:100vw;height:9vh">
<script>
const c = document.getElementById("c"), g = c.getContext("2d"); let down = false;
const at = (e) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; };
c.addEventListener("pointerdown", (e) => { down = true; g.beginPath(); g.moveTo(...at(e)); });
c.addEventListener("pointermove", (e) => { if (!down) return; g.lineWidth = 8; g.lineTo(...at(e)); g.stroke(); window.drawn = (window.drawn || 0) + 1; });
addEventListener("pointerup", () => { down = false; });
</script>`;

function rpc(write, input) {
  const waiting = new Map();
  createInterface({ input }).on("line", (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  let seq = 0;
  return (method, params = {}, ms = 60_000) => new Promise((resolve, reject) => {
    const id = `t${++seq}`;
    const timer = setTimeout(() => reject(new Error(`timed out: ${method} ${params.name || ""}`)), ms);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";
const tool = (call, name, args = {}) => call("tools/call", { name, arguments: args });

function home(prefix) {
  mkdirSync(shortBase, { recursive: true });
  const dir = mkdtempSync(join(shortBase, prefix));
  symlinkSync(runtime, join(dir, "runtime"), "dir");
  return dir;
}

async function run({ noDirect = false } = {}) {
  const require = createRequire(join(runtime, "package.json"));
  const executablePath = require("playwright").chromium.executablePath();
  const fixture = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(APP); });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const port = fixture.address().port;
  const chromeArgs = ["--headless=new", `--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${port}`];
  const hostHome = home("sh-"), joinHome = home("sj-");
  writeFileSync(join(hostHome, "config.json"), JSON.stringify({ executablePath, chromeArgs, display: "none", screenshots: false, participantName: "Bob", browserDriver: "playwright" }));
  writeFileSync(join(joinHome, "config.json"), JSON.stringify({ executablePath, chromeArgs, display: "none", screenshots: false, participantName: "Alice", browserDriver: "playwright" }));
  const env = (h) => ({ ...process.env, PAIRBROWSE_HOME: h, PAIRBROWSE_TEST_TUNNEL: "direct", PAIRBROWSE_TEST_JOIN_LOCAL: "1", PAIRBROWSE_TEST_SCREEN: "1", ...(noDirect ? { PAIRBROWSE_TEST_NO_DIRECT: "1" } : {}) });
  const daemons = [];
  const connect = async (h) => {
    const out = openSync(join(h, "daemon.stderr.log"), "a");
    daemons.push(spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: env(h), stdio: ["ignore", out, out] }));
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 100 && !existsSync(socketPath); i++) await sleep(50);
    let sock;
    for (let i = 0; ; i++) {
      sock = net.createConnection(socketPath);
      const ok = await new Promise((r) => { sock.once("connect", () => r(true)); sock.once("error", () => r(false)); });
      if (ok) break;
      if (i > 50) throw new Error(`couldn't connect to ${socketPath}`);
      await sleep(200);
    }
    const call = rpc((l) => sock.write(l), sock);
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } });
    sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return { sock, call };
  };
  const tabs = async (call) => [...text(await tool(call, "browser_tabs", { action: "list" })).matchAll(/^- (\d+):( \(current\))? \[[^\n]*\]\(([^)\s]*)\)/gm)].map((m) => ({ index: Number(m[1]), url: m[3] }));
  const until = async (what, check, ms = 30_000) => {
    let last;
    for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if ((last = await check())) return last;
    throw new Error(`timed out: ${what}`);
  };
  const notes = []; // what the host's agent was told along the way
  const evaluate = async (call, fn) => {
    const r = text(await tool(call, "browser_evaluate", { function: fn }));
    notes.push(r);
    const m = r.match(/### Result\n([\s\S]*?)(\n###|$)/);
    try { return JSON.parse(m ? m[1].trim() : r); } catch { return m ? m[1].trim() : r; }
  };
  let host, joiner, stage = "start";
  try {
    host = await connect(hostHome);
    joiner = await connect(joinHome);
    stage = "host opens the app";
    assert.ok(!(await tool(host.call, "browser_navigate", { url: "http://one.pbtest.example/app" })).result.isError);

    stage = "a shared browser code (the default), joined and approved";
    const made = text(await tool(host.call, "pairbrowse_invite", { action: "create", role: "drive", label: "Alice", share: "code" }));
    assert.match(made, /Shared browser: they work in this browser itself/);
    const code = made.match(/Join code: (pb-join:[A-Za-z0-9_-]+)/)?.[1];
    assert.ok(code, made);
    assert.match(text(await tool(joiner.call, "pairbrowse_join", { action: "join", code })), /shared browser/);
    const id = await until("the request", async () => text(await tool(host.call, "pairbrowse_invite", { action: "list" })).match(/request (r[0-9a-f]{6}): Alice \(Claude Code\), waiting/)?.[1]);
    assert.match(text(await tool(host.call, "pairbrowse_invite", { action: "approve", id })), /Let Alice in/);

    stage = "the joiner's tab shows the host's tab, connected directly";
    // The picture page, as a person there sees it (a test-only tool: the joiner's agent itself now
    // works in the host's browser).
    const onScreen = async (args) => { const r = text(await tool(joiner.call, "pairbrowse_test_screen", args)); try { return JSON.parse(r); } catch { return null; } };
    const screen = await until("the picture page", async () => (await onScreen({}))?.index >= 0 && await onScreen({}));
    const live = text(await tool(joiner.call, "pairbrowse_liveview")).match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)[0];
    assert.ok((await fetch(`${live}tab`, { method: "POST", body: JSON.stringify({ i: screen.index }) })).ok); // in sight: it connects
    if (noDirect) {
      // No direct connection possible: pictures come through the join channel, and input goes back that way.
      await until("pictures on the slower route", async () => (await onScreen({ expr: "window.pbScreen && window.pbScreen.state()" }))?.value?.view === "frames", 60_000);
    } else {
      const state = await until("connected", async () => { const s = (await onScreen({ expr: "window.pbScreen && window.pbScreen.state()" }))?.value; return s?.conn === "connected" && s; }, 45_000);
      assert.equal(state.direct, true, "input goes over the direct connection");
    }
    const size = await until("the picture", async () => { const s = (await onScreen({ expr: noDirect ? "[document.getElementById('still').width, document.getElementById('still').height, innerWidth, innerHeight]" : "[document.getElementById('v').videoWidth, document.getElementById('v').videoHeight, innerWidth, innerHeight]" }))?.value; return Array.isArray(s) && s[0] > 0 && s; }, 20_000);

    // Where a point of the host's tab (fractions of it) is in the joiner's window.
    const [fw, fh, vw, vh] = size;
    const k = Math.min(vw / fw, vh / fh), ox = (vw - fw * k) / 2, oy = (vh - fh * k) / 2;
    const toJoiner = (nx, ny) => ({ x: Math.round(ox + nx * fw * k), y: Math.round(oy + ny * fh * k) });
    const input = (events) => fetch(`${live}input`, { method: "POST", body: JSON.stringify(events) });
    const click = (p) => input([{ type: "mouse", action: "mouseMoved", ...p }, { type: "mouse", action: "mousePressed", ...p, button: "left", buttons: 1, clickCount: 1 }, { type: "mouse", action: "mouseReleased", ...p, button: "left", buttons: 0, clickCount: 1 }]);

    stage = "a click on the picture clicks the host's button";
    await click(toJoiner(0.5, 0.15));
    await until("the host's page was clicked", async () => (await evaluate(host.call, "() => document.title")) === "clicked", 15_000);
    if (noDirect) return;

    stage = "keys typed on the picture go into the host's field";
    await tool(host.call, "pairbrowse_collaboration", { action: "release" }); // the host's agent lets the tab go (turns, as everywhere)
    await click(toJoiner(0.5, 0.4));
    await sleep(300);
    await onScreen({ type: "hi!" }); // real key presses on the picture page
    await until("the host's field has the text", async () => (await evaluate(host.call, "() => document.getElementById('i').value")) === "hi!", 15_000);

    stage = "a drag on the picture draws on the host's canvas";
    const a = toJoiner(0.2, 0.75), b = toJoiner(0.8, 0.8);
    const moves = [];
    for (let i = 1; i <= 10; i++) moves.push({ type: "mouse", action: "mouseMoved", x: Math.round(a.x + (b.x - a.x) * i / 10), y: Math.round(a.y + (b.y - a.y) * i / 10), button: "left", buttons: 1 });
    await input([{ type: "mouse", action: "mouseMoved", ...a }, { type: "mouse", action: "mousePressed", ...a, button: "left", buttons: 1, clickCount: 1 }, ...moves, { type: "mouse", action: "mouseReleased", ...b, button: "left", buttons: 0, clickCount: 1 }]);
    await until("drawn on the host's canvas", async () => Number(await evaluate(host.call, "() => window.drawn || 0")) >= 5, 15_000);

    stage = "a file field clicked on the picture asks the joiner for the file, on their computer";
    const doc = join(joinHome, "doc.png");
    writeFileSync(doc, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    await onScreen({ choose: [doc] }); // what the person picks in their file dialog
    await sleep(1000);
    await click(toJoiner(0.3, 0.945));
    await until("the picked file in the host's field", async () => (await evaluate(host.call, "() => document.getElementById('f').files[0] && document.getElementById('f').files[0].name")) === "doc.png", 20_000);

    stage = "the joiner's own agent works in the host's browser: reads, types, uploads a file from the joiner's computer";
    const snap = text(await tool(joiner.call, "browser_snapshot"));
    assert.match(snap, /button "Tap"/, "the host's page, not the picture");
    const note = snap.match(/textbox "Note"[^\n]*\[ref=(e\d+)\]/)?.[1];
    assert.ok(note, snap.slice(0, 600));
    await sleep(6000); // the field Alice typed in stays hers for a few seconds, even for her agent
    const typed = await tool(joiner.call, "browser_type", { target: note, element: "Note", text: " from Alice's agent" });
    assert.ok(!typed.result?.isError, text(typed));
    await until("the agent's text in the host's field", async () => /from Alice's agent/.test(String(await evaluate(host.call, "() => document.getElementById('i').value"))), 15_000);
    const pic = join(joinHome, "pic.png");
    writeFileSync(pic, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const up = await tool(joiner.call, "pairbrowse_upload", { files: [pic], target: "Photo" });
    assert.ok(!up.result?.isError, text(up));
    await until("the file in the host's page", async () => (await evaluate(host.call, "() => document.getElementById('f').files[0] && document.getElementById('f').files[0].name")) === "pic.png", 15_000);
    assert.match(text(await tool(joiner.call, "pairbrowse_upload", { files: ["/etc/hosts"], target: "Photo" })), /only images, video and documents|never uploaded/, "the joiner's own upload rules");
    assert.match(text(await tool(host.call, "pairbrowse_collaboration", { action: "status" })), /Alice · Claude Code/, "the host sees whose agent it is");

    stage = "the host sees who did it; leaving turns the picture into the tab itself";
    notes.push(text(await tool(host.call, "browser_snapshot")));
    assert.match(notes.join("\n"), /Alice used this tab meanwhile/);
    assert.match(text(await tool(joiner.call, "pairbrowse_join", { action: "leave" })), /Left Bob's session/);
    await until("the joiner's tab is the app", async () => (await tabs(joiner.call)).some((t) => t.url === "http://one.pbtest.example/app"), 15_000);
  } catch (e) {
    const log = (h) => { try { return readFileSync(join(h, "daemon.log"), "utf8").slice(-2500); } catch { return ""; } };
    throw new Error(`${stage}: ${e.message}\nhost:\n${log(hostHome)}\njoiner:\n${log(joinHome)}`);
  } finally {
    host?.sock.destroy();
    joiner?.sock.destroy();
    fixture.close();
    await Promise.all(daemons.map(async (d) => { if (d.exitCode === null) { d.kill("SIGTERM"); await Promise.race([new Promise((r) => d.once("exit", r)), sleep(10_000)]); } }));
    rmSync(hostHome, { recursive: true, force: true });
    rmSync(joinHome, { recursive: true, force: true });
  }
}

test("shared browser: the joiner sees the host's tab live (direct connection) and clicks, types, draws and uploads in it; their agent works there too", { skip: !runtime, timeout: 240_000 }, () => run());
test("shared browser without a direct connection: pictures and input through the join channel", { skip: !runtime, timeout: 240_000 }, () => run({ noDirect: true }));
