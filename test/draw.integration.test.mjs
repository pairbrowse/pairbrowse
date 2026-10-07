// A drawn stroke lands where it's meant to: pressed at its first point, through the others, let go
// at the last, at a drawing pace. Live: a real helper and browser (PAIRBROWSE_TEST_RUNTIME); with
// PAIRBROWSE_TEST_NATIVE=<PairBrowse browser> the native one, with its humanized mouse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { session } from "./live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const native = process.env.PAIRBROWSE_TEST_NATIVE;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";

// The page writes what the mouse did into its title-free text, so a snapshot can read it.
const PAGE = `<!doctype html><body style="margin:0"><canvas id=c style="position:fixed;inset:0;width:100vw;height:100vh"></canvas>
<p id=log style="position:fixed;left:4px;bottom:4px;margin:0">none</p><script>
let down = null, moves = 0, up = null, far = 0;
const W = () => innerWidth, H = () => innerHeight, f = (e) => (e.clientX / W()).toFixed(2) + "," + (e.clientY / H()).toFixed(2);
c.addEventListener("pointerdown", (e) => { down = f(e); moves = 0; up = null; show(); });
c.addEventListener("pointermove", (e) => { if (e.buttons & 1) moves++; });
c.addEventListener("pointerup", (e) => { up = f(e); show(); });
function show() { log.textContent = "down " + down + " up " + (up || "-") + " moves " + moves; }
</script>`;

test("a stroke presses at its first point, goes through the rest and lets go at the last, quickly", { skip: !runtime, timeout: 180_000 }, async () => {
  const site = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const base = existsSync("/Volumes/BACKUP/PairBrowse") ? "/Volumes/BACKUP/PairBrowse" : tmpdir();
  mkdirSync(base, { recursive: true });
  const h = mkdtempSync(join(base, "draw-"));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  const executablePath = native || createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, ...(native ? { browserEngine: "pairbrowse" } : { chromeArgs: ["--headless=new"] }), display: "none", screenshots: false }));
  const out = openSync(join(h, "daemon.stderr.log"), "a");
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: h }, stdio: ["ignore", out, out] });
  let a;
  try {
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
    a = await session(socketPath, "d");
    assert.match(text(await a.tool("pairbrowse_session", { action: "new", clean: true })), /clean/);
    assert.ok(!(await a.tool("browser_navigate", { url: `http://127.0.0.1:${site.address().port}/` })).result?.isError);
    // A move elsewhere first, as an agent's earlier action leaves the pointer.
    await a.tool("pairbrowse_run", { steps: [{ drag: [[0.8, 0.8], [0.85, 0.85]] }] });
    // 20 points: along a curve, ending at (0.3, 0.6).
    const pts = [[0.2, 0.3], ...Array.from({ length: 18 }, (_, i) => [Math.round((0.25 + 0.4 * Math.sin(i / 6)) * 100) / 100, Math.round((0.3 + i * 0.016) * 100) / 100]), [0.3, 0.6]];
    const t = Date.now();
    const r = await a.tool("pairbrowse_run", { steps: [{ drag: pts }] });
    const took = Date.now() - t;
    assert.ok(!r.result?.isError, text(r));
    const log = text(await a.tool("browser_find", { text: "down" })) + text(await a.tool("browser_snapshot"));
    const m = log.match(/down (\d\.\d\d),(\d\.\d\d) up (\d\.\d\d),(\d\.\d\d) moves (\d+)/);
    assert.ok(m, log.slice(0, 500));
    const [dx, dy, ux, uy, moves] = m.slice(1).map(Number);
    assert.ok(Math.abs(dx - 0.2) <= 0.02 && Math.abs(dy - 0.3) <= 0.02, `pressed at the first point, not elsewhere: ${dx},${dy}`);
    assert.ok(Math.abs(ux - 0.3) <= 0.02 && Math.abs(uy - 0.6) <= 0.02, `let go at the last point: ${ux},${uy}`);
    assert.ok(moves >= 8, `moved along the way (${moves} moves)`);
    assert.ok(took < 8000, `drawn at a drawing pace, not a hand's reach per point (${took} ms for 20 points)`);
    // The next stroke starts across the page: the hand glides there from the last one's end in
    // well under a second, not a slow reach each time.
    const t2 = Date.now();
    const r2 = await a.tool("pairbrowse_run", { steps: [{ drag: [[0.85, 0.2], [0.9, 0.25]] }] });
    const took2 = Date.now() - t2;
    assert.ok(!r2.result?.isError, text(r2));
    const log2 = text(await a.tool("browser_find", { text: "down" }));
    assert.match(log2, /down 0\.8[4-6],0\.(19|20|21) up 0\.(89|90|91),0\.2[4-6]/, log2.slice(0, 300));
    assert.ok(took2 < 3000, `the next stroke started quickly (${took2} ms)`);
  } catch (e) {
    throw new Error(`${e.message}\n${(() => { try { return readFileSync(join(h, "daemon.log"), "utf8").slice(-1500); } catch { return ""; } })()}`);
  } finally {
    a?.sock.destroy();
    if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await Promise.race([new Promise((r) => daemon.once("exit", r)), sleep(10_000)]); }
    site.close();
    rmSync(h, { recursive: true, force: true });
  }
});
