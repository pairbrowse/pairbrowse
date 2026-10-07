// A session switch closes one browser and opens the next. A real window takes a moment to close,
// and other parts ask for the browser all along (the live view, the side panel, new sessions):
// none of them may start a browser in between, which would be left running unknown to the helper
// (a second window, and the next start failing on its profile in use).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a session switch opens one browser, whoever asks for it meanwhile", { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pb-ctx-"));
  process.env.PAIRBROWSE_HOME = home;
  writeFileSync(join(home, "config.json"), "{}");
  mkdirSync(join(home, "run"), { recursive: true });
  const { createContext } = await import("../scripts/daemon/context.mjs");
  const launched = [];
  const fakeContext = (profile) => {
    const ctx = new EventEmitter();
    ctx.profile = profile;
    ctx.pages = () => [];
    ctx.addInitScript = async () => {};
    ctx.newPage = async () => ({ on() {}, once() {}, url: () => "about:blank", isClosed: () => false, goto: async () => {}, close: async () => {}, context: () => ctx });
    ctx.browser = () => null;
    // A window closing: "close" comes out first, the call finishes a little later.
    ctx.close = async () => { ctx.emit("close"); await sleep(300); };
    return ctx;
  };
  const chromium = { launchPersistentContext: async (profile) => { await sleep(50); const c = fakeContext(profile); launched.push(c); return c; } };
  const quiet = () => {};
  const context = createContext({
    config: { browserEngine: "chromium", executablePath: "/fake/chrome", sessionPicker: false, display: "none" }, log: quiet, chromium,
    hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
    presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
    shuttingDown: () => false, onStarted: quiet, onClosed: quiet,
  });
  await context.getContext();
  assert.equal(launched.length, 1);
  // Someone asks for the browser every few ms while the switch runs.
  let asking = true;
  const askers = (async () => { while (asking) { context.getContext().catch(() => {}); await sleep(5); } })();
  const r = await context.sessionCommand({ action: "new" });
  asking = false;
  await askers;
  await sleep(200);
  assert.ok(!r.error, r.text);
  assert.equal(launched.length, 2, `one new browser for the new session, not ${launched.length - 1}`);
  const now = await context.getContext();
  assert.equal(now, launched[1], "the helper holds the browser it opened");
});

// The helper's timers (tab memory, picker) keep running: the run ends here.
after(() => setImmediate(() => process.exit(process.exitCode || 0)));
