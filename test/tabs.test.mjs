import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackTabs, restoreTabs, loadingHtml, readSavedTabs } from "../scripts/tabs.mjs";

// A tab and a browser context with only what tabs.mjs uses.
function fakePage(url, title = "", { fails = false } = {}) {
  const p = new EventEmitter();
  const frame = {};
  Object.assign(p, {
    _url: url, closed: false, fronted: 0, html: "", marks: [],
    url: () => p._url, title: async () => title, mainFrame: () => frame,
    goto: async (u) => { if (fails) throw new Error("net::ERR_NAME_NOT_RESOLVED\nmore"); p._url = u; },
    setContent: async (html) => { p.html = html; },
    bringToFront: async () => { p.fronted = Date.now() + Math.random(); },
    close: async () => { p.closed = true; },
    evaluate: async (fn, args) => { p.marks.push(args); },
  });
  p.navigate = (u) => { p._url = u; p.emit("framenavigated", frame); };
  return p;
}
function fakeContext(pages, { failing = [] } = {}) {
  const ctx = new EventEmitter();
  const opened = [];
  ctx.pages = () => pages.filter((p) => !p.closed);
  ctx.opened = opened;
  ctx.newPage = async () => { const p = fakePage("about:blank"); const fails = failing.includes(opened.length); p.goto = async (u) => { if (fails) throw new Error("net::ERR_FAILED\nstack"); p._url = u; }; opened.push(p); pages.push(p); return p; };
  return ctx;
}
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "pb-tabs-")), "tabs.json");

test("saving tabs keeps web pages in order, with the active one's position", async () => {
  const a = fakePage("https://a.test/", "A");
  const settings = fakePage("chrome://settings", "Settings");
  const b = fakePage("http://b.test/x", "B".repeat(200));
  const ctx = fakeContext([a, settings, b]);
  const file = tmpFile();
  const t = trackTabs(ctx, { file, activePage: () => b });
  await t.saveNow();
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(saved.tabs.map((x) => x.url), ["https://a.test/", "http://b.test/x"]);
  assert.equal(saved.tabs[1].title.length, 120, "titles are capped");
  assert.equal(saved.active, 1);
  assert.deepEqual(readSavedTabs(file).tabs.map((x) => x.url), ["https://a.test/", "http://b.test/x"], "what's saved reads back");
  t.stop();
});

test("tab changes are saved once, after things settle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const a = fakePage("https://a.test/");
  const pages = [a];
  const ctx = fakeContext(pages);
  const file = tmpFile();
  trackTabs(ctx, { file });
  a.navigate("https://a.test/2");
  t.mock.timers.tick(1000);
  a.navigate("https://a.test/3");
  t.mock.timers.tick(1000);
  assert.ok(!existsSync(file), "still debouncing");
  const b = fakePage("https://b.test/");
  pages.push(b);
  ctx.emit("page", b);
  b.emit("framenavigated", {}); // a subframe: not a change
  t.mock.timers.tick(1500);
  await new Promise((r) => setImmediate(r));
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(saved.tabs.map((x) => x.url), ["https://a.test/3", "https://b.test/"]);
  assert.equal(saved.active, 0, "no active page: the first");
});

test("quitting the browser doesn't record an empty set of tabs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const a = fakePage("https://a.test/");
  const ctx = fakeContext([a]);
  const file = tmpFile();
  const tracker = trackTabs(ctx, { file });
  a.closed = true;
  a.emit("close");
  ctx.emit("close");
  t.mock.timers.tick(5000);
  await tracker.saveNow();
  // The tab went down with the browser, not by a person: it stays recorded (or nothing is).
  if (existsSync(file)) assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).tabs.map((x) => x.url), ["https://a.test/"]);
});

test("the browser dying before a pending save ran still records the tabs as last known", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const a = fakePage("https://a.test/"), b = fakePage("https://b.test/");
  const ctx = fakeContext([a, b]);
  const file = tmpFile();
  trackTabs(ctx, { file });
  a.navigate("https://a.test/two"); // a save is due in 1.5 s
  b.closed = true; b.emit("close"); // a person closed b just before
  t.mock.timers.tick(1200);
  a.closed = true; a.emit("close"); // the crash takes a down
  ctx.emit("close");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).tabs.map((x) => x.url), ["https://a.test/two"], "the new address, without the tab a person closed");
});

test("a tabs file that can't be written is logged, not thrown", async () => {
  const logs = [];
  const ctx = fakeContext([fakePage("https://a.test/")]);
  const tracker = trackTabs(ctx, { file: join(tmpdir(), "pb-no-such-dir", String(Date.now()), "tabs.json"), log: (...a) => logs.push(a.join(" ")) });
  await tracker.saveNow();
  assert.match(logs[0], /^saving tabs failed /);
  tracker.stop();
});

test("the Opening tabs screen escapes page titles and addresses", () => {
  const html = loadingHtml([{ url: "https://x.test/?q=<b>", title: `<img src=x onerror="alert(1)">'&` }, { url: "not a url", title: "" }]);
  assert.ok(!html.includes("<img"));
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;&#39;&amp;/);
  assert.match(html, /<span class="t">not a url<\/span>/, "no title: the address stands in");
  assert.match(html, /0 of 2, in the order you left them/);
  assert.equal((html.match(/<li /g) || []).length, 2);
});

test("saved tabs come back in order, a failed one is marked, and the active one ends in front", async () => {
  const screen = fakePage("about:blank");
  const ctx = fakeContext([screen], { failing: [1] });
  const progress = [];
  const logs = [];
  await restoreTabs(ctx, { tabs: [{ url: "https://a.test/" }, { url: "https://down.test/" }, { url: "https://c.test/" }], active: 2 }, {
    onProgress: (n, total, tab) => progress.push(`${n}/${total} ${tab.url}`), log: (m) => logs.push(m),
  });
  assert.deepEqual(progress, ["1/3 https://a.test/", "2/3 https://down.test/", "3/3 https://c.test/"]);
  assert.deepEqual(ctx.opened.map((p) => p.url()), ["https://a.test/", "about:blank", "https://c.test/"]);
  assert.deepEqual(screen.marks.map(([i, state, n]) => `${i}:${state}:${n}`), ["0:opening:0", "0:open:1", "1:opening:1", "1:failed:2", "2:opening:2", "2:open:3"]);
  assert.deepEqual(logs, ["restore https://down.test/: net::ERR_FAILED"]);
  assert.match(screen.html, /Opening tabs/);
  assert.ok(screen.closed, "the loading screen closes at the end");
  assert.ok(ctx.opened[2].fronted > 0 && ctx.opened[2].fronted >= Math.max(ctx.opened[0].fronted, ctx.opened[1].fronted));
});

test("nothing saved: a given loading screen is just closed", async () => {
  const given = fakePage("about:blank");
  const ctx = fakeContext([]);
  await restoreTabs(ctx, { tabs: [], active: 0 }, { screen: given });
  assert.ok(given.closed);
  assert.equal(ctx.opened.length, 0);
});
