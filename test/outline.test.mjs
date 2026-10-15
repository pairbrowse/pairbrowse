// The Page tab's outline (scripts/daemon/outline.mjs): the whole-page snapshot an agent last got
// for a tab, kept in memory from the result's text, never asked of the page; served to the owner
// only (GET outline.json, the `outline` event without the text), dropped when the tab closes.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtempSync, symlinkSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutlines, yamlOf, OUTLINE_MAX } from "../scripts/daemon/outline.mjs";
import { startLiveView, createInvites } from "../scripts/liveview.mjs";
import { spawnDaemon } from "./helpers/daemon.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// A tab that fails the test if anything but url() and isClosed() is asked of it (strict), or a
// plain one for the live view's own tab lists (their titles and icons are read as today).
function fakePage(url = "https://shop.example/signup", { strict = true } = {}) {
  const page = new EventEmitter();
  let closed = false;
  page.url = () => url;
  page.isClosed = () => closed;
  for (const m of ["evaluate", "title", "content", "screenshot", "locator", "ariaSnapshot", "mainFrame"]) page[m] = strict ? () => { throw new Error(`the page was asked ${m}()`); } : async () => (m === "title" ? "" : null);
  page.close = () => { closed = true; page.emit("close"); };
  return page;
}
const SNAP = "- heading \"Sign up\" [level=1] [ref=e2]\n- textbox \"Email\" [ref=e3]\n- button \"Continue\" [ref=e4]";
const result = (yaml) => `### Page state\n- Page URL: https://shop.example/signup\n- Page Snapshot:\n\`\`\`yaml\n${yaml}\n\`\`\`\n\n### PairBrowse\n- note`;

test("yamlOf takes the first yaml block; a cut result says so; no yaml is null", () => {
  assert.deepEqual(yamlOf(result(SNAP)), { text: SNAP, cut: false });
  const cut = `\`\`\`yaml\n${SNAP}\n\`\`\`\n\n### PairBrowse\n- This page's snapshot is long (about 9000 tokens); you got the first part. The whole snapshot is in /x/page-1.yml.`;
  assert.deepEqual(yamlOf(cut), { text: SNAP, cut: true });
  assert.equal(yamlOf("### Result\nClicked Continue"), null);
  assert.equal(yamlOf(undefined), null);
  // A ``` inside a snapshot line (a page showing a code block) is text: the block ends at the fence
  // on a line of its own, byte for byte.
  const code = "- heading \"Docs\" [level=1] [ref=e2]\n- code [ref=e3]: \"```js const a = 1; ```\"\n- text: ``` and more\n- button \"Copy\" [ref=e4]";
  assert.deepEqual(yamlOf(result(code)), { text: code, cut: false });
  assert.deepEqual(yamlOf(result(code).replace(/\n/g, "\r\n")), { text: code.replace(/\n/g, "\r\n"), cut: false }, "CRLF too");
});

test("the store keeps one outline per tab, the latest wins, a closed tab's goes, the page is never asked", () => {
  let t = 100;
  const changes = [];
  const outlines = createOutlines({ mask: (s) => s.replaceAll("hunter2", "[SHOP_PASSWORD]"), now: () => t++ });
  outlines.onChange((c) => changes.push({ op: c.op, page: c.page }));
  const a = fakePage(), b = fakePage("https://mail.example/");
  assert.equal(outlines.latest(), null);
  assert.equal(outlines.record(a, { text: result(SNAP), who: "Ada · Claude Code" }), true);
  assert.equal(outlines.record(a, { text: result(`${SNAP}\n- text: hunter2`), who: "Ada · Claude Code" }), true);
  assert.equal(outlines.record(b, { text: result("- heading \"Inbox\""), who: "Bo" }), true);
  assert.equal(outlines.record(b, { text: "### Result\nno yaml here" }), false, "a result without a snapshot keeps nothing");
  assert.equal(a.listenerCount("close"), 1, "one close listener per tab, however many records");
  assert.equal(outlines.size(), 2);
  assert.equal(outlines.latest(), b);
  const got = outlines.get(a);
  assert.equal(got.text, `${SNAP}\n- text: [SHOP_PASSWORD]`, "masked again on read");
  assert.deepEqual([got.who, got.cut, got.at], ["Ada · Claude Code", false, 101]);
  b.close();
  assert.equal(outlines.get(b), null);
  assert.equal(outlines.latest(), a);
  assert.deepEqual(changes.map((c) => c.op), ["set", "set", "set", "drop"]);
  assert.equal(changes.at(-1).page, b);
  // Never kept: a closed tab, the browser's own pages.
  assert.equal(outlines.record(b, { text: result(SNAP) }), false);
  assert.equal(outlines.record(fakePage("chrome://pairbrowse/picker"), { text: result(SNAP) }), false);
  assert.equal(outlines.record(fakePage("chrome://pairbrowse.top-chrome/strip"), { text: result(SNAP) }), false);
  assert.equal(outlines.size(), 1);
  // The cap: cut at a line boundary.
  const long = Array.from({ length: 4000 }, (_, i) => `- text: line ${i}`).join("\n");
  outlines.record(a, { text: result(long) });
  const capped = outlines.get(a);
  assert.ok(capped.text.length <= OUTLINE_MAX);
  assert.equal(capped.cut, true);
  assert.match(capped.text, /line \d+$/, "whole lines only");
  a.close();
  assert.equal(outlines.size(), 0);
});

// ---- the routes and events, over a fake browser ----
function request(port, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
function readStream(port, path) {
  return new Promise((resolve) => {
    let text = "";
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => { res.setEncoding("utf8"); res.on("data", (d) => (text += d)); resolve({ text: () => text, close: () => req.destroy() }); });
    req.on("error", () => {});
  });
}
const eventsIn = (text, name) => text.split("\n\n").filter((b) => b.startsWith(`event: ${name}\n`)).map((b) => JSON.parse(b.slice(b.indexOf("data: ") + 6)));

test("outline.json and the outline event: the owner's only, masked on read, metadata only on streams", async () => {
  const invites = createInvites();
  const outlines = createOutlines({ mask: (s) => s.replaceAll("hunter2", "[SHOP_PASSWORD]") });
  const a = fakePage(undefined, { strict: false }), b = fakePage("https://mail.example/inbox", { strict: false });
  const pages = [a, b];
  const view = await startLiveView({ getContext: async () => ({ pages: () => pages.filter((p) => !p.isClosed()) }), currentUrl: async () => a.url(), invites, outlines, mask: (s) => s.replaceAll("hunter2", "[SHOP_PASSWORD]") });
  const key = view.url.split("/").at(-2);
  const owner = await readStream(view.port, `/${key}/events?page=right`);
  const d = invites.create({ role: "drive", label: "D" });
  const guest = await readStream(view.port, `/${d.key}/events?panel=1`);
  try {
    let r = await request(view.port, "GET", `/${key}/outline.json`);
    assert.deepEqual(JSON.parse(r.text), { outline: null }, "none yet");
    outlines.record(a, { text: result(`${SNAP}\n- text: hunter2`), who: "Ada · Claude Code" });
    outlines.record(b, { text: result("- heading \"Inbox\""), who: "Bo" });
    r = await request(view.port, "GET", `/${key}/outline.json`);
    assert.equal(r.status, 200);
    const latest = JSON.parse(r.text).outline;
    assert.equal(latest.host, "mail.example", "the latest by default");
    const tabs = JSON.parse((await request(view.port, "GET", `/${key}/tabs.json`)).text);
    const idA = tabs.find((t) => t.host === "shop.example").id;
    r = await request(view.port, "GET", `/${key}/outline.json?tab=${idA}`);
    const one = JSON.parse(r.text).outline;
    assert.deepEqual(Object.keys(one).sort(), ["at", "cut", "host", "tab", "text", "who"]);
    assert.deepEqual([one.tab, one.host, one.who, one.cut], [idA, "shop.example", "Ada · Claude Code", false]);
    assert.equal(one.text, `${SNAP}\n- text: [SHOP_PASSWORD]`);
    assert.ok(!r.text.includes("hunter2"));
    assert.deepEqual(JSON.parse((await request(view.port, "GET", `/${key}/outline.json?tab=ffffffff`)).text), { outline: null }, "an unknown tab");
    await wait(50);
    const sets = eventsIn(owner.text(), "outline");
    assert.equal(sets.length, 2);
    assert.deepEqual(Object.keys(sets[0]).sort(), ["at", "cut", "host", "op", "tab", "who"], "never the text");
    assert.deepEqual([sets[0].op, sets[0].tab, sets[0].host], ["set", idA, "shop.example"]);
    assert.ok(!owner.text().includes("Sign up"), "no outline text on the stream");
    a.close();
    await wait(50);
    assert.deepEqual(eventsIn(owner.text(), "outline").at(-1), { op: "drop", tab: idA });
    assert.deepEqual(JSON.parse((await request(view.port, "GET", `/${key}/outline.json?tab=${idA}`)).text), { outline: null }, "gone with its tab");
    assert.equal(eventsIn(guest.text(), "outline").length, 0, "a guest's stream never gets it");
    for (const k of [d.key, invites.create({ role: "watch", label: "W" }).key]) assert.equal((await request(view.port, "GET", `/${k}/outline.json`)).status, 403);
    const c = invites.create({ role: "drive", label: "C", share: "code" });
    for (const k of [c.key, key]) assert.notEqual((await request(view.guestPort, "GET", `/${k}/outline.json`)).status, 200, "never on the join-code port");
    const state = JSON.parse((await request(view.port, "GET", `/${key}/state.json`)).text);
    assert.ok(!("outline" in state));
  } finally { owner.close(); guest.close(); view.close(); }
  const bare = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank" });
  try { assert.equal((await request(bare.port, "GET", `/${bare.url.split("/").at(-2)}/outline.json`)).status, 404, "no outlines given"); } finally { bare.close(); }
});

// ---- live: a real helper and browser (PAIRBROWSE_TEST_RUNTIME) ----
const runtime = process.env.PAIRBROWSE_TEST_RUNTIME?.replace(/^~/, process.env.HOME);
const text = (r) => (r.result?.content || []).filter((c) => c.type === "text").map((c) => c.text || "").join("\n") || r.error?.message || "";

test("live: the outline is the yaml the agent got, read without touching the page, gone with the tab", { skip: !runtime, timeout: 240_000 }, async () => {
  const { session } = await import("./helpers/live.mjs");
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  const h = mkdtempSync(join(tmpdir(), "pb-outline-"));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new"], display: "none", screenshots: false, sessionPicker: false }));
  const daemon = spawnDaemon(h);
  const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end("<!doctype html><title>Outline</title><h1>Sign up</h1><label>Email <input name=email></label><button>Continue</button>"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let agent;
  try {
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await wait(50);
    agent = await session(socketPath, "ol");
    assert.ok(!(await agent.tool("browser_navigate", { url: `http://127.0.0.1:${server.address().port}/` })).result?.isError);
    const snap = text(await agent.tool("browser_snapshot", {}));
    const yaml = yamlOf(snap);
    assert.ok(yaml, "the snapshot carries its yaml");
    const base = text(await agent.tool("pairbrowse_liveview")).match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)[0];
    const files = join(h, "files");
    const ymls = () => (existsSync(files) ? readdirSync(files).filter((f) => /^page-.*\.ya?ml$/.test(f)).length : 0);
    let got = null;
    for (let i = 0; i < 50 && !got; i++) { got = (await (await fetch(`${base}outline.json`)).json()).outline; if (!got) await wait(100); }
    const before = ymls();
    got = (await (await fetch(`${base}outline.json`)).json()).outline;
    assert.equal(ymls(), before, "reading the outline writes no snapshot file");
    assert.ok(got, "an outline after the snapshot");
    assert.equal(got.text, yaml.text, "byte for byte the yaml the agent got");
    assert.equal(got.cut, false);
    assert.equal(got.host, `127.0.0.1:${server.address().port}`);
    assert.match(got.text, /Sign up/);
    const tabs = await (await fetch(`${base}tabs.json`)).json();
    const id = got.tab;
    const index = tabs.find((t) => t.id === id)?.i;
    assert.equal(typeof index, "number");
    // A second tab so the first can close (the last tab is emptied, not closed).
    assert.ok(!(await agent.tool("browser_tabs", { action: "new" })).result?.isError);
    assert.ok(!(await agent.tool("browser_tabs", { action: "close", index })).result?.isError);
    let after = got;
    for (let i = 0; i < 50 && after; i++) { after = (await (await fetch(`${base}outline.json?tab=${id}`)).json()).outline; if (after) await wait(100); }
    assert.equal(after, null, "gone with its tab");
  } catch (e) {
    throw new Error(`${e.message}\n${(() => { try { return readFileSync(join(h, "daemon.log"), "utf8").slice(-2000); } catch { return ""; } })()}`);
  } finally {
    agent?.sock.destroy();
    server.close();
    if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await Promise.race([new Promise((r) => daemon.once("exit", r)), wait(10_000)]); }
    rmSync(h, { recursive: true, force: true });
  }
});
