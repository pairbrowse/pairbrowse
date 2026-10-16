// Agents that come and go: a connected agent shows only once it called a tool, stops showing when
// its connection closes (at once) or after it has been quiet too long (PAIRBROWSE_TEST_UNSEEN_MS),
// and the same app session back within the grace (PAIRBROWSE_TEST_RESUME_GRACE_MS: a restarted
// bridge) keeps its label and color. Live: a real helper and browser (PAIRBROWSE_TEST_RUNTIME).
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { session, testBase } from "../helpers/live.mjs";
import { sleep, text } from "../helpers/util.mjs";
import { spawnDaemon, stopDaemon } from "../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;

test("idle connections stay off the board; a closed one leaves at once; a resumed one keeps its label and color", { skip: !runtime, timeout: 120_000 }, async () => {
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  const base = testBase();
  mkdirSync(base, { recursive: true });
  const h = mkdtempSync(join(base, "dep-"));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, browserArgs: ["--headless=new"], display: "none", screenshots: false }));
  const daemon = spawnDaemon(h, { env: { PAIRBROWSE_TEST_UNSEEN_MS: "6000", PAIRBROWSE_TEST_RESUME_GRACE_MS: "3000" } });
  const open = [];
  const connect = async (name, parent) => { const s = await session(join(h, "run", "browser.sock"), name, parent ? { pairbrowseParent: parent } : {}); open.push(s); return s; };
  const state = async (s) => JSON.parse(text(await s.tool("pairbrowse_collaboration", { action: "status" })));
  const shown = async (s) => (await state(s)).participants.map((p) => p.id);
  try {
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);

    const alice = await connect("a", 70001);
    await connect("q", 70002); // a Claude Code window left open: connected, never calls
    const me = await state(alice);
    assert.deepEqual(me.participants.map((p) => p.id), [me.self], "only the agent that called shows, not the quiet connection");
    const { label, color } = me.participants[0];

    const bob = await connect("b", 70003);
    const bobId = (await state(bob)).self;
    assert.deepEqual((await shown(bob)).sort(), [me.self, bobId].sort());

    // Alice's bridge restarts: she leaves the board at once, and comes back as herself.
    alice.sock.destroy();
    await sleep(300);
    assert.deepEqual(await shown(bob), [bobId], "a closed connection is off the board at once");
    const alice2 = await connect("a2", 70001);
    const back = await state(alice2);
    assert.notEqual(back.self, me.self, "a new connection");
    const again = back.participants.find((p) => p.id === back.self);
    assert.equal(again.label, label, "the same app session within the grace keeps its label");
    assert.equal(again.color, color, "and its color");
    assert.match(readFileSync(join(h, "daemon.log"), "utf8"), new RegExp(`participant ${back.self} resumes ${me.self}`));

    // Past the grace it's someone new: nothing of the old one is held.
    const carol = await connect("c", 70004);
    const c1 = await state(carol);
    carol.sock.destroy();
    await sleep(3500);
    const carol2 = await connect("c2", 70004);
    const c2 = await state(carol2);
    assert.notEqual(c2.participants.find((p) => p.id === c2.self).label, c1.participants.find((p) => p.id === c1.self).label, "past the grace: a new identity");
    assert.ok(!(await shown(bob)).includes(c1.self), "the old one is gone for good");

    // Quiet past UNSEEN_MS while connected: off the board until it calls again.
    await sleep(6500);
    assert.deepEqual(await shown(bob), [bobId], "quiet agents stop showing; the one calling shows");
    assert.ok((await shown(alice2)).includes(back.self), "a call brings it back");
  } finally {
    if (process.env.PB_DEBUG) console.log("LOG\n" + (() => { try { return readFileSync(join(h, "daemon.log"), "utf8"); } catch { return ""; } })());
    for (const s of open) s.sock.destroy();
    await stopDaemon(daemon);
    rmSync(h, { recursive: true, force: true });
  }
});
