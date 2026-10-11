// The session picker is up in the browser's first tab. An agent that chooses the open session
// (pairbrowse_session use) answers it for everyone: the picker goes, and the session's saved tabs
// come back as they would after the person's pick.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 10_000) => { for (let i = 0; i < ms / 50 && !check(); i++) await sleep(50); return check(); };

test("an agent choosing the open session while the picker shows resolves the pick and reopens its tabs", { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pb-pick-"));
  process.env.PAIRBROWSE_HOME = home;
  writeFileSync(join(home, "config.json"), "{}");
  mkdirSync(join(home, "run"), { recursive: true });
  mkdirSync(join(home, "profile", "Default"), { recursive: true }); // a browser ran before: something to go back to
  writeFileSync(join(home, "tabs.json"), JSON.stringify({ tabs: [{ url: "https://shop.example/orders", title: "Orders" }], active: 0 }));
  const { createContext } = await import("../scripts/daemon/context.mjs");
  const visited = []; // every address any tab went to
  const fakePage = (ctx) => {
    const page = {
      on() {}, once() {}, listeners: () => [], isClosed: () => false, context: () => ctx,
      url: () => page.at, goto: async (url) => { page.at = url; visited.push(url); }, close: async () => {},
      bringToFront: async () => {}, setContent: async () => {}, evaluate: async () => {},
      at: "about:blank",
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
    pages.push(fakePage(ctx)); // the browser's first tab, where the picker shows
    return ctx;
  };
  const chromium = { launchPersistentContext: async () => fakeContext() };
  const quiet = () => {};
  const context = createContext({
    config: { browserEngine: "chromium", executablePath: "/fake/chrome", display: "none" }, log: quiet, chromium,
    hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
    presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
    shuttingDown: () => false, onStarted: quiet, onClosed: quiet,
  });
  await context.getContext();
  assert.equal(context.picking(), true, "the picker shows instead of the saved tabs");
  assert.ok(await until(() => visited.some((u) => /picker\.html$/.test(u))), "the first tab shows the picker");
  const pick = context.waitForPick(); // an agent's first action waits for the pick

  const r = await context.sessionCommand({ action: "use", name: "default" });
  assert.ok(!r.error, r.text);
  assert.equal(context.picking(), false, "the picker is answered");
  assert.match(await pick, /chosen by an agent/, "waiting agents hear the agent chose");
  assert.ok(await until(() => visited.includes("https://shop.example/orders")), "the saved tabs come back");
  assert.ok(await until(() => !context.isRestoring()), "the restore finishes");
  assert.equal(visited.filter((u) => /picker\.html$/.test(u)).length, 1, "no second picker");
});

// A build with its own pages: the helper's address and the pages' key go in one launch switch
// (never in a log line), the picker is the browser's own page, no side panel worker is reset, and
// the docks' layout lands in the profile. An agent's choice still answers the pick.
test("a build with its own pages launches with the helper switch and shows its own picker", { timeout: 30_000 }, async () => {
  // The first test set the home (paths.mjs reads it once): the same one, a new browser.
  const home = process.env.PAIRBROWSE_HOME;
  const { createContext } = await import("../scripts/daemon/context.mjs");
  const { readJson } = await import("../scripts/util.mjs");
  const { randomBytes } = await import("node:crypto");
  const KEY = randomBytes(32).toString("base64url");
  rmSync(join(home, "profile", "PairBrowse panel build"), { force: true });
  rmSync(join(home, "profile", "Default", "Preferences"), { force: true }); // the first browser's theme settings
  const visited = [];
  const launches = [];
  const fakePage = (ctx) => {
    const page = {
      on() {}, once() {}, listeners: () => [], isClosed: () => false, context: () => ctx,
      url: () => page.at, goto: async (url) => { page.at = url; visited.push(url); }, close: async () => {},
      bringToFront: async () => {}, setContent: async () => {}, evaluate: async () => {},
      at: "about:blank",
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
  const chromium = { launchPersistentContext: async (dir, opts) => { launches.push({ dir, opts }); return fakeContext(); } };
  const quiet = () => {};
  const lines = [];
  const context = createContext({
    config: { browserEngine: "chromium", executablePath: "/fake/chrome", display: "none" }, log: (...a) => lines.push(a.join(" ")), chromium,
    hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
    presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
    shuttingDown: () => false, onStarted: quiet, onClosed: quiet,
    chromePagesOf: () => true, helperFor: async () => ({ origin: "http://127.0.0.1:4321", key: KEY }),
  });
  await context.getContext();
  assert.equal(context.chromePages(), true);
  const args = launches[0].opts.args;
  assert.ok(args.includes(`--pairbrowse-helper=http://127.0.0.1:4321#${KEY}`));
  assert.ok(!args.some((a) => a.startsWith("--load-extension=")));
  assert.equal(context.picking(), true);
  assert.ok(await until(() => visited.includes("chrome://pairbrowse/picker")), "the first tab shows the browser's own picker");
  assert.ok(!visited.some((u) => /picker\.html$/.test(u)), "never the extension's picker");
  assert.ok(!lines.some((l) => l.includes(KEY)), "the key is never logged");
  assert.equal(existsSync(join(home, "profile", "PairBrowse panel build")), false, "no side panel worker reset");
  const prefs = readJson(join(home, "profile", "Default", "Preferences"), {});
  assert.deepEqual(prefs.pairbrowse.layout, { left: "open", right: "open", strip: 88 });
  assert.equal(prefs.extensions?.theme, undefined, "no theme seed");
  const pick = context.waitForPick();
  const r = await context.sessionCommand({ action: "use", name: "default" });
  assert.ok(!r.error, r.text);
  assert.equal(context.picking(), false);
  assert.match(await pick, /chosen by an agent/);
});

// A live view that cannot start (port taken): helperFor throws, the launch logs it, and the browser
// still opens, without the switch.
test("a build with its own pages still opens when the live view cannot start", { timeout: 30_000 }, async () => {
  const { createContext } = await import("../scripts/daemon/context.mjs");
  const launches = [];
  const fakeContext = () => {
    const ctx = new EventEmitter();
    const pages = [];
    const page = {
      on() {}, once() {}, listeners: () => [], isClosed: () => false, context: () => ctx,
      url: () => page.at, goto: async (url) => { page.at = url; }, close: async () => {},
      bringToFront: async () => {}, setContent: async () => {}, evaluate: async () => {},
      at: "about:blank",
    };
    pages.push(page);
    ctx.pages = () => pages;
    ctx.addInitScript = async () => {};
    ctx.newPage = async () => page;
    ctx.browser = () => null;
    ctx.close = async () => { ctx.emit("close"); };
    return ctx;
  };
  const chromium = { launchPersistentContext: async (dir, opts) => { launches.push({ dir, opts }); return fakeContext(); } };
  const quiet = () => {};
  const lines = [];
  const log = (...a) => lines.push(a.join(" "));
  const context = createContext({
    config: { browserEngine: "chromium", executablePath: "/fake/chrome", display: "none" }, log, chromium,
    hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
    presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
    shuttingDown: () => false, onStarted: quiet, onClosed: quiet,
    chromePagesOf: () => true,
    helperFor: async () => { throw new Error("port taken"); },
  });
  await context.getContext();
  const args = launches[0].opts.args;
  assert.ok(!args.some((a) => a.startsWith("--pairbrowse-helper=")), "no helper switch");
  assert.ok(lines.includes("the browser's own pages have no helper address"));
  assert.ok(lines.includes("live view port taken"));
});

// The helper's timers (tab memory, picker) keep running: the run ends here.
after(() => setImmediate(() => process.exit(process.exitCode || 0)));
