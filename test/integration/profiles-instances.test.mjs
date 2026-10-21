// Browser profiles across the instances of one account (spec server-mode Phase D, "Concurrent use",
// D2, D3): two named instances (PAIRBROWSE_INSTANCE) each keep their own profiles and sessions, so
// a login made in one is absent in the other and neither lists the other's profiles; one session
// can't open in two browsers (a second helper on the same instance leaves without starting one,
// and the person's reassignment of a session open now is refused). The same pinned seed refused in
// a second instance needs the native build: test/optin/profiles-native.test.mjs. Live: real helpers
// and browsers (PAIRBROWSE_TEST_RUNTIME), one browser at a time, under an account folder of the
// test's own ($HOME pointed at it; the person's ~/.pairbrowse is never touched).
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { session, testBase, attachDaemon } from "../helpers/live.mjs";
import { text, until } from "../helpers/util.mjs";
import { root, testBrowser, linkInstalls, stopDaemon } from "../helpers/daemon.mjs";
import { startProbeSite, probe, profilesCli, sessionFolder, browserFolder, BROWSER_KIND } from "../helpers/profiles-live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const SETTINGS = (languages) => ({ browser: { kind: BROWSER_KIND }, locale: { languages, timezone: null, source: "set" } });

test("two instances on separate profiles share nothing; one session can't open in two browsers", { skip: !runtime && "set PAIRBROWSE_TEST_RUNTIME", timeout: 240_000 }, async () => {
  const site = await startProbeSite();
  const base = testBase();
  mkdirSync(base, { recursive: true });
  const account = mkdtempSync(join(base, "pbi-"));
  const shared = join(account, ".pairbrowse");
  mkdirSync(shared, { recursive: true });
  linkInstalls(shared, runtime);
  // An instance's environment: this account folder, the instance named, no PAIRBROWSE_HOME.
  const envOf = (name) => { const env = { ...process.env, HOME: account, PAIRBROWSE_INSTANCE: name }; delete env.PAIRBROWSE_HOME; return env; };
  const homeOf = (name) => join(shared, "instances", name);
  for (const name of ["ia", "ib"]) {
    mkdirSync(homeOf(name), { recursive: true });
    writeFileSync(join(homeOf(name), "config.json"), JSON.stringify({ ...testBrowser(runtime), browserArgs: ["--headless=new"], display: "none", screenshots: false, sessionPicker: false }));
  }
  const start = async (name) => {
    const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: account, env: envOf(name), stdio: "ignore" });
    const sock = await attachDaemon({ socketPath: join(homeOf(name), "run", "browser.sock"), daemon, home: homeOf(name) });
    sock.destroy();
    return daemon;
  };
  const cli = (name, args) => profilesCli(null, args, envOf(name));
  const running = [];
  try {
    assert.equal(cli("ia", ["create", "alpha", "--settings", JSON.stringify(SETTINGS(["de-DE"]))]).code, 0);
    assert.equal(cli("ib", ["create", "beta", "--settings", JSON.stringify(SETTINGS(["fr-FR"]))]).code, 0);
    assert.doesNotMatch(cli("ib", ["list"]).out, /alpha/, "an instance lists its own profiles only");

    // Instance ia: a login in its session "work" on alpha.
    const a = await start("ia");
    running.push(a);
    let agent = await session(join(homeOf("ia"), "run", "browser.sock"), "a");
    assert.match(text(await agent.tool("pairbrowse_session", { action: "new", name: "work", profile: "alpha" })), /on browser profile "alpha"/);
    assert.equal((await probe(agent, `${site.base}/p?set=1`)).ls, "kept");
    assert.match(readlinkSync(join(browserFolder(homeOf("ia"), "work"), "SingletonLock")), /-\d+$/, "the browser holds the session's folder");
    // One session, one browser: a second helper on the same instance leaves without a browser...
    const second = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: account, env: envOf("ia"), stdio: "ignore" });
    const code = await new Promise((r) => second.once("exit", r));
    assert.equal(code, 0);
    await until("the second helper's leaving logged", () => /another daemon is running; exiting/.test(readFileSync(join(homeOf("ia"), "daemon.log"), "utf8")), 10_000);
    // ...and the person can't move the open session to another profile.
    assert.equal(cli("ia", ["create", "alpha2"]).code, 0);
    const moved = cli("ia", ["assign", "work", "alpha2"]);
    assert.equal(moved.code, 1);
    assert.match(moved.err, /Session "work" is open in a browser now/);
    agent.sock.destroy();
    await stopDaemon(a);

    // Instance ib: its own session "work" on beta has none of ia's login or storage.
    const b = await start("ib");
    running.push(b);
    agent = await session(join(homeOf("ib"), "run", "browser.sock"), "b");
    assert.match(text(await agent.tool("pairbrowse_session", { action: "profiles" })), /beta/);
    assert.doesNotMatch(text(await agent.tool("pairbrowse_session", { action: "profiles" })), /alpha/);
    assert.match(text(await agent.tool("pairbrowse_session", { action: "new", name: "work", profile: "beta" })), /on browser profile "beta"/);
    assert.deepEqual(await probe(agent, `${site.base}/p`), { cookies: "(none)", ls: "null", idb: "none" }, "nothing of instance ia");
    agent.sock.destroy();
    await stopDaemon(b);
    assert.notEqual(sessionFolder(homeOf("ia"), "work"), sessionFolder(homeOf("ib"), "work"));
    assert.equal(existsSync(join(shared, "sessions")), false, "no session in the account's default home");
  } finally {
    for (const d of running) await stopDaemon(d);
    site.close();
    rmSync(account, { recursive: true, force: true });
  }
});
