// The person switches away from the open session from the browser's own pages (the session
// switcher, the new tab page's chips: POST pick while no picker shows, daemon/pick.mjs): the
// answer comes at once, and the browser restarts on the other session after it went out, with no
// picker tab. context.mjs switchForPerson.
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 5000) => { for (let i = 0; i < ms / 20 && !check(); i++) await sleep(20); return check(); };

test("a person's switch from an open session: checked at once, the browser restarts on the other one", { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pb-ctx-person-"));
  process.env.PAIRBROWSE_HOME = home;
  writeFileSync(join(home, "config.json"), "{}");
  mkdirSync(join(home, "run"), { recursive: true });
  const { createContext } = await import("../scripts/daemon/context.mjs");
  const launched = [];
  const visited = [];
  const fakeContext = () => {
    const ctx = new EventEmitter();
    const pages = [];
    ctx.pages = () => pages;
    ctx.addInitScript = async () => {};
    ctx.newPage = async () => { const p = { on() {}, once() {}, listeners: () => [], url: () => "about:blank", isClosed: () => false, goto: async (u) => { visited.push(u); }, close: async () => {}, context: () => ctx, bringToFront: async () => {} }; pages.push(p); return p; };
    ctx.browser = () => null;
    ctx.close = async () => { ctx.emit("close"); await sleep(20); };
    return ctx;
  };
  const chromium = { launchPersistentContext: async () => { const c = fakeContext(); launched.push(c); return c; } };
  const quiet = () => {};
  const context = createContext({
    config: { browserEngine: "chromium", executablePath: "/fake/chrome", sessionPicker: false, display: "none" }, log: quiet, chromium,
    hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
    presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
    shuttingDown: () => false, onStarted: quiet, onClosed: quiet,
  });
  await context.getContext();
  assert.ok(!(await context.sessionCommand({ action: "new", name: "home" })).error);
  assert.equal(context.sessionName(), "home");
  assert.equal(context.picking(), false);
  const n = launched.length;

  assert.deepEqual(await context.switchForPerson({ action: "use", name: "home" }), { text: 'You\'re in session "home" already.' });
  assert.equal((await context.switchForPerson({ action: "use", name: "nope" })).error, true);
  assert.equal((await context.switchForPerson({ action: "use", name: "../x" })).error, true);
  assert.equal((await context.switchForPerson({ action: "steal" })).error, true);
  await sleep(50);
  assert.equal(launched.length, n, "nothing restarted for a refusal");

  const r = await context.switchForPerson({ action: "use", name: "default" });
  assert.deepEqual(r, { text: 'Opening session "default".' });
  assert.equal(context.sessionName(), "home", "answered before the switch starts");
  assert.ok(await until(() => context.sessionName() === "default" && launched.length === n + 1), "then the browser restarts on it");
  assert.ok(!visited.some((u) => /picker/.test(u)), "no picker tab");

  assert.deepEqual(await context.switchForPerson({ action: "new" }), { text: "Starting a fresh session." });
  assert.ok(await until(() => /^clean-\d+$/.test(context.sessionName())), "a fresh, throwaway session");
  assert.equal(context.picking(), false);
});

// The helper's timers (tab memory, picker) keep running: the run ends here.
after(() => setImmediate(() => process.exit(process.exitCode || 0)));
