// Which browser the helper launches (scripts/browser/choice.mjs): one pure choice of binary and
// shell, never written back into config; the launch options built once (browser.mjs launchOptions)
// for the helper and the install self-check; and "something to go back to" seen in either profile.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

// A home of its own before any module reads one (paths.mjs reads PAIRBROWSE_HOME as it loads): the
// project's modules are imported only after this line.
const home = mkdtempSync(join(tmpdir(), "pb-choice-"));
process.env.PAIRBROWSE_HOME = home;
const { chooseBrowser, engineConfig, shellFrom, shellOf, EXTENSION_SHELL } = await import("../scripts/browser/choice.mjs");
const { launchOptions } = await import("../scripts/browser.mjs");
const { paths } = await import("../scripts/paths.mjs");

const PINNED = "/home/u/.pairbrowse/browser/PairBrowse.app/Contents/MacOS/pairbrowse";
const yes = () => true;
const choose = (config, native = true) => {
  const { browser, binary, executablePath, install, set, problem } = chooseBrowser(config, { native, pinnedExec: () => PINNED, exists: yes, executable: yes });
  return { browser, binary, executablePath, install, set, problem };
};

test("the choice: binary and where it runs from, for the setting, its older names and a pinned build", () => {
  const c = (browser, binary, executablePath, install, set = true) => ({ browser, binary, executablePath, install, set, problem: null });
  // Unset: the pinned native build where there is one (installed first), else Chromium; nobody chose.
  assert.deepEqual(choose({}, true), c("pairbrowse", "native", null, true, false));
  assert.deepEqual(choose({}, false), c("chromium", "chromium", null, false, false));
  // "browser" itself.
  assert.deepEqual(choose({ browser: "pairbrowse" }), c("pairbrowse", "native", null, true));
  assert.deepEqual(choose({ browser: "chromium" }), c("chromium", "chromium", null, false));
  assert.deepEqual(choose({ browser: "/opt/brave" }), c("/opt/brave", "custom", "/opt/brave", false));
  // The older names: a native build of your own runs as it is; the pinned one's own path is the pinned build.
  assert.deepEqual(choose({ browserEngine: "pairbrowse", executablePath: "/my/native/pairbrowse" }), c("pairbrowse", "native", "/my/native/pairbrowse", false));
  assert.deepEqual(choose({ browserEngine: "pairbrowse", executablePath: PINNED }), c("pairbrowse", "native", null, true));
  assert.deepEqual(choose({ browserEngine: "pairbrowse" }), c("pairbrowse", "native", null, true));
  assert.deepEqual(choose({ browserEngine: "chromium", executablePath: "/fake/chrome" }), c("/fake/chrome", "custom", "/fake/chrome", false));
  assert.deepEqual(choose({ browserEngine: "chromium" }, true), c("chromium", "chromium", null, false));
  // "browser" wins over the older names; a bad value is Chromium, with the line for the log.
  assert.equal(choose({ browser: "chromium", browserEngine: "pairbrowse", executablePath: "/x" }).binary, "chromium");
  assert.match(choose({ browser: "brave" }).problem, /must be "pairbrowse", "chromium" or an absolute path/);
});

test("the launch layer gets a copy with the older names; config stays as written", () => {
  const config = Object.freeze({ browser: "pairbrowse", chromeArgs: ["--x"], pairbrowse: { persona: 1 } });
  const engine = engineConfig(config, { binary: "native", executablePath: PINNED });
  assert.deepEqual(engine, { ...config, browserEngine: "pairbrowse", executablePath: PINNED });
  assert.deepEqual(engineConfig(config, { binary: "custom", executablePath: "/opt/brave" }).browserEngine, "chromium");
  assert.equal(engineConfig(config, { binary: "chromium" }).executablePath, null);
});

test("the shell: the side panel extension unless the build declares its own pages", () => {
  assert.equal(shellFrom(null), EXTENSION_SHELL);
  assert.equal(shellFrom({ capture: 2 }), EXTENSION_SHELL, "a capture page needs the build's own pages");
  assert.deepEqual(shellFrom({ chrome: 1 }), { kind: "pages", ownPages: true, capturePage: false, captureKeyed: false });
  assert.deepEqual(shellFrom({ chrome: 1, capture: 1 }), { kind: "pages", ownPages: true, capturePage: true, captureKeyed: false });
  assert.deepEqual(shellFrom({ chrome: 1, capture: 2 }), { kind: "pages", ownPages: true, capturePage: true, captureKeyed: true });
  let reads = 0;
  const read = (p) => { reads++; if (p === "/bad") throw new Error("no manifest"); return { chrome: 1 }; };
  assert.equal(shellOf({ browserEngine: "chromium", executablePath: "/x" }, read), EXTENSION_SHELL);
  assert.equal(reads, 0, "a Chromium binary's manifest is never read");
  assert.equal(shellOf({ browserEngine: "pairbrowse", executablePath: "/bad" }, read), EXTENSION_SHELL, "a manifest that doesn't read: the extension");
  assert.equal(shellOf({ browserEngine: "pairbrowse", executablePath: "/ok" }, read).kind, "pages");
});

test("one set of launch options: the helper's and the self-check's differ only where they mean to", () => {
  const pages = shellFrom({ chrome: 1 });
  const helper = { origin: "http://127.0.0.1:4000", keyFile: "/run/helper-key-x" };
  const daemon = launchOptions({}, { shell: pages, firstRun: true, helper, env: { A: "1" }, executablePath: "/b" });
  assert.deepEqual([daemon.headless, daemon.viewport, daemon.executablePath, daemon.env], [false, null, "/b", { A: "1" }]);
  assert.deepEqual(daemon.ignoreDefaultArgs, ["--disable-extensions", "about:blank"], "own pages open the build's start page");
  assert.ok(daemon.args.includes(`--pairbrowse-helper=${helper.origin}`) && daemon.args.includes(`--pairbrowse-helper-key-file=${helper.keyFile}`));
  const check = launchOptions({}, { shell: pages, env: {}, executablePath: "/b", blankStart: true });
  assert.deepEqual(check.ignoreDefaultArgs, ["--disable-extensions"], "the self-check drives a plain first tab");
  assert.ok(!check.args.some((a) => a.startsWith("--pairbrowse-helper")), "and has no live view");
  const ext = launchOptions({}, { shell: EXTENSION_SHELL, helper, env: {}, executablePath: "/b" });
  assert.deepEqual(ext.ignoreDefaultArgs, ["--disable-extensions"]);
  assert.ok(ext.args.some((a) => a.startsWith("--load-extension=")) && !ext.args.some((a) => a.startsWith("--pairbrowse-helper")), "the extension, never the pages' switches");
});

// A context on a fake browser (the helper's own, daemon/context.mjs), in a home of its own.
async function fakeContext(config) {
  assert.equal(paths.home, home, "never the person's own ~/.pairbrowse");
  const { createContext } = await import("../scripts/daemon/context.mjs");
  const launched = [];
  const fakePage = (ctx) => ({ on() {}, once() {}, listeners: () => [], isClosed: () => false, context: () => ctx, url: () => "about:blank",
    goto: async () => {}, close: async () => {}, bringToFront: async () => {}, setContent: async () => {}, evaluate: async () => {} });
  const chromium = {
    launchPersistentContext: async (profile, options) => {
      launched.push({ profile, options });
      const ctx = new EventEmitter();
      const pages = [];
      Object.assign(ctx, { pages: () => pages, addInitScript: async () => {}, newPage: async () => { const p = fakePage(ctx); pages.push(p); return p; }, browser: () => null, close: async () => ctx.emit("close") });
      pages.push(fakePage(ctx));
      return ctx;
    },
  };
  const quiet = () => {};
  const context = createContext({
    config, log: quiet, chromium, hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
    presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
    shuttingDown: () => false, onStarted: quiet, onClosed: quiet,
  });
  return { context, launched };
}

test("a launch keeps its choice to itself, and a native profile alone is something to go back to", { timeout: 30_000 }, async () => {
  writeFileSync(join(home, "config.json"), "{}");
  mkdirSync(join(home, "run"), { recursive: true });
  // Only the native build ran here before: its profile folder, nothing in the Chromium one.
  mkdirSync(join(home, "profile", "pairbrowse-native", "Default"), { recursive: true });
  const config = { browserEngine: "auto", executablePath: "/fake/chrome", display: "none" };
  const written = JSON.stringify(config);
  const { context, launched } = await fakeContext(config);
  await context.getContext();
  assert.equal(context.picking(), true, "the session picker asks: the native profile is a browser that ran before");
  assert.equal(JSON.stringify(config), written, "the choice is never written into config");
  assert.equal(context.browserInUse(), "/fake/chrome");
  assert.deepEqual(context.shell(), EXTENSION_SHELL);
  assert.equal(launched.length, 1);
  assert.equal(launched[0].profile, join(home, "profile"), "a Chromium binary runs in the Chromium profile");
  assert.equal(launched[0].options.executablePath, "/fake/chrome");
  assert.equal(context.choiceConfig(), config);
  await context.close();
});
