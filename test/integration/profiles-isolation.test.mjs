// Two sessions on one browser profile are two browsers' worth of storage (spec server-mode Phase D,
// "Isolation", D2): a profile is settings only, so the login (cookie), localStorage, IndexedDB,
// history and cache of one session are absent in the other; a cached script is fetched again in
// the other; and the engine's stores (cookies, Login Data, history, cache, extensions) live under
// each session's own folder, never anywhere shared in the home. Live: a real helper and browser
// (PAIRBROWSE_TEST_RUNTIME); one browser at a time.
import "../helpers/home.mjs";
import { test } from "node:test";
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

test("cookie, localStorage, IndexedDB, history and cache in one session are absent in the other; each session's stores under its own folder", { skip: !runtime && "set PAIRBROWSE_TEST_RUNTIME", timeout: 240_000 }, async () => {
  const site = await startProbeSite();
  const home = helperHome(runtime, { prefix: "pb-prof-iso-", config: { sessionPicker: false } });
  let helper = null;
  try {
    assert.equal(profilesCli(home, ["create", "shared", "--settings", JSON.stringify(SHARED)]).code, 0);
    helper = await startHelper(home);
    const agent = await session(helper.socketPath, "a");
    // Session one: everything set, the cached script fetched once over two visits.
    assert.match(text(await agent.tool("pairbrowse_session", { action: "new", name: "iso-one", profile: "shared" })), /on browser profile "shared"/);
    assert.deepEqual(await probe(agent, `${site.base}/p?set=1`), { cookies: "(none)", ls: "kept", idb: "kept" });
    assert.deepEqual(await probe(agent, `${site.base}/p?visit=one-only`), { cookies: "login=kept", ls: "kept", idb: "kept" });
    assert.equal(site.fetches, 1, "the script came from session one's cache the second time");
    // Session two, on the same profile: none of it.
    assert.match(text(await agent.tool("pairbrowse_session", { action: "new", name: "iso-two", profile: "shared" })), /on browser profile "shared"/);
    assert.deepEqual(await probe(agent, `${site.base}/p`), { cookies: "(none)", ls: "null", idb: "none" }, "no login, localStorage or IndexedDB of session one");
    assert.equal(site.fetches, 2, "the cached script was fetched again in session two");
    agent.sock.destroy();
    await helper.stop(); // a clean close writes the history and cookie stores
    helper = null;

    // History: the address only session one visited is in its History, not in session two's.
    const one = sessionFolder(home, "iso-one"), two = sessionFolder(home, "iso-two");
    assert.ok(fileHolds(join(one, "Default", "History"), "visit=one-only"), "session one's history has the visit");
    assert.equal(fileHolds(join(two, "Default", "History"), "visit=one-only"), false, "session two's history doesn't");
    // Each session's stores in its own folder: Cookies, Login Data, History and a disk cache in both.
    for (const dir of [one, two]) {
      const names = new Set(filesUnder(dir).map((f) => f.path.split(sep).at(-1)));
      for (const store of ["Cookies", "Login Data", "History", "Cache_Data"]) assert.ok(names.has(store), `${store} under ${relative(home, dir)}`);
    }
    // And nowhere else in the home: no store outside a session's folder (Extensions included).
    const sessionDirs = [one, two, sessionFolder(home, "default")];
    const stray = filesUnder(home).filter((f) => STORES.has(f.path.split(sep).at(-1)) && !sessionDirs.some((d) => f.path.startsWith(d + sep)) && !f.path.startsWith(join(home, "runtime") + sep));
    assert.deepEqual(stray.map((f) => relative(home, f.path)), [], "every engine store is under a session's own folder");
  } finally {
    await helper?.stop();
    site.close();
    rmSync(home, { recursive: true, force: true });
  }
});
