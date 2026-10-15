// The session picker is up in the browser's first tab. An agent that chooses the open session
// (pairbrowse_session use) answers it for everyone: the picker goes, and the session's saved tabs
// come back as they would after the person's pick.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
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
  assert.ok(await until(() => visited.some((u) => /picker\/index\.html$/.test(u))), "the first tab shows the picker");
  const pick = context.waitForPick(); // an agent's first action waits for the pick

  const r = await context.sessionCommand({ action: "use", name: "default" });
  assert.ok(!r.error, r.text);
  assert.equal(context.picking(), false, "the picker is answered");
  assert.match(await pick, /chosen by an agent/, "waiting agents hear the agent chose");
  assert.ok(await until(() => visited.includes("https://shop.example/orders")), "the saved tabs come back");
  assert.ok(await until(() => !context.isRestoring()), "the restore finishes");
  assert.equal(visited.filter((u) => /picker\/index\.html$/.test(u)).length, 1, "no second picker");
});

// A build with its own pages: the helper's address goes in its launch switch and the pages' key in
// an owner-only file under run/ named by the other switch (neither key nor path in a log line), the picker is the browser's own page, no side panel worker is reset, and
// the docks' layout lands in the profile. An agent's choice still answers the pick.
test("a build with its own pages launches with the helper switches and shows its own picker", { timeout: 30_000 }, async () => {
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
  assert.ok(args.includes("--pairbrowse-helper=http://127.0.0.1:4321"));
  const keyFile = args.find((a) => a.startsWith("--pairbrowse-helper-key-file="))?.slice("--pairbrowse-helper-key-file=".length);
  assert.ok(keyFile, "the key file's switch");
  assert.equal(dirname(keyFile), join(home, "run"));
  assert.equal(readFileSync(keyFile, "utf8"), KEY, "the key alone");
  if (process.platform !== "win32") assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  assert.ok(!args.some((a) => a.includes(KEY)), "the key is never a launch argument");
  assert.ok(!args.some((a) => a.startsWith("--load-extension=")));
  assert.equal(context.picking(), true);
  assert.ok(await until(() => visited.includes("chrome://pairbrowse/picker")), "the first tab shows the browser's own picker");
  assert.ok(!visited.some((u) => /picker\.html$/.test(u)), "never the extension's picker");
  assert.ok(!lines.some((l) => l.includes(KEY)), "the key is never logged");
  assert.ok(!lines.some((l) => l.includes(keyFile)), "nor the key file's path");
  assert.equal(existsSync(join(home, "profile", "PairBrowse panel build")), false, "no side panel worker reset");
  const prefs = readJson(join(home, "profile", "Default", "Preferences"), {});
  assert.deepEqual(prefs.pairbrowse.layout, { left: "open", right: "open", strip: 88 });
  assert.equal(prefs.extensions?.theme, undefined, "no theme seed");
  const pick = context.waitForPick();
  const r = await context.sessionCommand({ action: "use", name: "default" });
  assert.ok(!r.error, r.text);
  assert.equal(context.picking(), false);
  assert.match(await pick, /chosen by an agent/);
  // The pages used their key: the file goes, once.
  context.dropHelperKey();
  assert.ok(!existsSync(keyFile));
  assert.doesNotThrow(() => context.dropHelperKey());
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
  assert.ok(!args.some((a) => a.startsWith("--pairbrowse-helper-key-file=")), "no key file switch");
  assert.ok(lines.includes("the browser's own pages have no helper address"));
  assert.ok(lines.includes("live view port taken"));
});

// A recorded browser other than the PairBrowse browser: the helper's log says once per run that
// nothing is downloaded or installed (the wording is native-install.mjs notChosen's, whose chromium
// form test/native-install.test.mjs checks), and a second launch doesn't repeat it.
test("a recorded browser of your own logs once that nothing is downloaded or installed", { timeout: 30_000 }, async () => {
  const { createContext } = await import("../scripts/daemon/context.mjs");
  const { notChosen } = await import("../scripts/native-install.mjs");
  assert.equal(notChosen({ browser: "chromium" }, true), "browser is chromium in ~/.pairbrowse/config.json: nothing to download or install");
  assert.equal(notChosen({ browser: "pairbrowse" }, true), null);
  assert.equal(notChosen({}, true), null);
  let launched = 0;
  const fakeContext = () => {
    const ctx = new EventEmitter();
    const page = {
      on() {}, once() {}, listeners: () => [], isClosed: () => false, context: () => ctx,
      url: () => page.at, goto: async (url) => { page.at = url; }, close: async () => {},
      bringToFront: async () => {}, setContent: async () => {}, evaluate: async () => {},
      at: "about:blank",
    };
    ctx.pages = () => [page];
    ctx.addInitScript = async () => {};
    ctx.newPage = async () => page;
    ctx.browser = () => null;
    ctx.close = async () => { ctx.emit("close"); };
    return ctx;
  };
  const chromium = { launchPersistentContext: async () => { launched++; return fakeContext(); } };
  const quiet = () => {};
  const lines = [];
  const context = createContext({
    config: { browser: "/bin/sh", display: "none", sessionPicker: false }, log: (...a) => lines.push(a.join(" ")), chromium,
    hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
    presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
    shuttingDown: () => false, onStarted: quiet, onClosed: quiet,
  });
  const line = "browser is a browser of your own in ~/.pairbrowse/config.json: nothing to download or install";
  const first = await context.getContext();
  assert.equal(lines.filter((l) => l === line).length, 1, "said once at the first launch");
  assert.ok(!lines.some((l) => l.startsWith("browser: no choice recorded")), "a recorded choice isn't the unset one");
  await first.close();
  await context.getContext();
  assert.equal(launched, 2, "launched again");
  assert.equal(lines.filter((l) => l === line).length, 1, "not repeated at the second launch");
});

// Each launch has its own key file: a session switch drops the old browser's file with it, a late
// close of the old browser never drops the new one's, a failed launch and the helper's close leave none.
test("the key file goes with its browser, never with the next one", { timeout: 30_000 }, async () => {
  const home = process.env.PAIRBROWSE_HOME;
  const { createContext } = await import("../scripts/daemon/context.mjs");
  const { randomBytes } = await import("node:crypto");
  const KEY = randomBytes(32).toString("base64url");
  const contexts = [];
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
    contexts.push(ctx);
    return ctx;
  };
  let failing = false;
  const chromium = { launchPersistentContext: async (dir, opts) => { launches.push(opts.args); if (failing) throw new Error("no browser"); return fakeContext(); } };
  const quiet = () => {};
  const lines = [];
  const context = createContext({
    config: { browserEngine: "chromium", executablePath: "/fake/chrome", display: "none" }, log: (...a) => lines.push(a.join(" ")), chromium,
    hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
    presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
    shuttingDown: () => false, onStarted: quiet, onClosed: quiet,
    chromePagesOf: () => true, helperFor: async () => ({ origin: "http://127.0.0.1:4321", key: KEY }),
  });
  const fileOf = (args) => args.find((a) => a.startsWith("--pairbrowse-helper-key-file="))?.slice("--pairbrowse-helper-key-file=".length);
  const keyFiles = () => readdirSync(join(home, "run")).filter((f) => f.startsWith("helper-key-"));
  await context.getContext();
  const f1 = fileOf(launches[0]);
  assert.ok(f1 && existsSync(f1), "launch 1's file");
  const r = await context.sessionCommand({ action: "new", name: "keyfile-b" });
  assert.ok(!r.error, r.text);
  const f2 = fileOf(launches[1]);
  assert.ok(!existsSync(f1), "launch 1's file went with its browser");
  assert.ok(f2 && f2 !== f1 && existsSync(f2), "launch 2 has a file of its own");
  contexts[0].emit("close"); // the old browser closing late
  assert.ok(existsSync(f2), "a late close of the old browser keeps the new one's file");
  contexts[1].emit("close");
  assert.ok(!existsSync(f2), "launch 2's file went with its browser");
  failing = true;
  await assert.rejects(context.getContext());
  assert.deepEqual(keyFiles(), [], "a failed launch leaves no key file");
  failing = false;
  // Back to the default session (later files read the current one), then the helper stops.
  const back = await context.sessionCommand({ action: "use", name: "default" });
  assert.ok(!back.error, back.text);
  assert.equal(keyFiles().length, 1);
  await context.close();
  assert.deepEqual(keyFiles(), [], "the helper's close leaves no key file");
  assert.ok(!lines.some((l) => l.includes(KEY) || l.includes("helper-key-")), "neither the key nor a key file's path is logged");
});

// The helper's timers (tab memory, picker) keep running: the run ends here.
after(() => setImmediate(() => process.exit(process.exitCode || 0)));

// A build whose capture page reads its own key: a new one each launch, in an owner-only file of
// its own named by --pairbrowse-capture-key-file; the key never on the command line, and both
// files go once the browser's pages used their key. A build whose capture page reads none gets none.
test("the capture page's own key: its own file and switch, new at each launch, only for a build that reads it", { timeout: 30_000 }, async () => {
  const home = process.env.PAIRBROWSE_HOME;
  const { createContext } = await import("../scripts/daemon/context.mjs");
  const { randomBytes } = await import("node:crypto");
  const fakePage = (ctx) => { const page = { on() {}, once() {}, listeners: () => [], isClosed: () => false, context: () => ctx, url: () => page.at, goto: async (u) => { page.at = u; }, close: async () => {}, bringToFront: async () => {}, setContent: async () => {}, evaluate: async () => {}, at: "about:blank" }; return page; };
  const fakeContext = () => { const ctx = new EventEmitter(); const pages = [fakePage(ctx)]; Object.assign(ctx, { pages: () => pages, addInitScript: async () => {}, newPage: async () => { const p = fakePage(ctx); pages.push(p); return p; }, browser: () => null, close: async () => { ctx.emit("close"); } }); return ctx; };
  const quiet = () => {};
  const run = async (keyed) => {
    const launches = [], keys = [];
    const context = createContext({
      config: { browserEngine: "chromium", executablePath: "/fake/chrome", display: "none" }, log: quiet,
      chromium: { launchPersistentContext: async (dir, opts) => { launches.push(opts); return fakeContext(); } },
      hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
      presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
      shuttingDown: () => false, onStarted: quiet, onClosed: quiet,
      chromePagesOf: () => true, capturePagesOf: () => true, captureKeyedOf: () => keyed,
      helperFor: async () => ({ origin: "http://127.0.0.1:4321", key: randomBytes(32).toString("base64url"), newCaptureKey: (on) => { const k = on ? randomBytes(32).toString("base64url") : null; keys.push(k); return k; } }),
    });
    await context.getContext();
    return { args: launches[0].args, keys, context };
  };
  const plain = await run(false);
  assert.ok(!plain.args.some((a) => a.startsWith("--pairbrowse-capture-key-file=")), "a build that reads none gets none");
  assert.deepEqual(plain.keys, [null]);
  await plain.context.close?.();
  const keyed = await run(true);
  const file = keyed.args.find((a) => a.startsWith("--pairbrowse-capture-key-file="))?.slice("--pairbrowse-capture-key-file=".length);
  assert.ok(file, "the switch");
  const pagesFile = keyed.args.find((a) => a.startsWith("--pairbrowse-helper-key-file="))?.slice("--pairbrowse-helper-key-file=".length);
  assert.notEqual(file, pagesFile, "a file of its own");
  assert.equal(dirname(file), join(home, "run"));
  assert.equal(readFileSync(file, "utf8"), keyed.keys[0], "the key alone");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(existsSync(pagesFile), "writing one never removes the other");
  assert.ok(!keyed.args.some((a) => a.includes(keyed.keys[0])), "never a launch argument");
  keyed.context.dropHelperKey();
  assert.equal(existsSync(file), false, "gone with the pages' key file");
  assert.equal(existsSync(pagesFile), false);
  await keyed.context.close?.();
});

// pairbrowse_session delete: never a session a browser has open (its profile's lock), nor while
// the browser switches; otherwise its files go.
test("a session open in another browser isn't deleted", { timeout: 30_000 }, async () => {
  const { createContext } = await import("../scripts/daemon/context.mjs");
  const s = await import("../scripts/sessions.mjs");
  const { symlinkSync, rmSync: rm } = await import("node:fs");
  const { hostname } = await import("node:os");
  const quiet = () => {};
  const context = createContext({
    config: { browserEngine: "chromium", executablePath: "/fake/chrome", display: "none" }, log: quiet, chromium: { launchPersistentContext: async () => { throw new Error("no browser here"); } },
    hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
    presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
    shuttingDown: () => false, onStarted: quiet, onClosed: quiet,
  });
  s.createSession("old-one");
  const lock = join(s.profileDir("old-one"), "SingletonLock");
  symlinkSync(`${hostname()}-${process.pid}`, lock); // this very process: alive
  const r = await context.sessionCommand({ action: "delete", name: "old-one" });
  assert.equal(r.error, true);
  assert.match(r.text, /open in another browser/);
  assert.ok(existsSync(s.profileDir("old-one")), "kept");
  rm(lock);
  const ok = await context.sessionCommand({ action: "delete", name: "old-one" });
  assert.ok(!ok.error, ok.text);
  assert.equal(existsSync(s.profileDir("old-one")), false);
});
