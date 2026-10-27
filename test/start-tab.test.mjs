// The start tab's own first load (daemon/browser/tabs.mjs startTabLoaded): a build with its own
// pages opens its new tab page in the first tab, and on a slow machine that page's late load cut
// off an agent's first browser_navigate. The first agent call waits for it (ready(), bounded), and
// a browser_navigate cut off on the untouched new tab page goes once more (retryAborted), never
// when the page went elsewhere or a download started.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { startTabLoaded, retryAborted, downloadStartedAt, isOwnNewTab, createTabs, START_LOAD_MS } from "../scripts/daemon/browser/tabs.mjs";
import { testHome } from "./helpers/home.mjs";

// A tab whose new tab page commits after commitMs and loads loadMs after that (never: Infinity).
function lateTab({ commitMs = 0, loadMs = 0, url = "chrome://pairbrowse/newtab/" } = {}) {
  const t0 = Date.now();
  const page = new EventEmitter();
  page.closed = false;
  page.isClosed = () => page.closed;
  page.url = () => (page.moved ?? (Date.now() - t0 >= commitMs ? url : "about:blank"));
  page.waitForLoadState = (state, { timeout } = {}) => new Promise((resolve, reject) => {
    const left = commitMs + loadMs - (Date.now() - t0);
    if (!Number.isFinite(left)) return void setTimeout(() => reject(new Error(`Timeout ${timeout}ms exceeded`)), timeout);
    setTimeout(resolve, Math.max(0, left));
  });
  return page;
}

test("the new tab page as the start tab shows it, under either build's address", () => {
  for (const url of ["chrome://newtab/", "chrome://pairbrowse/newtab/", "chrome://new-tab-page/", "chrome://new-tab-page", "chrome-extension://adfagmfalfjdenlggodhkedeopijpbkf/newtab/index.html"]) assert.equal(isOwnNewTab(url), true, url);
  for (const url of ["about:blank", "", "chrome://pairbrowse/picker", "https://new-tab-page/", "chrome://new-tab-page/more", "chrome://settings", "chrome-extension://adfagmfalfjdenlggodhkedeopijpbkf/picker/index.html", "https://x.test/chrome-extension://adfagmfalfjdenlggodhkedeopijpbkf/newtab/index.html"]) assert.equal(isOwnNewTab(url), false, url);
});

test("the start tab is waited for until its new tab page has committed and loaded", async () => {
  const t0 = Date.now();
  assert.equal(await startTabLoaded(lateTab({ commitMs: 300, loadMs: 400 }), { every: 20 }), "loaded");
  assert.ok(Date.now() - t0 >= 650, `waited for the late load (${Date.now() - t0} ms)`);
  // Already there: at once.
  const t1 = Date.now();
  assert.equal(await startTabLoaded(lateTab()), "loaded");
  assert.ok(Date.now() - t1 < 200);
});

test("the wait is bounded, and ends when the tab goes elsewhere or closes", async () => {
  // Never commits, and commits but never loads: each gives up after ms, not later.
  for (const page of [lateTab({ commitMs: Infinity }), lateTab({ loadMs: Infinity })]) {
    const t0 = Date.now();
    assert.equal(await startTabLoaded(page, { ms: 400, every: 20 }), "timeout");
    const took = Date.now() - t0;
    assert.ok(took >= 350 && took < 1200, `bounded (${took} ms)`);
  }
  // A page whose load state never answers at all (a stuck page): still bounded.
  const stuck = lateTab();
  stuck.waitForLoadState = () => new Promise(() => {});
  const t2 = Date.now();
  assert.equal(await startTabLoaded(stuck, { ms: 300 }), "timeout");
  assert.ok(Date.now() - t2 < 1000);
  // The picker or a person's address in it: nothing of the start's own to wait for.
  const picker = lateTab({ url: "chrome://pairbrowse/picker" });
  assert.equal(await startTabLoaded(picker), "elsewhere");
  const closed = lateTab({ commitMs: 200 });
  setTimeout(() => { closed.closed = true; }, 60);
  assert.equal(await startTabLoaded(closed, { every: 20 }), "closed");
  assert.equal(START_LOAD_MS, 5000);
});

test("browser_navigate goes once more only when cut off on the untouched new tab page", async () => {
  const raw = "### Error\nError: page.goto: net::ERR_ABORTED at https://shop.example/\nCall log:";
  const sentAt = Date.now();
  const page = lateTab();
  assert.equal(retryAborted({ tool: "browser_navigate", raw, page, sentAt }), true, "the start tab's own load cut it off");
  assert.equal(retryAborted({ tool: "browser_navigate", raw, page: lateTab({ url: "chrome://newtab/" }), sentAt }), true);
  // Cut off before the new tab page itself committed: the tab shows nothing yet.
  assert.equal(retryAborted({ tool: "browser_navigate", raw, page: lateTab({ commitMs: Infinity }), sentAt }), true);
  // Never twice, never another tool or another error, never without knowing when it went out.
  assert.equal(retryAborted({ tool: "browser_navigate", raw, page, sentAt, retried: true }), false);
  assert.equal(retryAborted({ tool: "browser_click", raw, page, sentAt }), false);
  assert.equal(retryAborted({ tool: "browser_navigate", raw: "net::ERR_NAME_NOT_RESOLVED", page, sentAt }), false);
  assert.equal(retryAborted({ tool: "browser_navigate", raw, page, sentAt: undefined }), false);
  assert.equal(retryAborted({ tool: "browser_navigate", raw, page: null, sentAt }), false);
  // The page really sent the browser elsewhere: the tab shows another address.
  const moved = lateTab();
  moved.moved = "https://elsewhere.example/";
  assert.equal(retryAborted({ tool: "browser_navigate", raw, page: moved, sentAt }), false);
  // A closed tab.
  const gone = lateTab();
  gone.closed = true;
  assert.equal(retryAborted({ tool: "browser_navigate", raw, page: gone, sentAt }), false);
});

test("a download started in the tab since the call went out: never sent again", () => {
  const tabs = createTabs({ restoring: null }, { config: {}, hostNote() {}, hud: { onPageLoad() {} }, log() {}, onTabClosed() {}, personTabs: new Set(), popups: { watchPage() {} }, presence: { watchUser() {} }, status() {} }, { keepDownloads() {} });
  const page = lateTab();
  page.listeners = () => [];
  const sentAt = Date.now();
  tabs.adopt(page, null);
  assert.equal(downloadStartedAt(page), 0);
  page.emit("download", {});
  assert.ok(downloadStartedAt(page) >= sentAt);
  const raw = "page.goto: net::ERR_ABORTED";
  assert.equal(retryAborted({ tool: "browser_navigate", raw, page, sentAt }), false, "a download: the abort was the browser saving a file");
  // One long before the call doesn't count.
  assert.equal(retryAborted({ tool: "browser_navigate", raw, page, sentAt: Date.now() + 60_000 }), true);
});

// The helper's own path: a build with its own pages, its start tab's new tab page late, and the
// first agent call (ready()) held until that page loaded, not only until the tab exists.
test("the first agent call waits for the start tab's own late load", { timeout: 30_000 }, async () => {
  writeFileSync(join(testHome, "config.json"), JSON.stringify({ sessionPicker: false }));
  mkdirSync(join(testHome, "run"), { recursive: true });
  const { createContext } = await import("../scripts/daemon/context.mjs");
  let first = null;
  const fakeContext = () => {
    const ctx = new EventEmitter();
    first = Object.assign(lateTab({ commitMs: 400, loadMs: 600 }), {
      listeners: () => [], context: () => ctx, goto: async () => {}, close: async () => {}, bringToFront: async () => {}, evaluate: async () => {},
    });
    ctx.pages = () => [first];
    ctx.addInitScript = async () => {};
    ctx.newPage = async () => first;
    ctx.browser = () => null;
    ctx.close = async () => { ctx.emit("close"); };
    return ctx;
  };
  const quiet = () => {};
  const lines = [];
  const context = createContext({
    config: { browserEngine: "chromium", executablePath: "/fake/chrome", display: "none", sessionPicker: false }, log: (...a) => lines.push(a.join(" ")),
    chromium: { launchPersistentContext: async () => fakeContext() },
    hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
    presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
    shuttingDown: () => false, onStarted: quiet, onClosed: quiet,
    browserPagesOf: () => true, helperFor: async () => null,
  });
  const t0 = Date.now();
  await context.getContext();
  const launched = Date.now() - t0;
  await context.ready();
  const waited = Date.now() - t0;
  assert.ok(waited >= 950, `ready() came once the start tab's page loaded (${waited} ms, launch ${launched} ms)`);
  assert.ok(lines.some((l) => /launch: start tab loaded after \d+ ms/.test(l)), lines.join("\n"));
  // Later calls: at once.
  const t1 = Date.now();
  await context.ready();
  assert.ok(Date.now() - t1 < 100);
  await context.close({ restoreWaitMs: 0 });
});
