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
import { personColor } from "../scripts/tabsync.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shortBase = existsSync("/Volumes/BACKUP/PairBrowse") ? "/Volumes/BACKUP/PairBrowse" : tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The host's page (its button also starts a tone too quiet to hear, so sound has something to carry): a button over the top half, a text field below it, a canvas at the bottom that
// draws where a pressed pointer moves (like a whiteboard).
const APP = `<title>App</title><body style="margin:0">
<button id="b" style="display:block;width:100vw;height:30vh" onclick="document.title='clicked'; const a = new AudioContext(); const o = a.createOscillator(), v = a.createGain(); v.gain.value = 0.0005; o.connect(v).connect(a.destination); o.start();">Tap</button>
<input id="i" aria-label="Note" style="display:block;width:100vw;height:20vh;font-size:30px">
<canvas id="c" width="800" height="300" style="display:block;width:100vw;height:40vh;background:#fff"></canvas>
<input type="file" id="f" aria-label="Photo" style="display:block;width:100vw;height:9vh">
<div style="height:150vh">more below</div>
<script>
const c = document.getElementById("c"), g = c.getContext("2d"); let down = false;
const at = (e) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; };
c.addEventListener("pointerdown", (e) => { down = true; g.beginPath(); g.moveTo(...at(e)); });
c.addEventListener("pointermove", (e) => { if (!down) return; g.lineWidth = 8; g.lineTo(...at(e)); g.stroke(); c.dataset.drawn = (Number(c.dataset.drawn) || 0) + 1; });
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

async function run({ noDirect = false, realTunnel = false, youtube = false, excalidraw = false, joinerApp = "claude-code" } = {}) {
  const require = createRequire(join(runtime, "package.json"));
  // PAIRBROWSE_TEST_EXECUTABLE: another Chromium build to run both sides on (the PairBrowse browser, say).
  const executablePath = process.env.PAIRBROWSE_TEST_EXECUTABLE || require("patchright").chromium.executablePath();
  const fixture = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(APP); });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const port = fixture.address().port;
  const chromeArgs = ["--headless=new", `--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${port}`];
  const hostHome = home("sh-"), joinHome = home("sj-");
  writeFileSync(join(hostHome, "config.json"), JSON.stringify({ executablePath, chromeArgs, display: "none", screenshots: false, participantName: "Bob" }));
  writeFileSync(join(joinHome, "config.json"), JSON.stringify({ executablePath, chromeArgs, display: "none", screenshots: false, participantName: "Alice" }));
  const env = (h) => ({ ...process.env, PAIRBROWSE_HOME: h, PAIRBROWSE_TEST_SCREEN: "1", ...(realTunnel ? {} : { PAIRBROWSE_TEST_TUNNEL: "direct", PAIRBROWSE_TEST_JOIN_LOCAL: "1" }), ...(noDirect ? { PAIRBROWSE_TEST_NO_DIRECT: "1" } : {}) });
  const daemons = [];
  const connect = async (h, app = "claude-code") => {
    const out = openSync(join(h, "daemon.stderr.log"), "a");
    daemons.push(spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: env(h), stdio: ["ignore", out, out] }));
    return attach(h, app);
  };
  // One more agent on a running helper: a participant of its own.
  const attach = async (h, app = "claude-code") => {
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
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: app, version: "1" } });
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
    joiner = await connect(joinHome, joinerApp);
    stage = "host opens the app";
    assert.ok(!(await tool(host.call, "browser_navigate", { url: "http://one.pbtest.example/app" })).result.isError);

    stage = "a shared browser code (the default), joined and approved";
    const made = text(await tool(host.call, "pairbrowse_invite", { action: "create", role: "drive", label: "Alice", share: "code" }));
    assert.match(made, /Shared browser: they work in this browser itself/);
    const code = made.match(/Join code: (pb-join:[A-Za-z0-9_-]+)/)?.[1];
    assert.ok(code, made);
    assert.match(text(await tool(joiner.call, "pairbrowse_join", { action: "join", code })), /shared browser/);
    const id = await until("the request", async () => text(await tool(host.call, "pairbrowse_invite", { action: "list" })).match(/request (r[0-9a-f]{6}): Alice \((?:Claude Code|Codex)\), waiting/)?.[1]);
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
      await until("connected", async () => (await onScreen({ expr: "window.pbScreen && window.pbScreen.state()" }))?.value?.conn === "connected", 45_000);
      // The input channel opens just after the connection itself (WebRTC announces it once the
      // connection is up): moments later, not never.
      const state = await until("input goes over the direct connection", async () => { const s = (await onScreen({ expr: "window.pbScreen.state()" }))?.value; return s?.conn === "connected" && s.direct && s; }, 5000);
      assert.equal(state.offers, 1, "one connection for the picture page");
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
    await until("the host's page was clicked", async () => /(^| · )clicked$/.test(await evaluate(host.call, "() => document.title")), 15_000);

    stage = "the picture's tab says who works in the host's tab: the host's agent, by name and spark";
    const inTab = await until("the host's agent on the picture's tab", async () => { const w = (await onScreen({ expr: "window.pbScreen.inTab()" }))?.value; return w?.agent && w.icon && w.title === `\u2726 ${w.agent} \u00b7 clicked` && w; }, 15_000);
    assert.equal(inTab.person, "", "the joiner's own hand isn't shown to them");

    stage = "the picture shows the host tab's real address; its own address is short";
    const own = (await onScreen({ url: true }))?.url || "";
    assert.match(own, /^chrome-extension:\/\/[a-p]{32}\/screen\.html#[0-9a-f]{8}$/, own);
    const shownAt = async (want) => until(`the address ${want} on the picture`, async () => { const a = (await onScreen({ expr: "window.pbScreen.address()" }))?.value; return a?.shown && a.text === want && a; }, 15_000);
    const addr = await shownAt("one.pbtest.example/app");
    assert.equal(addr.lock, false, "no lock on a plain http page");
    assert.equal(addr.warn, true, "it says the page isn't secure");

    stage = "an address typed into the picture tab's address bar takes the host's tab there";
    const hostUrl = async () => String(await evaluate(host.call, "() => location.href"));
    await tool(host.call, "pairbrowse_collaboration", { action: "release" });
    await onScreen({ goto: "http://one.pbtest.example/typed" });
    await until("the host's tab at the typed address", async () => (await hostUrl()) === "http://one.pbtest.example/typed", 15_000);
    await shownAt("one.pbtest.example/typed"); // and the tab here is the picture again
    await until("the picture tab's own address again", async () => /\/screen\.html#[0-9a-f]{8}$/.test((await onScreen({ url: true }))?.url || ""), 10_000);
    await onScreen({ goto: "http://one.pbtest.example/app" });
    await until("the host's tab back at the app", async () => (await hostUrl()) === "http://one.pbtest.example/app", 15_000);
    await shownAt("one.pbtest.example/app");
    if (noDirect) return;
    const again = await until("connected again", async () => { const s = (await onScreen({ expr: "window.pbScreen.state()" }))?.value; return s?.conn === "connected" && s; }, 45_000);
    // The picture page, back from the typed address, is a new document: the offer asked for before
    // it went (a busy computer, a slow host) never replaces the connection it has (that dropped the
    // joiner's next click).
    await sleep(3000);
    const settled = (await onScreen({ expr: "window.pbScreen.state()" }))?.value;
    assert.deepEqual([settled?.doc, settled?.offers, settled?.peer], [again.doc, 1, again.peer], "one connection for the picture page, kept");

    stage = "picture and sound arrive smoothly, and the sound plays";
    const stats = await until("frames and sound", async () => {
      const a = (await onScreen({ expr: "window.pbScreen.stats()" }))?.value;
      await sleep(1000);
      const b = (await onScreen({ expr: "window.pbScreen.stats()" }))?.value;
      return a && b && b.audioBytes > a.audioBytes && b.frames > a.frames && b;
    }, 20_000);
    console.log(`shared browser stats: ${JSON.stringify(stats)}`);
    assert.equal(stats.muted, false, "the sound plays, without a click first");
    assert.equal(stats.paused, false);
    if (realTunnel) assert.ok(stats.route, "a route was found");
    if (excalidraw) {
      // Excalidraw in the host's tab: the joiner picks the rectangle tool with R and drags; a shape
      // appears in the host's drawing (Excalidraw keeps it in the host's browser storage).
      stage = "the joiner draws a rectangle in the host's Excalidraw";
      assert.ok(!(await tool(host.call, "browser_navigate", { url: "https://excalidraw.com/" })).result.isError);
      await sleep(5000);
      await tool(host.call, "pairbrowse_collaboration", { action: "release" });
      const count = async () => Number(await evaluate(host.call, "() => { try { return JSON.parse(localStorage.getItem('excalidraw') || '[]').filter((e) => !e.isDeleted).length; } catch { return -1; } }"));
      const before = await count();
      await onScreen({ type: "r" });
      await sleep(500);
      const a = toJoiner(0.35, 0.4), b = toJoiner(0.6, 0.65);
      const moves = [];
      for (let i = 1; i <= 15; i++) moves.push({ type: "mouse", action: "mouseMoved", x: Math.round(a.x + (b.x - a.x) * i / 15), y: Math.round(a.y + (b.y - a.y) * i / 15), button: "left", buttons: 1 });
      await input([{ type: "mouse", action: "mouseMoved", ...a }, { type: "mouse", action: "mousePressed", ...a, button: "left", buttons: 1, clickCount: 1 }]);
      for (const m of moves) { await input([m]); await sleep(30); }
      await input([{ type: "mouse", action: "mouseReleased", ...b, button: "left", buttons: 0, clickCount: 1 }]);
      const after = await until("a shape in the host's drawing", async () => { const n = await count(); return n > before && n; }, 15_000).catch(() => count());
      console.log(`excalidraw shapes: before ${before}, after ${after}`);
      if (process.env.SHOT_JOINER) { await sleep(800); await onScreen({ shot: process.env.SHOT_JOINER }); }
      assert.ok(after > before, `a rectangle was drawn (before ${before}, after ${after})`);
      return;
    }
    if (youtube) {
      // A real video on YouTube, in the host's tab: the joiner gets it moving, with sound.
      stage = "a YouTube video plays smoothly in the joiner's picture";
      assert.ok(!(await tool(host.call, "browser_navigate", { url: "https://www.youtube.com/embed/jfKfPfyJRdk?autoplay=1&mute=0" })).result.isError);
      await sleep(4000);
      await click(toJoiner(0.5, 0.5)); // start it, as the joiner would
      const yt = await until("the video moving in the picture", async () => {
        const a = (await onScreen({ expr: "window.pbScreen.stats()" }))?.value;
        await sleep(3000);
        const b = (await onScreen({ expr: "window.pbScreen.stats()" }))?.value;
        const fps = a && b ? (b.frames - a.frames) / 3 : 0;
        return fps >= 20 && b.audioBytes > a.audioBytes && { fps, ...b };
      }, 60_000);
      console.log(`youtube in the picture: ${JSON.stringify(yt)}`);
      return;
    }

    stage = "keys typed on the picture go into the host's field";
    await tool(host.call, "pairbrowse_collaboration", { action: "release" }); // the host's agent lets the tab go (turns, as everywhere)
    // Keys go where the click put the focus: typed before that click reached the host's tab (a
    // busy computer), they would land nowhere. So type once the host's field has the focus.
    await click(toJoiner(0.5, 0.4));
    await until("the click focuses the host's field", async () => (await evaluate(host.call, "() => document.activeElement?.id")) === "i", 15_000);
    await onScreen({ type: "hi!" }); // real key presses on the picture page
    await until("the host's field has the text", async () => (await evaluate(host.call, "() => document.getElementById('i').value")) === "hi!", 15_000);
    // The host sees Alice in that tab: a dot in her pointer's color on its icon.
    const iconAt = "async () => { const l = [...document.querySelectorAll('link[rel~=\"icon\"]')].pop(); if (!l || !l.href.startsWith('data:image/png')) return ''; const img = new Image(); img.src = l.href; await img.decode(); const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(40, 40, 1, 1).data; return '#' + [d[0], d[1], d[2]].map((x) => x.toString(16).padStart(2, '0')).join(''); }";
    await until("Alice's dot on the host's tab icon", async () => (await evaluate(host.call, iconAt)) === personColor("Alice"), 10_000);

    stage = "a drag on the picture draws on the host's canvas";
    const a = toJoiner(0.2, 0.75), b = toJoiner(0.8, 0.8);
    const moves = [];
    for (let i = 1; i <= 10; i++) moves.push({ type: "mouse", action: "mouseMoved", x: Math.round(a.x + (b.x - a.x) * i / 10), y: Math.round(a.y + (b.y - a.y) * i / 10), button: "left", buttons: 1 });
    await input([{ type: "mouse", action: "mouseMoved", ...a }, { type: "mouse", action: "mousePressed", ...a, button: "left", buttons: 1, clickCount: 1 }, ...moves, { type: "mouse", action: "mouseReleased", ...b, button: "left", buttons: 0, clickCount: 1 }]);
    await until("drawn on the host's canvas", async () => Number(await evaluate(host.call, "() => Number(document.getElementById('c').dataset.drawn) || 0")) >= 5, 15_000);

    stage = "the wheel on the picture scrolls the host's page";
    await input([{ type: "wheel", ...toJoiner(0.5, 0.5), dx: 0, dy: 400 }]);
    await until("the host's page scrolled", async () => Number(await evaluate(host.call, "() => scrollY")) > 100, 15_000);
    await input([{ type: "wheel", ...toJoiner(0.5, 0.5), dx: 0, dy: -4000 }]);
    await until("and back up", async () => Number(await evaluate(host.call, "() => scrollY")) === 0, 15_000);

    stage = "a file field clicked on the picture asks the joiner for the file, on their computer";
    const doc = join(joinHome, "doc.png");
    writeFileSync(doc, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    await onScreen({ choose: [doc] }); // what the person picks in their file dialog
    await sleep(1000);
    await click(toJoiner(0.3, 0.945));
    await until("the picked file in the host's field", async () => (await evaluate(host.call, "() => document.getElementById('f').files[0] && document.getElementById('f').files[0].name")) === "doc.png", 20_000);

    stage = "the host's agent holds the tab the joiner looks at: another agent of the joiner's hears it's in use, and acts in no other tab";
    await tool(host.call, "pairbrowse_collaboration", { action: "release" });
    assert.ok(!(await tool(host.call, "browser_tabs", { action: "new" })).result.isError);
    assert.ok(!(await tool(host.call, "browser_navigate", { url: "http://two.pbtest.example/other" })).result.isError);
    await evaluate(host.call, "() => { document.title = 'Two'; }");
    const two = await until("the second tab's picture", async () => { try { return JSON.parse(text(await tool(joiner.call, "pairbrowse_test_screen", { list: true }))).find((p) => /(^| \u00b7 )Two$/.test(p.title)); } catch { return null; } });
    // Alice looks at it: in a headless browser every tab counts as visible, so the app's picture
    // says it's in the background, as it would be in a window.
    assert.ok((await fetch(`${live}tab`, { method: "POST", body: JSON.stringify({ i: two.index }) })).ok);
    await onScreen({ at: screen.index, expr: "Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }) && 1" });
    // The joiner's helper has seen which picture is in sight (its rounds take longer on a busy computer).
    const twoId = ((await onScreen({ at: two.index, url: true }))?.url || "").split("#")[1];
    assert.ok(twoId, "the second picture's tab id");
    await until("the second picture in sight for the joiner's helper", async () => (await onScreen({ inSight: true }))?.id === twoId, 20_000);
    await tool(host.call, "pairbrowse_collaboration", { action: "release" });
    const held = await tool(host.call, "browser_press_key", { key: "Shift" }); // the host's agent holds only that tab now
    assert.ok(!held.result?.isError, text(held));
    const second = await attach(joinHome, joinerApp);
    try {
      for (const [name, args] of [["browser_navigate", { url: "http://three.pbtest.example/x" }], ["browser_press_key", { key: "z" }]]) {
        const r = await tool(second.call, name, args);
        assert.ok(r.result?.isError, `${name} waits for its turn: ${text(r)}`);
        assert.match(text(r), /in use by Claude [0-9a-f]{4}\./, `${name}: ${text(r)}`);
      }
      const after = await tabs(host.call);
      assert.ok(after.some((t) => t.url === "http://one.pbtest.example/app") && !after.some((t) => /three\./.test(t.url)), `nothing happened in the free tab: ${JSON.stringify(after)}`);
      // Its tab is still the one it was sent to (reading takes no turn).
      assert.match(text(await tool(second.call, "browser_snapshot")), /two\.pbtest\.example\/other/, "in the tab it was sent to");
    } finally { second.sock.destroy(); }
    // Back to the app's tab alone, on both sides.
    await tool(host.call, "pairbrowse_collaboration", { action: "release" });
    assert.ok(!(await tool(host.call, "browser_tabs", { action: "close", index: (await tabs(host.call)).find((t) => t.url === "http://two.pbtest.example/other").index })).result.isError);
    assert.ok(!(await tool(host.call, "browser_tabs", { action: "select", index: (await tabs(host.call)).find((t) => t.url === "http://one.pbtest.example/app").index })).result.isError);
    await onScreen({ at: screen.index, expr: "delete document.visibilityState" });
    assert.ok((await fetch(`${live}tab`, { method: "POST", body: JSON.stringify({ i: screen.index }) })).ok);
    await until("the second tab's picture gone", async () => { try { return !JSON.parse(text(await tool(joiner.call, "pairbrowse_test_screen", { list: true }))).some((p) => /(^| \u00b7 )Two$/.test(p.title)); } catch { return false; } });

    stage = "the joiner's own agent works in the host's browser: reads, types, uploads a file from the joiner's computer";
    const snap = text(await tool(joiner.call, "browser_snapshot"));
    assert.match(snap, /button "Tap"/, `the host's page, not the picture: ${snap.slice(0, 800)}`);
    const note = snap.match(/textbox "Note"[^\n]*\[ref=((?:f\d+)?e\d+)\]/)?.[1];
    assert.ok(note, snap.slice(0, 600));
    // The field Alice typed in stays hers for a few seconds, even for her agent: it types once it's free.
    const typed = await until("the agent may type in the field", async () => { const r = await tool(joiner.call, "browser_type", { target: note, element: "Note", text: " from Alice's agent" }); return !r.result?.isError && r; }, 30_000);
    assert.ok(typed);
    await until("the agent's text in the host's field", async () => /from Alice's agent/.test(String(await evaluate(host.call, "() => document.getElementById('i').value"))), 15_000);
    const pic = join(joinHome, "pic.png");
    writeFileSync(pic, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const up = await tool(joiner.call, "pairbrowse_upload", { files: [pic], target: "Photo" });
    assert.ok(!up.result?.isError, text(up));
    await until("the file in the host's page", async () => (await evaluate(host.call, "() => document.getElementById('f').files[0] && document.getElementById('f').files[0].name")) === "pic.png", 15_000);
    assert.match(text(await tool(joiner.call, "pairbrowse_upload", { files: ["/etc/hosts"], target: "Photo" })), /only images, video and documents|never uploaded/, "the joiner's own upload rules");
    assert.match(text(await tool(host.call, "pairbrowse_collaboration", { action: "status" })), joinerApp === "claude-code" ? /Alice · Claude Code/ : /Alice · Codex/, "the host sees whose agent it is");

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
test("shared browser: the joiner's Codex works in the host's browser too", { skip: !runtime, timeout: 240_000 }, () => run({ joinerApp: "codex-mcp-client" }));
test("shared browser without a direct connection: pictures and input through the join channel", { skip: !runtime, timeout: 240_000 }, () => run({ noDirect: true }));
// Through a real Cloudflare Quick Tunnel, as between two computers (needs the network and cloudflared).
// Excalidraw on the real site through the picture (needs the network).
test("shared browser: the joiner draws in the host's Excalidraw", { skip: !runtime || process.env.PAIRBROWSE_TEST_EXCALIDRAW !== "1", timeout: 300_000 }, () => run({ excalidraw: true }));
// A real YouTube video through the picture (needs the network).
test("shared browser: a YouTube video plays smoothly with sound", { skip: !runtime || process.env.PAIRBROWSE_TEST_YOUTUBE !== "1", timeout: 300_000 }, () => run({ youtube: true }));
test("shared browser through a real Quick Tunnel", { skip: !runtime || process.env.PAIRBROWSE_TEST_REAL_TUNNEL !== "1", timeout: 300_000 }, () => run({ realTunnel: true }));
