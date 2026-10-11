// The Tools tab's lists fed by a real helper: a hand-off from pairbrowse_status "you" and from a
// run's handoff step, cleared by the agent's next click or the step ending; a download listed done
// with the page it came from. Live: a real helper and browser (PAIRBROWSE_TEST_RUNTIME).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync, openSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { session } from "./live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";

// A link that downloads a file, and a "Welcome" that shows once the test says the person is done.
const PAGE = `<!doctype html><title>Tools page</title><body>
<a id=f href="/file" download>Get the file</a> <p id=w></p>
<script>setInterval(async () => { try { if ((await (await fetch("/state")).text()) === "done") w.textContent = "Welcome back"; } catch {} }, 300);</script>`;

// A helper of its own (a fresh home, Playwright's Chromium, headless), with its site.
async function startHelper(handler, prefix) {
  const site = createServer(handler);
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const base = existsSync("/Volumes/BACKUP/PairBrowse") ? "/Volumes/BACKUP/PairBrowse" : tmpdir();
  mkdirSync(base, { recursive: true });
  const h = mkdtempSync(join(base, prefix));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new"], display: "none", screenshots: false, downloadsDir: join(h, "downloads") }));
  const out = openSync(join(h, "daemon.stderr.log"), "a");
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: h }, stdio: ["ignore", out, out] });
  const socketPath = join(h, "run", "browser.sock");
  const ready = async () => { for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50); };
  const log = () => { try { return readFileSync(join(h, "daemon.log"), "utf8").slice(-2000); } catch { return ""; } };
  const stop = async () => {
    if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await Promise.race([new Promise((r) => daemon.once("exit", r)), sleep(10_000)]); }
    site.close();
    rmSync(h, { recursive: true, force: true });
  };
  return { site, h, socketPath, ready, log, stop };
}
const until = async (fn, what, ms = 15_000) => {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { last = await fn(); if (last) return last; }
  assert.fail(`${what}: ${JSON.stringify(last)}`);
};

test("hand-offs and downloads reach the Tools tab's lists", { skip: !runtime, timeout: 180_000 }, async () => {
  let state = "waiting";
  const { site, h, socketPath, ready, log, stop } = await startHelper((req, res) => {
    if (req.url === "/file") { res.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=note.txt" }); return res.end("hello"); }
    if (req.url === "/state") { res.writeHead(200, { "content-type": "text/plain" }); return res.end(state); }
    res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE);
  }, "tools-");
  let a;
  try {
    await ready();
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
    throw new Error(`${e.message}\n${log()}`);
  } finally {
    a?.sock.destroy();
    await stop();
  }
});

// A PDF, a .txt with a marker only the person may see, and (macOS) a Word document whose RTF holds
// a javascript: link.
const MARKER = "PB-PERSON-ONLY-7f3a";
const FILES_PAGE = `<!doctype html><title>Files page</title><body><a id=p href="/doc.pdf">Get the PDF</a> <a id=t href="/note.txt">Get the note</a> <a id=d href="/plan.docx">Get the plan</a></body>`;
const PDF = Buffer.from("%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

test("a downloaded PDF and .txt open in the person's tab; agents can't reach it", { skip: !runtime, timeout: 240_000 }, async () => {
  let docx = null;
  if (process.platform === "darwin") {
    const dir = mkdtempSync(join(tmpdir(), "pb-docx-"));
    writeFileSync(join(dir, "plan.rtf"), '{\\rtf1\\ansi {\\field{\\*\\fldinst HYPERLINK "javascript:alert(1)"}{\\fldrslt Click me}} Plan text}');
    execFileSync("/usr/bin/textutil", ["-convert", "docx", "-output", join(dir, "plan.docx"), "--", join(dir, "plan.rtf")]);
    docx = readFileSync(join(dir, "plan.docx"));
    rmSync(dir, { recursive: true, force: true });
  }
  const attach = (res, type, name, body) => { res.writeHead(200, { "content-type": type, "content-disposition": `attachment; filename=${name}` }); res.end(body); };
  const { site, h, socketPath, ready, log, stop } = await startHelper((req, res) => {
    if (req.url === "/doc.pdf") return attach(res, "application/pdf", "doc.pdf", PDF);
    if (req.url === "/note.txt") return attach(res, "text/plain", "note.txt", `Only for the person: ${MARKER}\n`);
    if (req.url === "/plan.docx" && docx) return attach(res, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "plan.docx", docx);
    res.writeHead(200, { "content-type": "text/html" }); res.end(FILES_PAGE);
  }, "persontab-");
  let a, b;
  try {
    await ready();
    a = await session(socketPath, "a");
    assert.match(text(await a.tool("pairbrowse_session", { action: "new", clean: true })), /clean/);
    assert.ok(!(await a.tool("browser_navigate", { url: `http://127.0.0.1:${site.address().port}/` })).result?.isError);
    const live = text(await a.tool("pairbrowse_liveview")).match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)[0];
    const get = async (p) => (await fetch(`${live}${p}`)).json();
    const post = async (p, body = {}) => { const r = await fetch(`${live}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.text() }; };

    // The agent downloads the files.
    const names = ["doc.pdf", "note.txt", ...(docx ? ["plan.docx"] : [])];
    const snap = text(await a.tool("browser_snapshot", {}));
    for (const [label, name] of [["Get the PDF", "doc.pdf"], ["Get the note", "note.txt"], ["Get the plan", "plan.docx"]]) {
      if (!names.includes(name)) continue;
      const ref = snap.match(new RegExp(`link "${label}"[^\n]*\\[ref=(e\\d+)\\]`))?.[1];
      assert.ok(ref, `the ${label} link's ref`);
      assert.ok(!(await a.tool("browser_click", { element: `${label} link`, target: ref })).result?.isError, label);
    }
    const items = await until(async () => { const l = (await get("downloads.json")).items.filter((x) => x.state === "done"); return names.every((n) => l.some((x) => x.name === n)) && l; }, "the downloads, done");
    const idOf = (n) => items.find((x) => x.name === n).id;
    // macOS's download mark, as a browser's download would carry it.
    if (process.platform === "darwin") {
      for (const n of names) {
        const f = join(h, "downloads", n);
        try { execFileSync("/usr/bin/xattr", ["-p", "com.apple.quarantine", f], { stdio: "ignore" }); } catch { execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;68a1b2c3;Chromium;", f]); }
      }
    }
    for (const n of ["doc.pdf", "note.txt"]) {
      const r = await post(`downloads/${idOf(n)}/open`);
      assert.equal(r.status, 200, `${n}: ${r.body}`);
      assert.deepEqual(JSON.parse(r.body), { opened: "tab" }, n);
    }
    const personal = await until(async () => { const l = (await get("tabs.json")).filter((x) => x.personal); return l.length === 2 && l; }, "two person's tabs in tabs.json");

    // The agent: no address, no title, no content of the person's tabs.
    const clean = (t, what) => { assert.ok(!t.includes("file:"), `${what}: ${t}`); assert.ok(!t.includes(MARKER), `${what}: marker`); assert.ok(!/doc\.pdf\]|note\.txt\]/.test(t), `${what}: title`); };
    clean(text(await a.tool("browser_snapshot", {})), "a snapshot");
    const list = text(await a.tool("browser_tabs", { action: "list" }));
    clean(list, "a tab list");
    assert.equal((list.match(/the person's tab \(a downloaded file\)/g) || []).length, 2, list);
    for (const action of ["select", "close"]) {
      const r = await a.tool("browser_tabs", { action, index: personal[0].i });
      assert.ok(r.result?.isError, action);
      assert.match(text(r), /person's own/, action);
    }
    assert.ok((await get("tabs.json")).some((x) => x.personal && x.i === personal[0].i), "still open");
    clean(text(await a.tool("browser_navigate", { url: `http://127.0.0.1:${site.address().port}/` })), "a navigate");
    clean(text(await a.tool("browser_tabs", { action: "new", url: `http://127.0.0.1:${site.address().port}/` })), "a new tab");

    // A second agent: its first tab is a web tab, never the person's.
    b = await session(socketPath, "b");
    const first = text(await b.tool("browser_snapshot", {}));
    clean(first, "b's first snapshot");
    assert.match(first, /Files page|Get the PDF/, "b landed in a web tab");

    // macOS: the Word document as a sanitized preview; closing its tab removes the file.
    if (docx) {
      const r = await post(`downloads/${idOf("plan.docx")}/open`);
      assert.equal(r.status, 200, r.body);
      assert.deepEqual(JSON.parse(r.body), { opened: "preview" });
      const file = await until(async () => { const f = readdirSync(join(h, "previews")).find((x) => x.startsWith(`${idOf("plan.docx")}-`) && x.endsWith(".html")); return f && join(h, "previews", f); }, "the preview file");
      const html = readFileSync(file, "utf8");
      assert.match(html, /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/);
      for (const bad of [/<script/i, /\son\w+=/i, /href/i, /javascript:/i, /<form/i, /<iframe/i]) assert.doesNotMatch(html, bad);
      assert.match(html, /Plan text/);
      const tab = await until(async () => (await get("tabs.json")).find((x) => x.personal && /plan\.docx|previews/.test(`${x.title} ${x.url}`)), "the preview's tab");
      assert.deepEqual(tab.preview, { id: idOf("plan.docx"), kind: "document" }, "the owner's strip says which download it shows");
      assert.equal((await post("tab", { close: tab.i })).status, 204);
      await until(async () => !existsSync(file), "the preview removed with its tab");
    }
  } catch (e) {
    throw new Error(`${e.message}\n${log()}`);
  } finally {
    a?.sock.destroy();
    b?.sock.destroy();
    await stop();
  }
});
