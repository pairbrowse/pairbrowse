// browser_drag moves what boards and lists are built to move: a card picked up on the first
// pointer move and carried by the ones after (most libraries), and an HTML5 drag-and-drop card.
// The main frame's snapshot refs read plain after navigations; a frame's keep its number. Live:
// a real helper and browser (PAIRBROWSE_TEST_RUNTIME).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync, symlinkSync, writeFileSync, rmSync, existsSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { session } from "./live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";
const refOf = (snapshot, re) => snapshot.split("\n").find((l) => re.test(l))?.match(/\[ref=([^\]]+)\]/)?.[1];

const PAGES = {
  // A board as pointer-event libraries build one: the press arms it, the first move past a
  // threshold picks the card up (where the pointer is then is its start), later moves carry it,
  // and letting go drops it on the column under the pointer's last position. One move alone
  // picks it up and drops it where it was.
  "/board": `<!doctype html><body style="margin:0;font:14px sans-serif">
<div style="display:flex;gap:40px;padding:20px">
  <div id=todo class=col style="width:200px;min-height:160px;border:1px solid #888"><h2>To do</h2><div id=card style="padding:12px;border:1px solid #06c;background:#eef;cursor:grab;user-select:none">Card A</div></div>
  <div id=doing class=col style="width:200px;min-height:160px;border:1px solid #888"><h2>Doing</h2></div>
</div><p id=log>moves 0</p>
<script>
let armed = null, dragging = false, moves = 0, last = null;
card.addEventListener("mousedown", (e) => { armed = { x: e.clientX, y: e.clientY }; moves = 0; dragging = false; });
document.addEventListener("mousemove", (e) => {
  if (!armed) return;
  if (!dragging) { if (Math.hypot(e.clientX - armed.x, e.clientY - armed.y) < 5) return; dragging = true; return; } // the pick-up: no position yet
  moves++; last = { x: e.clientX, y: e.clientY };
  log.textContent = "moves " + moves;
});
document.addEventListener("mouseup", () => {
  if (dragging && last) { const col = document.elementsFromPoint(last.x, last.y).find((n) => n.classList?.contains("col")); if (col) col.appendChild(card); }
  armed = null; dragging = false;
});
</script>`,
  // Native HTML5 drag-and-drop: the list takes the card on drop after a dragover.
  "/dnd": `<!doctype html><body><h1>Board</h1>
<ul id=todo style="min-height:80px;border:1px solid #888;width:200px;float:left"><li id=card draggable=true ondragstart="event.dataTransfer.setData('text/plain','card')">Card B</li></ul>
<ul id=done style="min-height:80px;border:1px solid #888;width:200px;float:left;margin-left:40px" ondragover="event.preventDefault()" ondrop="event.preventDefault(); this.appendChild(card)"><li>Done list</li></ul>`,
  "/a": `<!doctype html><body><h1>Page A</h1><a href="/b">to B</a><button onclick="this.textContent='Pressed'">One</button>`,
  "/b": `<!doctype html><body><h1>Page B</h1><button onclick="this.textContent='Pressed'">Two</button><iframe src="/c" style="width:300px;height:100px"></iframe>`,
  "/c": `<!doctype html><body><button onclick="this.textContent='Pressed in frame'">In frame</button>`,
};

test("browser_drag carries a card to another column, on boards that need more than one move and with HTML5 drag-and-drop", { skip: !runtime, timeout: 180_000 }, async () => {
  const site = createServer((req, res) => { const body = PAGES[req.url]; res.writeHead(body ? 200 : 404, { "content-type": "text/html" }); res.end(body || ""); });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${site.address().port}`;
  const h = mkdtempSync(join(tmpdir(), "pb-drag-"));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new"], display: "none", screenshots: false }));
  const out = openSync(join(h, "daemon.stderr.log"), "a");
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: h }, stdio: ["ignore", out, out] });
  let a;
  try {
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
    a = await session(socketPath, "d");
    assert.match(text(await a.tool("pairbrowse_session", { action: "new", clean: true })), /clean/);

    // The board that needs the card carried.
    assert.ok(!(await a.tool("browser_navigate", { url: `${base}/board` })).result?.isError);
    let s = text(await a.tool("browser_snapshot"));
    const r = await a.tool("browser_drag", { startElement: "Card A", startTarget: refOf(s, /Card A/), endElement: "Doing column", endTarget: refOf(s, /heading "Doing"/) }, 60_000);
    assert.ok(!r.result?.isError, text(r));
    assert.match(text(r), /^Dragged Card A to Doing column/, text(r));
    assert.match(text(r), /\[ref=e\d+\]/, "the result carries a fresh snapshot");
    s = text(await a.tool("browser_snapshot"));
    assert.match(s, /heading "Doing"[\s\S]*Card A/, `the card is in the Doing column now:\n${s.slice(0, 800)}`);
    assert.match(s, /moves ([2-9]|\d\d+)/, "the page saw the card move on the way");

    // HTML5 drag-and-drop.
    await a.tool("browser_navigate", { url: `${base}/dnd` });
    s = text(await a.tool("browser_snapshot"));
    const r2 = await a.tool("browser_drag", { startElement: "Card B", startTarget: refOf(s, /Card B/), endElement: "Done list", endTarget: refOf(s, /Done list/) }, 60_000);
    assert.ok(!r2.result?.isError, text(r2));
    s = text(await a.tool("browser_snapshot"));
    assert.match(s, /Done list[\s\S]*Card B/, `the card is in the Done list now:\n${s.slice(0, 800)}`);

    // A stale ref: a plain reason, and the mouse button isn't left held (the next click works).
    const bad = await a.tool("browser_drag", { startElement: "Gone", startTarget: "e999", endElement: "Done list", endTarget: refOf(s, /Done list/) }, 60_000);
    assert.ok(bad.result?.isError);
    assert.match(text(bad), /Couldn't drag Gone to Done list: .*(ref|find)/, text(bad));

    // Refs after navigations: the main page's read plain, a frame's keep their number, both click.
    await a.tool("browser_navigate", { url: `${base}/a` });
    await a.tool("browser_navigate", { url: `${base}/b` });
    s = text(await a.tool("browser_snapshot"));
    const two = refOf(s, /button "Two"/), inFrame = refOf(s, /button "In frame"/);
    assert.match(two, /^e\d+$/, `the main page's refs are plain after navigating: ${two}\n${s.slice(0, 600)}`);
    assert.match(inFrame, /^f\d+e\d+$/, `a frame's refs keep their number: ${inFrame}`);
    assert.ok(!(await a.tool("browser_click", { element: "Two", target: two })).result?.isError);
    assert.ok(!(await a.tool("browser_click", { element: "In frame", target: inFrame })).result?.isError);
    s = text(await a.tool("browser_snapshot"));
    assert.match(s, /button "Pressed"[^\n]*\[ref=e\d+\]/, s.slice(0, 600));
    assert.match(s, /button "Pressed in frame"[^\n]*\[ref=f\d+e\d+\]/, s.slice(0, 600));
    // A ref from the page before is turned away, not quietly pointed at something else.
    const stale = await a.tool("browser_click", { element: "One", target: "e77" });
    assert.ok(stale.result?.isError, text(stale));
    assert.match(text(stale), /e77|not found|changed/i, text(stale));
    assert.doesNotMatch(text(stale), /f\d+e\d+/, "Claude never sees the main frame's number");
  } catch (e) {
    throw new Error(`${e.message}\n${(() => { try { return readFileSync(join(h, "daemon.log"), "utf8").slice(-1500); } catch { return ""; } })()}`);
  } finally {
    a?.sock.destroy();
    if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await Promise.race([new Promise((r) => daemon.once("exit", r)), sleep(10_000)]); }
    site.close();
    rmSync(h, { recursive: true, force: true });
  }
});
