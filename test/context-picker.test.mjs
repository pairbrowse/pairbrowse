// The session picker is up in the browser's first tab. An agent that chooses the open session
// (pairbrowse_session use) answers it for everyone: the picker goes, and the session's saved tabs
// come back as they would after the person's pick.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
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

// The helper's timers (tab memory, picker) keep running: the run ends here.
after(() => setImmediate(() => process.exit(process.exitCode || 0)));
