// The first-start move to browser profiles and its undo on a real home (spec server-mode Phase D,
// "Migration"): a home in today's layout (a session with a login, no profile files) is moved at the
// helper's first launch, each session on "default", with its login kept; `cli.mjs migrate --undo`
// then puts the layout back file for file, and the session's own folder, opened as a PairBrowse
// from before profiles would open it, still has the login. Live: a real helper and browser
// (PAIRBROWSE_TEST_RUNTIME); one browser at a time.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { session, patchright } from "../helpers/live.mjs";
import { text } from "../helpers/util.mjs";
import { helperHome, startHelper, driverBrowserPath, nativeExe } from "../helpers/daemon.mjs";
import { startProbeSite, probe, profilesCli, browserFolder, assignmentPath, bindingPath, CHECKED_ON } from "../helpers/profiles-live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;

test("today's layout migrates with cookies kept; undo then the previous layout launches with the same cookies", { skip: !runtime && "set PAIRBROWSE_TEST_RUNTIME", timeout: 240_000 }, async () => {
  const site = await startProbeSite();
  const home = helperHome(runtime, { prefix: "pb-prof-move-", config: { sessionPicker: false } });
  let helper = null;
  // The profile layer's files of a session: what the migration writes and the undo puts back.
  const layer = (name) => [assignmentPath(home, name), bindingPath(home, name)].map((f) => (existsSync(f) ? readFileSync(f, "utf8") : null));
  try {
    // A session with a login, then today's layout: the profile files taken away by an undo.
    helper = await startHelper(home);
    let agent = await session(helper.socketPath, "a");
    assert.match(text(await agent.tool("pairbrowse_session", { action: "new", name: "shop" })), /Created and switched/);
    assert.equal((await probe(agent, `${site.base}/p?set=1`)).ls, "kept");
    agent.sock.destroy();
    await helper.stop();
    helper = null;
    let undo = profilesCli(home, ["migrate", "--undo"]);
    assert.equal(undo.code, 0, undo.err);
    const today = layer("shop");
    assert.deepEqual(today, [null, null], "no profile files: today's layout");
    assert.equal(existsSync(join(home, "browser-profiles")), false);

    // The first start moves it: shop on "default", bound, its login kept.
    helper = await startHelper(home);
    agent = await session(helper.socketPath, "b");
    assert.match(text(await agent.tool("pairbrowse_session", { action: "use", name: "shop" })), /Now using session "shop"/);
    assert.deepEqual(await probe(agent, `${site.base}/p`), { cookies: "login=kept", ls: "kept", idb: "kept" }, "the login and storage kept through the move");
    assert.match(text(await agent.tool("pairbrowse_status", { kind: "agent", text: "checking" })), new RegExp(`Profile: default \\(rev 1, ${CHECKED_ON}\\)`));
    agent.sock.destroy();
    await helper.stop();
    helper = null;
    const record = JSON.parse(readFileSync(join(home, "browser-profiles", "migration.json"), "utf8"));
    assert.equal(record.status, "done");
    assert.ok(record.sessions.some((s) => s.name === "shop"));
    assert.equal(JSON.parse(readFileSync(assignmentPath(home, "shop"), "utf8")).profileId, record.defaultId);
    assert.equal(JSON.parse(readFileSync(bindingPath(home, "shop"), "utf8")).profileId, record.defaultId);
    assert.match(readFileSync(join(home, "daemon.log"), "utf8"), /launch: sessions moved to browser profiles \(each on "default"\)/);
    // The person's migrate finds it done (the same lock and record as the helper's).
    const again = profilesCli(home, ["migrate"]);
    assert.match(again.out, /was moved to browser profiles on .* already/);

    // Undo: refused while a helper runs, then the layout back file for file.
    helper = await startHelper(home);
    const busy = profilesCli(home, ["migrate", "--undo"]);
    assert.equal(busy.code, 1);
    assert.match(busy.err, /helper is running on this home/);
    await helper.stop();
    helper = null;
    undo = profilesCli(home, ["migrate", "--undo"]);
    assert.equal(undo.code, 0, undo.err);
    assert.match(undo.out, /Put back \d+ sessions?; removed /);
    assert.deepEqual(layer("shop"), today, "the session's profile files as before the move");
    assert.equal(existsSync(join(home, "browser-profiles")), false);
    assert.equal(existsSync(join(home, "engine-profiles")), false);

    // The previous layout: the session's folder opened as a PairBrowse from before profiles would
    // (the same folder, nothing of profiles read) has the same login and storage. The native build
    // keeps them in the session's pairbrowse-native folder, its cookies under this home's Safe
    // Storage key (browser/safe-storage.mjs), so it opens that folder with that key, as the helper does.
    const ctx = await patchright(runtime).chromium.launchPersistentContext(browserFolder(home, "shop"), nativeExe
      ? { executablePath: nativeExe, headless: true, args: [`--pairbrowse-safe-storage-key-file=${join(home, "safe-storage-key")}`], ignoreDefaultArgs: ["--use-mock-keychain"] }
      : { executablePath: driverBrowserPath(runtime), headless: true });
    try {
      const page = ctx.pages()[0] || await ctx.newPage();
      await page.goto(`${site.base}/p`);
      await page.getByText("done").waitFor({ timeout: 15_000 });
      assert.match(await page.textContent("body"), /cookies: login=kept[\s\S]*storage: ls=kept idb=kept done/);
    } finally { await ctx.close(); }
  } finally {
    await helper?.stop();
    site.close();
    rmSync(home, { recursive: true, force: true });
  }
});
