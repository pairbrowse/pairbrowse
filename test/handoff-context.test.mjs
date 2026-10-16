// The browser's side of a version handoff (scripts/handoff.mjs): a browser still starting (its
// saved tabs reopening) keeps the helper, a stop meanwhile keeps the whole saved list, and what a
// person does where the page script never runs (the browser opened by hand, the session picker)
// counts as using the browser (daemon/context.mjs starting, picking, personAt).
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { sleep } from "./helpers/util.mjs";

const home = mkdtempSync(join(tmpdir(), "pb-hoc-"));
process.env.PAIRBROWSE_HOME = home;
writeFileSync(join(home, "config.json"), "{}");
mkdirSync(join(home, "run"), { recursive: true });
after(() => rmSync(home, { recursive: true, force: true }));

const { createContext } = await import("../scripts/daemon/context.mjs");
const { busyReason, readUse, createVersionHandoff } = await import("../scripts/handoff.mjs");
const { tabsFile } = await import("../scripts/sessions.mjs");

const until = async (check, ms = 10_000) => { for (let i = 0; i < ms / 20 && !check(); i++) await sleep(20); return check(); };
const SAVED = ["https://a.example/1", "https://b.example/2", "https://c.example/3"];
const writeSaved = () => writeFileSync(tabsFile("default"), JSON.stringify({ tabs: SAVED.map((url) => ({ url, title: url })), active: 0 }));
const savedNow = () => JSON.parse(readFileSync(tabsFile("default"), "utf8")).tabs.map((t) => t.url);

// A browser whose tab going to hold waits until release() (a slow site during the restore).
function fakeBrowser({ hold = null, hangTitles = false } = {}) {
  let release;
  const held = new Promise((r) => { release = r; });
  const fakePage = (ctx) => {
    const page = new EventEmitter();
    const frame = {};
    Object.assign(page, {
      at: "about:blank", closed: false,
      listeners: () => [], isClosed: () => page.closed, context: () => ctx, url: () => page.at, mainFrame: () => frame,
      goto: async (url) => { if (url === hold) await held; page.at = url; page.emit("framenavigated", frame); },
      close: async () => { page.closed = true; page.emit("close"); },
      bringToFront: async () => {}, setContent: async () => {}, evaluate: async () => {}, title: hangTitles ? () => new Promise(() => {}) : async () => "", waitForLoadState: async () => {},
    });
    return page;
  };
  const ctx = new EventEmitter();
  const pages = [];
  ctx.pages = () => pages.filter((p) => !p.closed);
  ctx.addInitScript = async () => {};
  ctx.newPage = async () => { const p = fakePage(ctx); pages.push(p); ctx.emit("page", p); return p; };
  ctx.browser = () => null;
  ctx.close = async () => { ctx.closedAt = Date.now(); ctx.emit("close"); };
  pages.push(fakePage(ctx)); // the start tab
  return { chromium: { launchPersistentContext: async () => ctx }, release, ctx };
}
const quiet = () => {};
const make = (chromium, config = {}, more = {}) => createContext({
  config: { browserEngine: "chromium", executablePath: "/fake/chrome", display: "none", sessionPicker: false, ...config }, log: quiet, chromium,
  hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
  presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
  shuttingDown: () => false, onStarted: quiet, onClosed: quiet, ...more,
});

test("saved tabs still reopening: the browser is starting, and a newer version's hello doesn't stop the helper", { timeout: 30_000 }, async () => {
  writeSaved();
  const b = fakeBrowser({ hold: SAVED[1] });
  const context = make(b.chromium);
  assert.equal(context.starting(), false, "no browser yet: nothing starting");
  const up = context.getContext();
  assert.equal(context.starting(), true, "launching");
  await up;
  assert.ok(await until(() => context.isRestoring()), "the restore runs");
  assert.equal(context.starting(), true, "reopening the saved tabs");
  assert.equal(busyReason({ ...readUse({ context }), now: Date.now() }), "the browser is starting");
  let stops = 0;
  const handoff = createVersionHandoff({ own: "0.16.1", state: () => readUse({ context }), stop: () => { stops++; } });
  const sock = Object.assign(new EventEmitter(), { destroyed: false, written: "", resume() {}, end(t) { this.written += t || ""; this.destroyed = true; } });
  handoff.answer(sock, JSON.stringify({ pairbrowse: "hook", op: "version", v: 1, version: "0.16.2" }));
  assert.deepEqual(JSON.parse(sock.written), { restart: false, why: "the browser is starting" });
  assert.equal(stops, 0);
  b.release();
  assert.ok(await until(() => !context.isRestoring()), "the restore finishes");
  assert.equal(context.starting(), false, "up: nothing starting");
  assert.equal(busyReason({ ...readUse({ context }), now: Date.now() }), null, "idle once the tabs are back");
  await context.close();
});

test("a stop while saved tabs reopen keeps the whole saved list, never the few open so far", { timeout: 30_000 }, async () => {
  writeSaved();
  const b = fakeBrowser({ hold: SAVED[1] }); // never released: the restore is still going at the stop
  const context = make(b.chromium);
  await context.getContext();
  assert.ok(await until(() => context.isRestoring()));
  await sleep(1800); // past the tracker's 1.5 s debounce: a save due now would write one tab
  assert.deepEqual(savedNow(), SAVED, "nothing written while the tabs come back");
  const t = Date.now();
  await context.close({ restoreWaitMs: 300 });
  assert.ok(Date.now() - t < 2500, "the wait for the restore is bounded");
  assert.deepEqual(savedNow(), SAVED, "the whole list, for the next start");
});

test("a stop while saved tabs reopen waits for them, then saves them all", { timeout: 30_000 }, async () => {
  writeSaved();
  const b = fakeBrowser({ hold: SAVED[1] });
  const context = make(b.chromium);
  await context.getContext();
  assert.ok(await until(() => context.isRestoring()));
  setTimeout(() => b.release(), 200);
  await context.close({ restoreWaitMs: 3000 });
  assert.deepEqual(savedNow(), SAVED, "every tab, saved once the restore finished");
});

// The helper's stop has SHUTDOWN_GRACE_MS (5 s, daemon.mjs) in all: the restore's wait, the save and
// the browser's own close are budgeted against that deadline, the close keeping at least 1.5 s.
test("a stop's restore wait and save fit the grace: the browser's close starts with 1.5 s left", { timeout: 30_000 }, async () => {
  // The restore ended 2.5 s into the stop (a fake clock that far on), and no tab answers its title
  // (2 s a tab before): the save writes what it has by 3.5 s, then the close.
  writeSaved();
  const b = fakeBrowser({ hangTitles: true });
  const context = make(b.chromium);
  await context.getContext();
  assert.ok(await until(() => !context.isRestoring() && b.ctx.pages().length >= SAVED.length));
  const start = Date.now();
  const now = () => Date.now() + 2500;
  await context.close({ deadline: start + 5000, now });
  const at = b.ctx.closedAt - start;
  assert.ok(at <= 1300, `the close started by 3.5 s of the grace (${at + 2500} ms)`);
  assert.deepEqual(savedNow(), SAVED, "every tab saved, titles or not");

  // Saved tabs still reopening 3 s into the stop: the restore's wait is what's left before 3.5 s.
  writeSaved();
  const held = fakeBrowser({ hold: SAVED[1] });
  const c2 = make(held.chromium);
  await c2.getContext();
  assert.ok(await until(() => c2.isRestoring()));
  const s2 = Date.now();
  await c2.close({ deadline: s2 + 5000, now: () => Date.now() + 3000 });
  const at2 = held.ctx.closedAt - s2;
  assert.ok(at2 <= 800, `the restore's wait was cut to the budget (${at2 + 3000} ms)`);
  assert.deepEqual(savedNow(), SAVED, "the whole list kept");
});

test("a tab opened after the launch is adopted as opened (a browser page there counts as a person's), the tabs at launch not", { timeout: 30_000 }, async () => {
  writeFileSync(tabsFile("default"), JSON.stringify({ tabs: [] }));
  const b = fakeBrowser();
  const seen = [];
  const context = make(b.chromium, {}, { presence: { watchUser: (page, o) => seen.push([page, !!o?.opened]) } });
  await context.getContext();
  assert.deepEqual(seen.map((s) => s[1]), [false], "the start tab, there at launch");
  const later = await b.ctx.newPage();
  assert.deepEqual(seen.find((s) => s[0] === later)?.[1], true, "a tab opened later");
  await context.close();
});

test("the browser opened by hand and a pick in the session picker count as a person using the browser", { timeout: 30_000 }, async () => {
  writeFileSync(tabsFile("default"), JSON.stringify({ tabs: [] }));
  const byHand = make(fakeBrowser().chromium, {}, { browserPagesOf: () => true });
  assert.equal(byHand.personAt(), 0);
  const before = Date.now();
  assert.deepEqual(await byHand.openByHand(), { ok: true });
  assert.ok(byHand.personAt() >= before, "opened by hand");
  assert.match(busyReason({ ...readUse({ context: byHand }), now: Date.now() }) || "", /last 2 minutes/);
  await byHand.close();

  // The picker: something to go back to (a browser ran before), so it shows at the start.
  mkdirSync(join(home, "profile", "Default"), { recursive: true });
  const picking = make(fakeBrowser().chromium, { sessionPicker: true });
  await picking.getContext();
  assert.equal(picking.picking(), true);
  assert.equal(picking.personAt(), 0, "shown, nobody picked yet");
  assert.equal(busyReason({ ...readUse({ context: picking }), now: Date.now() }), "the session picker is showing");
  const r = await picking.pickSession({ action: "use", name: "default" });
  assert.ok(!r.error, r.text);
  assert.ok(picking.personAt() >= before, "the person's pick");
  assert.equal(picking.picking(), false);
  assert.match(busyReason({ ...readUse({ context: picking }), now: Date.now() }) || "", /last 2 minutes/);
  // A press in the browser's own pages, heard through the live view (liveview.mjs onPersonInput).
  const other = make(fakeBrowser().chromium);
  other.personUsed();
  assert.ok(other.personAt() >= before);
  other.personUsed(Date.now() + 60_000);
  assert.ok(other.personAt() <= Date.now(), "never a time in the future");
  await picking.close();
});
