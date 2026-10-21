// A session keeps its browser profile across a helper restart (spec server-mode Phase D,
// "Persistence"): made on a profile the person created (scripts/profiles/cli.mjs), it reopens after
// the helper stops and starts again on the same profile and revision, with its login (a persistent
// cookie), localStorage and IndexedDB, and the folder still bound to that profile. Live: a real
// helper and browser (PAIRBROWSE_TEST_RUNTIME).
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { session } from "../helpers/live.mjs";
import { text } from "../helpers/util.mjs";
import { helperHome, startHelper } from "../helpers/daemon.mjs";
import { startProbeSite, probe, profilesCli, bindingPath, assignmentPath, BROWSER_KIND, CHECKED_ON } from "../helpers/profiles-live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const SHOP = { browser: { kind: BROWSER_KIND }, locale: { languages: ["de-DE"], timezone: null, source: "set" }, window: { width: 1280, height: 860 } };

test("after a helper restart the session reopens on its profile and revision with its cookie and storage", { skip: !runtime && "set PAIRBROWSE_TEST_RUNTIME", timeout: 180_000 }, async () => {
  const site = await startProbeSite();
  const home = helperHome(runtime, { prefix: "pb-prof-keep-", config: { sessionPicker: false } });
  let helper = null;
  try {
    const made = profilesCli(home, ["create", "shop", "--settings", JSON.stringify(SHOP)]);
    assert.equal(made.code, 0, made.err);
    const id = /\((p-[0-9a-f]{16})\), revision 1/.exec(made.out)?.[1];
    assert.ok(id, made.out);

    helper = await startHelper(home);
    let agent = await session(helper.socketPath, "a");
    assert.match(text(await agent.tool("pairbrowse_session", { action: "profiles" })), /shop/);
    assert.match(text(await agent.tool("pairbrowse_session", { action: "new", name: "keep", profile: "shop" })), /Created and switched.* on browser profile "shop"/s);
    assert.deepEqual(await probe(agent, `${site.base}/p?set=1`), { cookies: "(none)", ls: "kept", idb: "kept" });
    assert.deepEqual(await probe(agent, `${site.base}/p`), { cookies: "login=kept", ls: "kept", idb: "kept" });
    assert.match(text(await agent.tool("pairbrowse_status", { kind: "agent", text: "checking" })), new RegExp(`Profile: shop \\(rev 1, ${CHECKED_ON}\\)`));
    agent.sock.destroy();
    await helper.stop();
    helper = null;
    assert.equal(JSON.parse(readFileSync(assignmentPath(home, "keep"), "utf8")).profileId, id);
    assert.equal(JSON.parse(readFileSync(bindingPath(home, "keep"), "utf8")).profileId, id);

    helper = await startHelper(home);
    agent = await session(helper.socketPath, "b");
    assert.match(text(await agent.tool("pairbrowse_session", { action: "use", name: "keep" })), /Now using session "keep"/);
    assert.deepEqual(await probe(agent, `${site.base}/p`), { cookies: "login=kept", ls: "kept", idb: "kept" }, "login and storage came back");
    assert.match(text(await agent.tool("pairbrowse_status", { kind: "agent", text: "checking" })), new RegExp(`Profile: shop \\(rev 1, ${CHECKED_ON}\\)`), "the same profile and revision");
    const log = readFileSync(join(home, "daemon.log"), "utf8");
    assert.equal(log.match(new RegExp(`launch: Session "keep" on browser profile "shop" \\(${id}\\), revision 1`, "g"))?.length, 2, "both starts on it");
    agent.sock.destroy();
  } finally {
    await helper?.stop();
    site.close();
    rmSync(home, { recursive: true, force: true });
  }
});
