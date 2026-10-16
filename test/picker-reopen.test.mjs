// The session picker asked for again (the side panel's "End session"): it opens in a tab of its
// own while the session's tabs stay open and their tracker keeps running. An agent's choice then
// (pairbrowse_join: daemon/sessions/picker.mjs agentChose) closes the picker and nothing more: the
// saved tabs never open a second time, and no second tracker watches the same browser.
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { sleep } from "./helpers/util.mjs";

const home = mkdtempSync(join(tmpdir(), "pb-repick-"));
process.env.PAIRBROWSE_HOME = home;
writeFileSync(join(home, "config.json"), "{}");
mkdirSync(join(home, "run"), { recursive: true });
mkdirSync(join(home, "profile", "Default"), { recursive: true }); // a browser ran before: the picker shows
after(() => rmSync(home, { recursive: true, force: true }));

const { createContext } = await import("../scripts/daemon/context.mjs");
const { tabsFile } = await import("../scripts/sessions.mjs");

const until = async (check, ms = 10_000) => { for (let i = 0; i < ms / 20 && !check(); i++) await sleep(20); return check(); };
const SAVED = "https://shop.example/orders";

function fakeBrowser() {
  const visited = [];
  const ctx = new EventEmitter();
  const pages = [];
  const fakePage = () => {
    const page = new EventEmitter();
    const frame = {};
    Object.assign(page, {
      at: "about:blank", closed: false,
      listeners: () => [], isClosed: () => page.closed, context: () => ctx, url: () => page.at, mainFrame: () => frame,
      goto: async (url) => { page.at = url; visited.push(url); page.emit("framenavigated", frame); },
      close: async () => { page.closed = true; page.emit("close"); },
      bringToFront: async () => {}, setContent: async () => {}, evaluate: async () => {}, title: async () => "", waitForLoadState: async () => {},
    });
    return page;
  };
  ctx.pages = () => pages.filter((p) => !p.closed);
  ctx.addInitScript = async () => {};
  ctx.newPage = async () => { const p = fakePage(); pages.push(p); ctx.emit("page", p); return p; };
  ctx.browser = () => null;
  ctx.close = async () => { ctx.emit("close"); };
  pages.push(fakePage()); // the browser's first tab, where the picker shows
  return { chromium: { launchPersistentContext: async () => ctx }, ctx, visited };
}

test("an agent's choice while a reopened picker shows closes it; the open tabs and their tracker stay as they are", { timeout: 30_000 }, async () => {
  writeFileSync(tabsFile("default"), JSON.stringify({ tabs: [{ url: SAVED, title: "Orders" }], active: 0 }));
  const b = fakeBrowser();
  const quiet = () => {};
  const context = createContext({
    config: { browserEngine: "chromium", executablePath: "/fake/chrome", display: "none" }, log: quiet, chromium: b.chromium,
    hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
    presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
    shuttingDown: () => false, onStarted: quiet, onClosed: quiet,
  });
  await context.getContext();
  assert.equal(context.picking(), true);
  // The person picks the open session: its saved tab comes back.
  assert.ok(!(await context.pickSession({ action: "use", name: "default" })).error);
  assert.ok(await until(() => b.visited.includes(SAVED) && !context.isRestoring()), "the saved tab is back");
  const open = b.ctx.pages().length;

  // Asked for again: the picker in a tab of its own, the tabs still open.
  await context.reopenPicker();
  assert.equal(context.picking(), true);
  assert.ok(await until(() => b.ctx.pages().length === open + 1), "the picker's own tab");
  const pickerTab = b.ctx.pages().at(-1);

  context.agentChose("An agent joined a shared session (pairbrowse_join).");
  assert.equal(context.picking(), false, "answered");
  await sleep(500);
  assert.equal(b.visited.filter((u) => u === SAVED).length, 1, "the saved tabs never open a second time");
  assert.equal(context.isRestoring(), false, "no second restore");
  assert.equal(pickerTab.isClosed(), true, "the picker's own tab goes");
  assert.equal(b.ctx.pages().length, open, "the open tabs stay");
  // The tracker that ran before still saves this browser's tabs.
  await sleep(1800);
  assert.deepEqual(JSON.parse(readFileSync(tabsFile("default"), "utf8")).tabs.map((t) => t.url), [SAVED]);
  await context.close();
});
