// The Tools tab's lists fed by a real helper: a hand-off from pairbrowse_status "you" and from a
// run's handoff step, cleared by the agent's next click or the step ending; a download listed done
// with the page it came from. Live: a real helper and browser (PAIRBROWSE_TEST_RUNTIME).
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
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";

// A link that downloads a file, and a "Welcome" that shows once the test says the person is done.
const PAGE = `<!doctype html><title>Tools page</title><body>
<a id=f href="/file" download>Get the file</a> <p id=w></p>
<script>setInterval(async () => { try { if ((await (await fetch("/state")).text()) === "done") w.textContent = "Welcome back"; } catch {} }, 300);</script>`;

test("hand-offs and downloads reach the Tools tab's lists", { skip: !runtime, timeout: 180_000 }, async () => {
  let state = "waiting";
  const site = createServer((req, res) => {
    if (req.url === "/file") { res.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=note.txt" }); return res.end("hello"); }
    if (req.url === "/state") { res.writeHead(200, { "content-type": "text/plain" }); return res.end(state); }
    res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE);
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const base = existsSync("/Volumes/BACKUP/PairBrowse") ? "/Volumes/BACKUP/PairBrowse" : tmpdir();
  mkdirSync(base, { recursive: true });
  const h = mkdtempSync(join(base, "tools-"));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new"], display: "none", screenshots: false, downloadsDir: join(h, "downloads") }));
  const out = openSync(join(h, "daemon.stderr.log"), "a");
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: h }, stdio: ["ignore", out, out] });
  let a;
  const until = async (fn, what, ms = 15_000) => {
    let last;
    for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { last = await fn(); if (last) return last; }
    assert.fail(`${what}: ${JSON.stringify(last)}`);
  };
  try {
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
    a = await session(socketPath, "t");
    assert.match(text(await a.tool("pairbrowse_session", { action: "new", clean: true })), /clean/);
    const host = `127.0.0.1:${site.address().port}`;
    assert.ok(!(await a.tool("browser_navigate", { url: `http://${host}/` })).result?.isError);
    const live = text(await a.tool("pairbrowse_liveview")).match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)[0];
    const get = async (p) => (await fetch(`${live}${p}`)).json();

    // pairbrowse_status "you": one hand-off, that agent's, on this tab; the agent's next click clears it.
    assert.ok(!(await a.tool("pairbrowse_status", { kind: "you", text: "Sign in, then tell me" })).result?.isError);
    const one = await until(async () => { const l = (await get("handoffs.json")).items; return l.length === 1 && l; }, "one hand-off");
    assert.ok(one[0].by?.label, "the agent's label");
    assert.equal(one[0].tab?.host, host);
    const ref = text(await a.tool("browser_snapshot", {})).match(/link "Get the file"[^\n]*\[ref=(e\d+)\]/)?.[1];
    assert.ok(ref, "the link's ref");
    assert.ok(!(await a.tool("browser_click", { element: "Get the file link", target: ref })).result?.isError);
    await until(async () => (await get("handoffs.json")).items.length === 0, "cleared by the click");

    // The click downloaded a file: done, with the page it came from.
    const d = await until(async () => (await get("downloads.json")).items.find((x) => x.state === "done"), "a finished download");
    assert.equal(d.from.host, host);
    assert.equal(d.name, "note.txt");
    assert.equal(readFileSync(join(h, "downloads", "note.txt"), "utf8"), "hello");

    // A run's handoff step: one hand-off while it waits, none once the page shows it's done.
    const run = a.tool("pairbrowse_run", { steps: [{ handoff: { say: "Solve the check", until: "Welcome back" } }] });
    await until(async () => (await get("handoffs.json")).items.length === 1, "the step's hand-off");
    state = "done";
    assert.ok(!(await run).result?.isError, "the run went on");
    await until(async () => (await get("handoffs.json")).items.length === 0, "cleared when the step ended");
  } catch (e) {
    throw new Error(`${e.message}\n${(() => { try { return readFileSync(join(h, "daemon.log"), "utf8").slice(-2000); } catch { return ""; } })()}`);
  } finally {
    a?.sock.destroy();
    if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await Promise.race([new Promise((r) => daemon.once("exit", r)), sleep(10_000)]); }
    site.close();
    rmSync(h, { recursive: true, force: true });
  }
});
