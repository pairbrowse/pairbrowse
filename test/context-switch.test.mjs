// A session switch closes one browser and opens the next. A real window takes a moment to close,
// and other parts ask for the browser all along (the live view, the side panel, new sessions):
// none of them may start a browser in between, which would be left running unknown to the helper
// (a second window, and the next start failing on its profile in use).
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { sleep } from "./helpers/util.mjs";


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

// Agents and profiles (spec server-mode D14): action "profiles" only lists them (names, never a
// setting); "new" with profile starts the new session on one (unknown or retired refused by name,
// nothing made); profile with any other action is refused (the person reassigns).
test("session new with profile assigns it; action profiles only lists", { timeout: 30_000 }, async () => {
  const { createContext } = await import("../scripts/daemon/context.mjs");
  const { createProfileStore } = await import("../scripts/profiles/store.mjs");
  const { readAssignment, listSessions } = await import("../scripts/sessions.mjs");
  const store = createProfileStore({ dir: mkdtempSync(join(tmpdir(), "pb-ctx-store-")) });
  const berlin = store.create({ name: "berlin", browser: { kind: "pairbrowse-open" }, locale: { languages: ["de-DE"], timezone: null, source: "set" } });
  store.create({ name: "old" });
  store.retire("old");
  store.create({ name: "office", browser: { kind: "pairbrowse-open" }, display: { colorScheme: "light", reducedMotion: null } });
  const chromium = { launchPersistentContext: async () => { const ctx = new EventEmitter(); ctx.pages = () => []; ctx.addInitScript = async () => {}; ctx.newPage = async () => ({ on() {}, once() {}, url: () => "about:blank", isClosed: () => false, goto: async () => {}, close: async () => {}, context: () => ctx }); ctx.browser = () => null; ctx.close = async () => { ctx.emit("close"); }; return ctx; } };
  const quiet = () => {};
  const context = createContext({
    config: { browserEngine: "chromium", executablePath: "/fake/chrome", sessionPicker: false, display: "none" }, log: quiet, chromium, profileStore: store,
    hud: { source: "", ensure: quiet, onPageLoad: quiet, clearSparks: quiet, badge: () => "" },
    presence: { watchUser: quiet }, popups: { watchPage: quiet }, hostNote: quiet, onTabClosed: quiet, status: quiet,
    shuttingDown: () => false, onStarted: quiet, onClosed: quiet,
  });
  const before = JSON.stringify(store.list());
  const listed = await context.sessionCommand({ action: "profiles" });
  assert.ok(!listed.error);
  assert.match(listed.text, /^Browser profiles \(pick one for a new session: action "new" with name and profile; only the user makes or changes them\):/);
  assert.match(listed.text, /\n {2}berlin\n/);
  assert.match(listed.text, /old \(retired: can't be picked\)/);
  assert.doesNotMatch(listed.text, /de-DE/, "names only, never a setting");
  assert.equal(JSON.stringify(store.list()), before, "listing changes nothing");
  // Refused before anything is made: a profile that isn't there, a retired one, one with a setting
  // its browser can't apply (named, never left to a start that fails), profile on use.
  for (const [profile, why] of [["nowhere", /There is no browser profile "nowhere"|doesn't exist/], ["old", /retired/],
    ["office", /^Browser profile "office" can't start on PairBrowse as an extension: display\.colorScheme \(PairBrowse as an extension can't give pages a light scheme.*\)\. Nothing was made/]]) {
    const r = await context.sessionCommand({ action: "new", name: `cs-${profile}`, profile });
    assert.equal(r.error, true, profile);
    assert.match(r.text, why);
    assert.ok(!listSessions().some((x) => x.name === `cs-${profile}`), "no session left behind");
  }
  const misuse = await context.sessionCommand({ action: "use", name: "default", profile: "berlin" });
  assert.equal(misuse.error, true);
  assert.match(misuse.text, /profile goes with action "new" only/);
  const made = await context.sessionCommand({ action: "new", name: "cs-berlin", profile: "berlin" });
  assert.ok(!made.error, made.text);
  assert.match(made.text, /new session "cs-berlin" on browser profile "berlin"/);
  assert.equal(readAssignment("cs-berlin").profileId, berlin.id);
  // An existing session is never reassigned by an agent.
  const again = await context.sessionCommand({ action: "new", name: "cs-berlin", profile: "default" });
  assert.equal(again.error, true);
  assert.equal(readAssignment("cs-berlin").profileId, berlin.id);
});

// The helper's timers (tab memory, picker) keep running: the run ends here.
after(() => setImmediate(() => process.exit(process.exitCode || 0)));
