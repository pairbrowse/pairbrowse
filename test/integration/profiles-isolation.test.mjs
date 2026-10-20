// Two sessions on one browser profile are two browsers' worth of storage (spec server-mode Phase D,
// "Isolation", D2): a profile is settings only, so the login (cookie), localStorage, IndexedDB,
// history and cache of one session are absent in the other; a cached script is fetched again in
// the other; and the engine's stores (cookies, Login Data, history, cache, extensions) live under
// each session's own folder, never anywhere shared in the home. Live: a real helper and browser
// (PAIRBROWSE_TEST_RUNTIME); one browser at a time: one run (before) that the spec's three tests
// read.
import "../helpers/home.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { session } from "../helpers/live.mjs";
import { text } from "../helpers/util.mjs";
import { helperHome, startHelper } from "../helpers/daemon.mjs";
import { startProbeSite, probe, profilesCli, sessionFolder, filesUnder, fileHolds } from "../helpers/profiles-live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const SHARED = { browser: { kind: "pairbrowse-open" }, locale: { languages: ["en-GB"], timezone: null, source: "set" } };
// The engine's own stores, by their file or folder name.
const STORES = new Set(["Cookies", "Login Data", "History", "Cache_Data", "IndexedDB", "Local Storage", "Extensions"]);

const live = { skip: !runtime && "set PAIRBROWSE_TEST_RUNTIME" };
// What the run saw: each probe's answer, the script's fetch count after each session, the two
// session folders and every file under the home once the helper stopped.
const seen = {};
let home = null;

before(async () => {
  if (!runtime) return;
  const site = await startProbeSite();
  home = helperHome(runtime, { prefix: "pb-prof-iso-", config: { sessionPicker: false } });
  let helper = null;
  try {
    assert.equal(profilesCli(home, ["create", "shared", "--settings", JSON.stringify(SHARED)]).code, 0);
    helper = await startHelper(home);
    const agent = await session(helper.socketPath, "a");
    // Session one: everything set, the cached script fetched once over two visits.
    assert.match(text(await agent.tool("pairbrowse_session", { action: "new", name: "iso-one", profile: "shared" })), /on browser profile "shared"/);
    seen.set = await probe(agent, `${site.base}/p?set=1`);
    seen.oneAgain = await probe(agent, `${site.base}/p?visit=one-only`);
    seen.fetchesOne = site.fetches;
    // Session two, on the same profile.
    assert.match(text(await agent.tool("pairbrowse_session", { action: "new", name: "iso-two", profile: "shared" })), /on browser profile "shared"/);
    seen.two = await probe(agent, `${site.base}/p`);
    seen.fetchesTwo = site.fetches;
    agent.sock.destroy();
    await helper.stop(); // a clean close writes the history and cookie stores
    helper = null;
    seen.one = sessionFolder(home, "iso-one");
    seen.twoDir = sessionFolder(home, "iso-two");
    seen.files = filesUnder(home);
  } finally {
    await helper?.stop();
    site.close();
  }
}, { timeout: 240_000 });

after(() => { if (home) rmSync(home, { recursive: true, force: true }); });

const named = (dir) => new Set(seen.files.filter((f) => f.path.startsWith(dir + sep)).map((f) => f.path.split(sep).at(-1)));

test("cookie, localStorage, IndexedDB and history in one session are absent in the other", live, () => {
  assert.deepEqual(seen.set, { cookies: "(none)", ls: "kept", idb: "kept" });
  assert.deepEqual(seen.oneAgain, { cookies: "login=kept", ls: "kept", idb: "kept" }, "session one keeps what it set");
  assert.deepEqual(seen.two, { cookies: "(none)", ls: "null", idb: "none" }, "no login, localStorage or IndexedDB of session one");
  // History: the address only session one visited is in its History, not in session two's.
  assert.ok(fileHolds(join(seen.one, "Default", "History"), "visit=one-only"), "session one's history has the visit");
  assert.equal(fileHolds(join(seen.twoDir, "Default", "History"), "visit=one-only"), false, "session two's history doesn't");
});

test("a cached resource is fetched again in the other session; cache files under each session's folder", live, () => {
  assert.equal(seen.fetchesOne, 1, "the script came from session one's cache the second time");
  assert.equal(seen.fetchesTwo, 2, "the cached script was fetched again in session two");
  for (const dir of [seen.one, seen.twoDir]) assert.ok(named(dir).has("Cache_Data"), `a disk cache under ${relative(home, dir)}`);
});

test("Login Data and Extensions under each session's own folder", live, () => {
  for (const dir of [seen.one, seen.twoDir]) {
    for (const store of ["Login Data", "Cookies", "History"]) assert.ok(named(dir).has(store), `${store} under ${relative(home, dir)}`);
  }
  // And nowhere else in the home: no store outside a session's folder, Extensions included (a
  // session's own Extensions folder exists once the person installs one; PairBrowse's side panel
  // loads unpacked from the plugin, never into the home).
  const sessionDirs = [seen.one, seen.twoDir, sessionFolder(home, "default")];
  const stray = seen.files.filter((f) => STORES.has(f.path.split(sep).at(-1)) && !sessionDirs.some((d) => f.path.startsWith(d + sep)) && !f.path.startsWith(join(home, "runtime") + sep));
  assert.deepEqual(stray.map((f) => relative(home, f.path)), [], "every engine store is under a session's own folder");
});
