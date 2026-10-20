// Fault injection without a browser: corrupt JSON in each state file, a full disk (or read-only
// folder) under the writers, and the wall clock jumping forward and back under the timers that
// read it. Each case: nothing throws where a call is answered, and nothing is lost (a corrupt file
// is copied aside before a writer starts it afresh; a failed write leaves the old file whole).
// The kill cases (browser, helper mid-call) are live: test/integration/faults.test.mjs.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths, loadConfig, saveConfig } from "../scripts/paths.mjs";
import { readJson, writeJsonAtomic, onCorruptJson, spend } from "../scripts/util.mjs";
import { readSavedTabs } from "../scripts/tabs.mjs";
import { readPeople, recordPerson, tabsFile, peopleFile, activityFile, listSessions } from "../scripts/sessions.mjs";
import { saveRun, readRuns, runFile, saveReview, latestReview } from "../scripts/runs.mjs";
import { loadFacts, saveFacts } from "../scripts/facts.mjs";
import { createActivityLog } from "../scripts/daemon/activitylog.mjs";
import { createRecordings } from "../scripts/daemon/toolstab.mjs";
import { createTimeline } from "../scripts/daemon/timeline.mjs";
import { createInvites } from "../scripts/liveview/invites.mjs";
import { createApprovals } from "../scripts/sharing/join.mjs";
import { heartbeatWatch } from "../scripts/tunnels/keeper.mjs";

mkdirSync(paths.home, { recursive: true });
const reported = [];
onCorruptJson((file, copy) => reported.push({ file, copy }));
const BAD = '{"cut short by a full disk": [1, 2';
const corrupt = (file, text = BAD) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, text); };
const keptAside = (file, text = BAD) => existsSync(`${file}.corrupt`) && readFileSync(`${file}.corrupt`, "utf8") === text;

test("readJson: a corrupt file is copied aside once, reported, and the fallback returned; empty or missing files aren't copied", () => {
  const f = join(paths.home, "probe.json");
  corrupt(f);
  reported.length = 0;
  assert.deepEqual(readJson(f, { fallback: 1 }), { fallback: 1 });
  assert.ok(keptAside(f));
  assert.deepEqual(reported, [{ file: f, copy: `${f}.corrupt` }]);
  readJson(f);
  assert.equal(reported.length, 1, "the same contents aren't kept twice");
  corrupt(f, "{ other");
  readJson(f);
  const copies = readdirSync(paths.home).filter((n) => n.startsWith("probe.json.corrupt"));
  assert.equal(copies.length, 2, "different contents: a second copy, the first kept");
  assert.ok(keptAside(f), "the first copy unchanged");
  if (process.platform !== "win32") assert.equal(statSync(`${f}.corrupt`).mode & 0o777, 0o600, "owner-only");
  const empty = join(paths.home, "empty.json");
  writeFileSync(empty, "  \n");
  assert.equal(readJson(empty, 7), 7);
  assert.ok(!existsSync(`${empty}.corrupt`));
  assert.equal(readJson(join(paths.home, "missing.json"), 8), 8);
  assert.ok(!existsSync(join(paths.home, "missing.json.corrupt")));
});

test("corrupt config.json: defaults and a warning, never a throw on load; a save refuses rather than replace it", () => {
  corrupt(paths.config);
  const before = readFileSync(paths.config, "utf8");
  const config = loadConfig();
  assert.equal(config.maxTabs, 20);
  assert.ok(keptAside(paths.config));
  assert.throws(() => saveConfig({ maxTabs: 9 }), /isn't valid JSON.*nothing was written/);
  assert.equal(readFileSync(paths.config, "utf8"), before, "what it held stays in place");
  assert.ok(keptAside(paths.config));
  rmSync(paths.config);
  rmSync(`${paths.config}.corrupt`);
});

test("corrupt session files (tabs, people, activity): read as empty, kept aside before the next write", async () => {
  const name = "work";
  mkdirSync(join(paths.sessions, name), { recursive: true });
  for (const f of [tabsFile(name), peopleFile(name), activityFile(name)]) corrupt(f);
  assert.deepEqual(readSavedTabs(tabsFile(name)), { tabs: [], active: 0 });
  assert.ok(keptAside(tabsFile(name)));
  assert.ok(listSessions().some((s) => s.name === name), "the session still lists");
  assert.deepEqual(readPeople(name), []);
  recordPerson(name, { who: "Ann", app: "Claude Code", kind: "you" });
  assert.equal(readPeople(name)[0].who, "Ann");
  assert.ok(keptAside(peopleFile(name)));
  const log = createActivityLog({ where: () => ({ name, file: activityFile(name) }), saveMs: 0 });
  log.add({ t: Date.now(), text: "Clicked Save", who: "Ann" });
  log.flush?.();
  assert.match(readFileSync(activityFile(name), "utf8"), /Clicked Save/);
  assert.ok(keptAside(activityFile(name)));
});

test("corrupt runs, review, recordings and timeline index: the callers go on, each file kept aside", async () => {
  corrupt(runFile("Shop setup"));
  assert.deepEqual(readRuns().filter((r) => r.name === "Shop setup"), []);
  saveRun({ name: "Shop setup", status: "in progress", done: ["Opened the form"] });
  assert.equal(readJson(runFile("Shop setup")).done[0], "Opened the form");
  assert.ok(keptAside(runFile("Shop setup")));
  const review = join(paths.reviews, "latest.json");
  corrupt(review);
  assert.equal(latestReview(), null);
  assert.ok(keptAside(review));
  saveReview({ site: "x.example", checks: [{ rule: "ok", pass: true }] });

  corrupt(paths.recordings);
  const recordings = createRecordings();
  assert.deepEqual(recordings.list(), []);
  assert.ok(keptAside(paths.recordings));

  const dir = join(paths.home, "tl");
  corrupt(join(dir, "index.json"));
  const timeline = createTimeline({ dir: () => dir });
  assert.deepEqual(await timeline.cards(), []);
  assert.ok(keptAside(join(dir, "index.json")));
});

test("corrupt facts.json: nothing remembered, and never overwritten (a save is refused with what to do)", () => {
  const f = join(paths.home, "facts-test.json");
  corrupt(f);
  const lines = [];
  assert.deepEqual(loadFacts(f, (l) => lines.push(l)), []);
  assert.match(lines[0], /can't be read; nothing is remembered or saved until it's fixed or removed/);
  assert.throws(() => saveFacts([{ label: "Name", value: "Ann" }], f), /isn't overwritten\. Fix or remove it/);
  assert.equal(readFileSync(f, "utf8"), BAD);
});

test("a full disk (a folder that can't be written): the write fails, the old file stays whole, no .tmp is left", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const dir = join(paths.home, "full");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "state.json");
  writeJsonAtomic(f, { kept: true });
  chmodSync(dir, 0o500);
  try {
    assert.throws(() => writeJsonAtomic(f, { kept: false }), /EACCES|EPERM/);
    assert.throws(() => saveConfig({ maxTabs: 3 }, f), /EACCES|EPERM/);
  } finally { chmodSync(dir, 0o700); }
  assert.deepEqual(readJson(f), { kept: true });
  assert.deepEqual(readdirSync(dir), ["state.json"]);
});

test("a write cut off after its .tmp was written (the rename fails): the error reaches the caller, the old file stays, the .tmp is removed", () => {
  const dir = join(paths.home, "enospc");
  const f = join(dir, "state.json");
  mkdirSync(join(f, "in-the-way"), { recursive: true }); // a folder where the file goes: the rename can't replace it
  assert.throws(() => writeJsonAtomic(f, { lost: false }), /EISDIR|ENOTEMPTY|EEXIST|EPERM/);
  assert.deepEqual(readdirSync(dir), ["state.json"], "no .tmp left beside it");
  assert.deepEqual(readdirSync(f), ["in-the-way"]);
  // The writers that run in the background say so and go on: the activity log, people, tabs.
  const logged = [];
  const log = createActivityLog({ where: () => ({ name: "x", file: join(dir, "missing-dir", "\0bad") }), saveMs: 0, log: (l) => logged.push(l) });
  assert.doesNotThrow(() => { log.add({ t: Date.now(), text: "Typed", who: "Ann" }); log.flush?.(); });
  assert.match(logged.join("\n"), /activity log:/);
});

test("clock jumps: a rate limit set back by an hour doesn't hold; join requests aren't refused as busy", () => {
  const holder = {};
  const t = 10_000_000;
  for (let i = 0; i < 5; i++) assert.ok(spend(holder, "n", 5, { t: t + i }));
  assert.equal(spend(holder, "n", 5, { t: t + 10 }), false, "the limit holds in its window");
  assert.ok(spend(holder, "n", 5, { t: t - 3_600_000 }), "the clock went back an hour: the old entries no longer count");
  assert.ok(spend(holder, "n", 5, { t: t + 3_600_000 }), "and forward an hour: they're long past");

  let now = 50_000_000;
  const approvals = createApprovals({ now: () => now, maxNew: 2, maxPending: 10 });
  const invite = { id: "abcd1234" };
  const id = (n) => String(n).padStart(32, "0");
  assert.equal(approvals.check(invite, id(1), "A").state, "pending");
  assert.equal(approvals.check(invite, id(2), "B").state, "pending");
  assert.equal(approvals.check(invite, id(3), "C").state, "busy");
  now -= 3_600_000;
  assert.equal(approvals.check(invite, id(4), "D").state, "pending", "after the clock went back, a new request is taken");
});

test("clock jumps: an invite never outlives its hours when the clock goes back, and ends when it jumps past", () => {
  let now = 1_000_000_000, mono = 0;
  const invites = createInvites({ now: () => now, mono: () => mono });
  const inv = invites.create({ role: "watch", hours: 1 });
  now -= 24 * 3_600_000; // the clock set back a day
  mono += 30 * 60_000;
  assert.ok(invites.get(inv.id), "half its hour: still valid");
  mono += 31 * 60_000;
  assert.equal(invites.get(inv.id), null, "its hour has passed on the clock that doesn't jump");
  const second = invites.create({ role: "watch", hours: 1 });
  now += 2 * 3_600_000; // the wall clock jumps past its end
  assert.equal(invites.get(second.id), null);
  // Restored after a restart: what's left of it, from then on.
  const third = createInvites({ now: () => now, mono: () => mono });
  const code = { id: "0123abcd", key: "a".repeat(64), share: "code", role: "drive", mode: "shared", label: "x", createdAt: now - 30 * 60_000, expiresAt: now + 30 * 60_000 };
  assert.equal(third.restore([code]), 1);
  now -= 3_600_000;
  mono += 31 * 60_000;
  assert.equal(third.get(code.id), null);
});

test("clock jumps: the tunnel keeper's heartbeat watch goes by a clock that doesn't jump", () => {
  let mtime = 1_000, mono = 0;
  const gone = heartbeatWatch({ grace: 120_000, touched: () => mtime, mono: () => mono });
  mono += 60_000; mtime = 1_000 + 3_600_000 * 5; // the wall clock jumps forward five hours, the helper touches it
  assert.equal(gone(), false);
  mono += 100_000; mtime -= 3_600_000 * 10; // set back ten hours: still touched
  assert.equal(gone(), false);
  mono += 121_000; // no touch for longer than the grace: the helper is gone
  assert.equal(gone(), true);
  const missing = heartbeatWatch({ grace: 1000, touched: () => 0, mono: () => mono });
  assert.equal(missing(), false);
  mono += 1001;
  assert.equal(missing(), true, "no heartbeat at all: gone after the grace");
});
