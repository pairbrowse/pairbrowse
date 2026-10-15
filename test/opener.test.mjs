// The PairBrowse browser opened by hand hands its bare start to the helper (plans/555 item 6):
// the record it finds the opener by, the opener itself (scripts/open.mjs) against a helper's
// socket, the helper's answer, and the context's openByHand.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import net from "node:net";

// A short home under the system temp folder: the socket path must stay short.
const home = mkdtempSync(join(tmpdir(), "pb-open-"));
process.env.PAIRBROWSE_HOME = home;
writeFileSync(join(home, "config.json"), "{}");
mkdirSync(join(home, "run"), { recursive: true });
after(() => rmSync(home, { recursive: true, force: true }));

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { parseOpener, writeOpener, openerPath, answerOpen, openLine, OPENER_MAX_BYTES } = await import("../scripts/opener.mjs");
const { HOOK_MARK } = await import("../scripts/guard.mjs");
const { routeConnection } = await import("../scripts/daemon/approvals.mjs");
const { paths } = await import("../scripts/paths.mjs");

const NODE = "/usr/local/bin/node";
const SCRIPT = "/Users/me/.claude/plugins/cache/pairbrowse/1.2.3/scripts/open.mjs";
const rec = (v) => JSON.stringify(v);

test("parseOpener: the browser's rule for the record", () => {
  assert.deepEqual(parseOpener(rec({ v: 1, node: NODE, script: SCRIPT })), { node: NODE, script: SCRIPT });
  const refused = [
    "", "not json", "null", "[]", rec({ v: 2, node: NODE, script: SCRIPT }), rec({ node: NODE, script: SCRIPT }),
    rec({ v: 1, node: "node", script: SCRIPT }), // relative
    rec({ v: 1, node: NODE, script: "scripts/open.mjs" }),
    rec({ v: 1, node: NODE, script: "/tmp/x/scripts/../scripts/open.mjs" }), // ..
    rec({ v: 1, node: NODE, script: "/tmp/x/scripts/daemon.mjs" }), // another script
    rec({ v: 1, node: NODE, script: "/tmp/x/bin/open.mjs" }), // not in a scripts folder
    rec({ v: 1, node: "/usr/bin/node\n--eval", script: SCRIPT }), // a line break
    rec({ v: 1, node: "/usr/bin/no\u0000de", script: SCRIPT }),
    rec({ v: 1, node: NODE, script: SCRIPT, pad: "x".repeat(OPENER_MAX_BYTES) }), // too long
    rec({ v: 1, node: 7, script: SCRIPT }),
  ];
  for (const text of refused) assert.equal(parseOpener(text), null, text.slice(0, 80));
});

test("writeOpener: owner-only, atomic, and only a record the browser takes", () => {
  const file = writeOpener({ node: NODE, script: SCRIPT });
  assert.equal(file, openerPath());
  assert.equal(file, join(home, "run", "opener.json"));
  assert.deepEqual(parseOpener(readFileSync(file, "utf8")), { node: NODE, script: SCRIPT });
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600, "the file: this account only");
    assert.equal(statSync(join(home, "run")).mode & 0o777, 0o700, "its folder too");
  }
  const other = SCRIPT.replace("1.2.3", "1.2.4");
  writeOpener({ node: NODE, script: other });
  assert.equal(parseOpener(readFileSync(file, "utf8")).script, other, "a later start rewrites it");
  assert.deepEqual(readdirSync(join(home, "run")).filter((f) => f.includes("opener")), ["opener.json"], "no temporary file left");
  assert.throws(() => writeOpener({ node: NODE, script: "/tmp/evil.mjs" }), /refuses/);
  assert.equal(parseOpener(readFileSync(file, "utf8")).script, other, "a refused record leaves the last one");
});

// A socket as answerOpen sees it.
function fakeSock() {
  const s = new EventEmitter();
  s.destroyed = false;
  s.sent = "";
  s.resume = () => {};
  s.end = (text) => { s.sent += text; s.destroyed = true; };
  return s;
}
const answered = async (s) => { for (let i = 0; i < 100 && !s.destroyed; i++) await new Promise((r) => setTimeout(r, 5)); return JSON.parse(s.sent); };

test("answerOpen: an open line is answered with open()'s answer; any other line is not its", async () => {
  const line = (v) => openLine(HOOK_MARK).trim().replace('"v":1', `"v":${v}`);
  assert.ok(openLine(HOOK_MARK).startsWith(HOOK_MARK), "the socket's one-line mark");
  const hookLine = `${HOOK_MARK},"op":"approval","v":1,"tool":"browser_click","input":{}}`;
  assert.equal(answerOpen(fakeSock(), hookLine, () => ({ ok: true })), false, "an approval hook's line goes on to the approvals");
  assert.equal(answerOpen(fakeSock(), "not json", () => ({ ok: true })), false);

  let s = fakeSock();
  assert.equal(answerOpen(s, line(1), async () => ({ ok: true })), true);
  assert.deepEqual(await answered(s), { ok: true });

  s = fakeSock();
  const logs = [];
  answerOpen(s, line(1), () => ({ ok: false, why: "the browser in use here isn't the PairBrowse browser" }), (l) => logs.push(l));
  assert.deepEqual(await answered(s), { ok: false, why: "the browser in use here isn't the PairBrowse browser" });
  assert.ok(logs.some((l) => /plain window/.test(l)), "the log says why");

  s = fakeSock();
  answerOpen(s, line(1), () => { throw new Error("boom"); });
  assert.deepEqual(await answered(s), { ok: false, why: "boom" });

  s = fakeSock();
  let called = false;
  answerOpen(s, line(2), () => { called = true; return { ok: true }; });
  assert.deepEqual(await answered(s), { ok: false, why: "unknown request" });
  assert.equal(called, false, "an unknown version opens nothing");
});

// scripts/open.mjs against a helper's socket in this home: its exit code is what the browser reads.
function runOpener() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, "scripts", "open.mjs")], { env: { ...process.env, PAIRBROWSE_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (code) => resolve({ code, err }));
  });
}
async function helperSocket(open) {
  rmSync(paths.socket, { force: true });
  const server = net.createServer((sock) => routeConnection(sock, {
    onHook: (s, line) => answerOpen(s, line, open) || s.destroy(),
    onOther: (s) => s.destroy(),
  }));
  await new Promise((r) => server.listen(paths.socket, r));
  return server;
}

test("open.mjs: exits 0 when the helper took the start, 1 with the reason when it declined", { timeout: 30_000 }, async () => {
  let asked = 0;
  let server = await helperSocket(() => { asked++; return { ok: true }; });
  let r = await runOpener();
  server.close();
  assert.equal(r.code, 0, r.err);
  assert.equal(asked, 1, "one request");

  server = await helperSocket(() => ({ ok: false, why: "PairBrowse is restarting" }));
  r = await runOpener();
  server.close();
  assert.equal(r.code, 1);
  assert.match(r.err, /declined: PairBrowse is restarting/);
});

test("context.openByHand: only a build with its own pages; opens the browser, then brings it forward", { timeout: 30_000 }, async () => {
  const { createContext } = await import("../scripts/daemon/context.mjs");
  const fronts = [];
  let launches = 0;
  const fakePage = (ctx) => {
    const page = {
      on() {}, once() {}, listeners: () => [], isClosed: () => false, context: () => ctx,
      url: () => page.at, goto: async (url) => { page.at = url; }, close: async () => {},
      bringToFront: async () => { fronts.push(page); }, setContent: async () => {}, evaluate: async () => {},
      at: "chrome://newtab/",
    };
    return page;
  };
  const fakeContext = () => {
    const ctx = new EventEmitter();
    const pages = [];
    ctx.pages = () => pages;
    ctx.addInitScript = async () => {};
    ctx.newPage = async () => { const p = fakePage(ctx); pages.push(p); return p; };
    ctx.browser = () => null;
    ctx.close = async () => { ctx.emit("close"); };
    pages.push(fakePage(ctx));
    return ctx;
  };
  const chromium = { launchPersistentContext: async () => { launches++; return fakeContext(); } };
  const quiet = () => {};
  let stopping = false;
  const make = (pages) => createContext({
    config: { browserEngine: "chromium", executablePath: "/fake/chrome", display: "none", sessionPicker: false }, log: quiet, chromium,
    hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
    presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
    shuttingDown: () => stopping, onStarted: quiet, onClosed: quiet, chromePagesOf: () => pages,
  });

  const plain = make(false);
  const no = await plain.openByHand();
  assert.equal(no.ok, false);
  assert.match(no.why, /isn't the PairBrowse browser/);
  assert.equal(launches, 0, "a helper on another browser opens nothing: the person's start opens as a plain window");

  const context = make(true);
  assert.deepEqual(await context.openByHand(), { ok: true });
  assert.equal(launches, 1, "the browser opened as the helper's");
  assert.equal(fronts.length, 1, "and came to the front");
  assert.deepEqual(await context.openByHand(), { ok: true }, "opened again by hand");
  assert.equal(launches, 1, "the open window, not a second browser");
  assert.equal(fronts.length, 2, "brought forward again");

  stopping = true;
  assert.deepEqual(await context.openByHand(), { ok: false, why: "PairBrowse is restarting" });
  stopping = false;

  // A start still going after acceptMs: accepted, and the launch goes on.
  let release;
  const slow = createContext({
    config: { browserEngine: "chromium", executablePath: "/fake/chrome", display: "none", sessionPicker: false }, log: quiet,
    chromium: { launchPersistentContext: () => new Promise((r) => { release = () => r(fakeContext()); }) },
    hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
    presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
    shuttingDown: () => false, onStarted: quiet, onClosed: quiet, chromePagesOf: () => true,
  });
  assert.deepEqual(await slow.openByHand({ acceptMs: 50 }), { ok: true });
  for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 10));
  release();
  await slow.getContext();

  // A start that fails inside the wait: no (the opener's browser opens a window of its own). One
  // that fails after it was taken: said to the person (a notification), never silently.
  const told = [];
  const failing = (ms) => createContext({
    config: { browserEngine: "chromium", executablePath: "/fake/chrome", display: "none", sessionPicker: false }, log: quiet, notify: (t) => told.push(t),
    chromium: { launchPersistentContext: () => new Promise((_, no) => setTimeout(() => no(new Error("the profile is locked")), ms)) },
    hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
    presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
    shuttingDown: () => false, onStarted: quiet, onClosed: quiet, chromePagesOf: () => true,
  });
  const quick = await failing(20).openByHand({ acceptMs: 2000 });
  assert.equal(quick.ok, false);
  assert.match(quick.why, /profile is locked/);
  assert.deepEqual(await failing(200).openByHand({ acceptMs: 50 }), { ok: true });
  for (let i = 0; i < 100 && !told.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.match(told.at(-1) || "", /The PairBrowse browser didn't start: .*profile is locked/);
});
