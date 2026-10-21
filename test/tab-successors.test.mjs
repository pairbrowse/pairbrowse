// A tab's identity across a browser restart (scripts/daemon/browser/tabs.mjs notePlaces,
// successorOf): each saved tab's place comes from the tab tracker's last save, so after a crash,
// when the browser lists no tabs any more, each tab that comes back is still the successor of the
// one in its place (an agent's tab is its own again: serve/turns.mjs myTab). The live check is
// test/integration/server-display.test.mjs ("browser killed").
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createTabs } from "../scripts/daemon/browser/tabs.mjs";
import { createBrowserState } from "../scripts/daemon/browser/state.mjs";
import { tabsFile } from "../scripts/sessions.mjs";
import { trackTabs } from "../scripts/tabs.mjs";

function fakePage(url) {
  const p = new EventEmitter();
  const frame = {};
  Object.assign(p, {
    _url: url, closed: false,
    url: () => p._url, isClosed: () => p.closed, title: async () => "", mainFrame: () => frame,
    goto: async (u) => { p._url = u; }, bringToFront: async () => {}, close: async () => { p.closed = true; },
    waitForLoadState: async () => {},
  });
  return p;
}
function fakeContext(pages) {
  const ctx = new EventEmitter();
  ctx.pages = () => pages.filter((p) => !p.closed);
  ctx.newPage = async () => { const p = fakePage("about:blank"); pages.push(p); return p; };
  return ctx;
}

test("after a crash each tab that comes back is the successor of the saved tab in its place", async () => {
  const st = createBrowserState({ session: "default", pick: { state: "off" } });
  st.ownPages = true; // no progress page
  const tabs = createTabs(st, { config: {}, hostNote: () => {}, hud: { badge: () => "" }, log: () => {}, onTabClosed: () => {}, personTabs: new Set(), popups: null, presence: null, status: () => {} }, {});
  // The crashed browser: its tabs are all closed, and it lists none.
  const oldA = fakePage("https://a.test/"), oldB = fakePage("https://b.test/"), stray = fakePage("https://c.test/");
  for (const p of [oldA, oldB, stray]) p.closed = true;
  st.tabTracker = { pages: () => [oldA, oldB] };
  tabs.notePlaces();
  mkdirSync(dirname(tabsFile("default")), { recursive: true });
  writeFileSync(tabsFile("default"), JSON.stringify({ tabs: [{ url: "https://a.test/" }, { url: "https://b.test/" }], active: 1 }));
  assert.equal(tabs.successorOf(oldA), null, "nothing yet before the tabs come back");

  const pages = [fakePage("about:blank")];
  const ctx = fakeContext(pages);
  st.contextPromise = Promise.resolve(ctx);
  tabs.restore(ctx, null, { own: true });
  await st.restoring;
  const [newA, newB] = pages.slice(1);
  assert.equal(newA.url(), "https://a.test/");
  assert.equal(tabs.successorOf(oldA), newA, "a's place: a again");
  assert.equal(tabs.successorOf(oldB), newB, "b's place: b again, never a");
  assert.equal(tabs.successorOf(stray), null, "a tab that wasn't saved has none");
  assert.equal(tabs.successorOf(newA), null, "an open tab is its own");
  st.tabTracker?.stop?.();
});

const makeTabs = (st) => createTabs(st, { config: {}, hostNote: () => {}, hud: { badge: () => "" }, log: () => {}, onTabClosed: () => {}, personTabs: new Set(), popups: null, presence: null, status: () => {} }, {});
const crash = (ctx, pages) => { for (const p of pages) if (!p.closed) { p.closed = true; p.emit("close"); } ctx.emit("close"); };
const saveFile = (urls) => { mkdirSync(dirname(tabsFile("default")), { recursive: true }); writeFileSync(tabsFile("default"), JSON.stringify({ tabs: urls.map((url) => ({ url })), active: 0 })); };

// launch.mjs's close handler is on before the tracker's whenever the tabs come back later (the
// session picker): the places noted are still those of the save the crash makes.
test("a crash right after a person closed a tab: the places are the crash's save, whichever close handler runs first", async () => {
  const st = createBrowserState({ session: "default", pick: { state: "off" } });
  st.ownPages = true;
  const tabs = makeTabs(st);
  const [a, b, c] = ["https://a.test/", "https://b.test/", "https://c.test/"].map(fakePage);
  const ctx = fakeContext([a, b, c]);
  ctx.on("close", () => tabs.notePlaces()); // launch's handler, on first
  mkdirSync(dirname(tabsFile("default")), { recursive: true });
  st.tabTracker = trackTabs(ctx, { file: tabsFile("default") });
  await st.tabTracker.saveNow(); // the last save: a, b, c
  b.closed = true; b.emit("close"); // the person closes b: a save is due in 1.5 s
  const realNow = Date.now;
  Date.now = () => realNow() + 1200; // the crash comes 1.2 s later, before that save
  try { crash(ctx, [a, b, c]); } finally { Date.now = realNow; }

  const pages = [fakePage("about:blank")];
  const ctx2 = fakeContext(pages);
  st.contextPromise = Promise.resolve(ctx2);
  tabs.restore(ctx2, null, { own: true });
  await st.restoring;
  const back = pages.slice(1);
  assert.deepEqual(back.map((p) => p.url()), ["https://a.test/", "https://c.test/"], "b stays closed");
  assert.equal(tabs.successorOf(c), back[1], "c's place: c");
  assert.equal(tabs.successorOf(b), null, "b came back as nothing, never as c");
  st.tabTracker?.stop?.();
});

test("a second crash while the saved tabs come back: each tab back so far, and each one not back yet, finds its successor", async () => {
  const st = createBrowserState({ session: "default", pick: { state: "off" } });
  st.ownPages = true;
  const tabs = makeTabs(st);
  saveFile(["https://a.test/", "https://b.test/", "https://c.test/"]);
  const old = ["https://a.test/", "https://b.test/", "https://c.test/"].map(fakePage);
  for (const p of old) p.closed = true;
  st.tabTracker = { pages: () => old };
  tabs.notePlaces(); // the first crash

  // The tabs come back; the third never opens, and the browser crashes again meanwhile.
  const pages1 = [fakePage("about:blank")];
  const ctx1 = fakeContext(pages1);
  const newPage = ctx1.newPage;
  let opened = 0;
  ctx1.newPage = () => (++opened > 2 ? new Promise(() => {}) : newPage());
  ctx1.on("close", () => tabs.notePlaces());
  tabs.restore(ctx1, null, { own: true });
  for (let n = 0; n < 50 && opened < 3; n++) await new Promise((r) => setImmediate(r));
  const [a1, b1] = pages1.slice(1);
  assert.equal(opened, 3, "two tabs back, the third opening");
  crash(ctx1, pages1);

  const pages2 = [fakePage("about:blank")];
  const ctx2 = fakeContext(pages2);
  tabs.restore(ctx2, null, { own: true });
  await st.restoring;
  const [a2, b2, c2] = pages2.slice(1);
  assert.equal(tabs.successorOf(old[0]), a2, "a, through the tab it came back as first");
  assert.equal(tabs.successorOf(a1), a2);
  assert.equal(tabs.successorOf(b1), b2);
  assert.equal(tabs.successorOf(old[2]), c2, "c never came back the first time: its place still waits");
  st.tabTracker?.stop?.();
});

test("without a tracker (no browser yet) nothing is noted", () => {
  const st = createBrowserState({ session: "default", pick: { state: "off" } });
  const tabs = createTabs(st, { config: {}, hostNote: () => {}, hud: { badge: () => "" }, log: () => {}, onTabClosed: () => {}, personTabs: new Set(), popups: null, presence: null, status: () => {} }, {});
  assert.doesNotThrow(() => tabs.notePlaces());
});

// The wiring, read from the source (it needs a real browser): the close handler notes the places
// on a crash (a switch noted them before it closed the browser); a resumed connection keeps its
// closed tab, and myTab waits for the saved tabs before it looks for that tab's successor.
test("a crash notes the places; a resumed agent finds its tab's successor once the tabs are back", async () => {
  const { readFileSync } = await import("node:fs");
  const src = (p) => readFileSync(new URL(`../scripts/daemon/${p}`, import.meta.url), "utf8");
  const launch = src("browser/launch.mjs");
  const handler = launch.slice(launch.indexOf('ctx.on("close", () => {'));
  assert.ok(handler.indexOf("if (!st.switching && st.contextPromise === mine) api.notePlaces?.();") >= 0 && handler.indexOf("api.notePlaces") < handler.indexOf("st.contextPromise = null"), "noted before the browser is forgotten");
  const serve = src("serve.mjs");
  assert.match(serve, /page: hud\.sparkPage\(participant\) \|\| conn\.mine \|\| null/, "a crash clears the sparks first: the connection's own tab is held");
  assert.match(serve, /if \(back\.page\) conn\.mine = back\.page;/, "kept closed: myTab finds what it came back as");
  const turns = src("serve/turns.mjs");
  const mine = turns.slice(turns.indexOf("async function myTab()"));
  assert.ok(mine.indexOf("await context.ready?.();") >= 0 && mine.indexOf("await context.ready?.();") < mine.indexOf("context.successorOf?.(p)"), "the saved tabs back first");
});
