// An agent hears what the page says is wrong with what it filled, and a recording of the browser
// is saved as a video file. Live: a real helper and browser (PAIRBROWSE_TEST_RUNTIME).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync, openSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { session } from "./live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";

// A form whose email field shows its own error once left, a dropdown, and something that moves.
const PAGE = `<!doctype html><title>Form</title><body>
<label for=e>Email</label> <input id=e type=email aria-describedby=eh><span id=eh></span>
<label for=n>Name</label> <input id=n>
<label for=c>Country</label> <select id=c><option>Belgium</option><option>Netherlands</option></select>
<div id=dot style="width:40px;height:40px;background:#d97757;position:relative"></div>
<script>
e.addEventListener("blur", () => { const bad = !e.validity.valid; e.setAttribute("aria-invalid", String(bad)); eh.textContent = bad ? "Enter an email address like name@example.com" : ""; });
let x = 0; setInterval(() => { x = (x + 4) % 400; dot.style.left = x + "px"; }, 16);
</script>`;

test("the page's own errors come back with the run, and a recording is saved as a video", { skip: !runtime, timeout: 180_000 }, async () => {
  const site = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const base = existsSync("/Volumes/BACKUP/PairBrowse") ? "/Volumes/BACKUP/PairBrowse" : tmpdir();
  mkdirSync(base, { recursive: true });
  const h = mkdtempSync(join(base, "rec-"));
  const downloads = join(h, "downloads");
  symlinkSync(runtime, join(h, "runtime"), "dir");
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new"], display: "none", screenshots: false, downloadsDir: downloads }));
  const out = openSync(join(h, "daemon.stderr.log"), "a");
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: h }, stdio: ["ignore", out, out] });
  let a;
  try {
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
    a = await session(socketPath, "r");
    assert.match(text(await a.tool("pairbrowse_session", { action: "new", clean: true })), /clean/);
    const url = `http://127.0.0.1:${site.address().port}/`;
    assert.ok(!(await a.tool("browser_navigate", { url })).result?.isError);

    // A value the page doesn't accept: the run says so, in the page's own words.
    const bad = text(await a.tool("pairbrowse_run", { steps: [{ fill: { Email: "not an email", Name: "Ada" } }, { select: { Country: "Netherlands" } }] }));
    assert.match(bad, /Check before going on, the page says: "Email": Enter an email address like name@example\.com/, bad);
    assert.doesNotMatch(bad, /"Name"|"Country"/, "only the field that's wrong");
    const good = text(await a.tool("pairbrowse_run", { steps: [{ fill: { Email: "ada@example.com" } }] }));
    assert.doesNotMatch(good, /Check before going on/, good);

    // A recording: the tab in front, then another tab, saved in Downloads.
    const started = text(await a.tool("pairbrowse_record", { action: "start" }));
    assert.match(started, /Recording the browser \(\d+x\d+\)/, started);
    assert.match(text(await a.tool("pairbrowse_record", { action: "start" })), /Already recording/);
    await sleep(1500);
    await a.tool("browser_tabs", { action: "new" });
    await a.tool("browser_navigate", { url });
    await sleep(1500);
    assert.match(text(await a.tool("pairbrowse_record", { action: "status" })), /Recording, \d+ s so far/);
    const saved = text(await a.tool("pairbrowse_record", { action: "stop" }, 90_000));
    assert.match(saved, /Saved the recording \(\d+ s, [\d.]+ MB\) to /, saved);
    const files = readdirSync(downloads);
    assert.equal(files.length, 1, files.join(", "));
    assert.match(files[0], /^PairBrowse recording \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.(mp4|webm)$/);
    const file = join(downloads, files[0]);
    assert.ok(statSync(file).size > 10_000, `a real video (${statSync(file).size} bytes)`);
    const head = readFileSync(file).subarray(0, 12);
    assert.ok(head.subarray(4, 8).toString() === "ftyp" || head.readUInt32BE(0) === 0x1a45dfa3, "an MP4 or WebM file");
    assert.equal((statSync(file).mode & 0o777).toString(8), "600");
    assert.match(text(await a.tool("pairbrowse_record", { action: "stop" })), /Not recording/);
  } catch (e) {
    throw new Error(`${e.message}\n${(() => { try { return readFileSync(join(h, "daemon.log"), "utf8").slice(-2000); } catch { return ""; } })()}`);
  } finally {
    a?.sock.destroy();
    if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await Promise.race([new Promise((r) => daemon.once("exit", r)), sleep(10_000)]); }
    site.close();
    rmSync(h, { recursive: true, force: true });
  }
});
