// The identity lock (spec server-mode D3, profiles/lock.mjs): a browser profile that pins a seed runs
// in one browser at a time across the instances of one shared home; a holder that is gone (its
// process ended, or its pid is another process's now) is taken over; profiles without a pinned seed
// take no lock, so two sessions on one are two devices. Through the launch's part
// (daemon/sessions/profiles.mjs) as well: a second browser on the same pinned seed is refused naming
// the first, and the close gives the lock back.
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { takeIdentity, identityFile, readIdentityHolder } from "../scripts/profiles/lock.mjs";
import { startOf } from "../scripts/install-lock.mjs";
import { sha256 } from "../scripts/util.mjs";
import { createProfiles } from "../scripts/daemon/sessions/profiles.mjs";
import { createProfileStore } from "../scripts/profiles/store.mjs";
import { createSession, assignProfile } from "../scripts/sessions.mjs";

const root = mkdtempSync(join(tmpdir(), "pb-identity-"));
const children = [];
after(() => { for (const c of children) try { c.kill(); } catch {} rmSync(root, { recursive: true, force: true }); });
let n = 0;
const newDir = () => join(root, `locks-${++n}`);
const SEED = "berlin-desk-7";
const T0 = Date.parse("2026-10-21T10:00:00Z");

// Another live process, as another PairBrowse instance's helper would be.
function liveProcess() {
  const c = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  children.push(c);
  return c;
}
const writeHolder = (dir, holder) => writeFileSync(identityFile(SEED, dir), JSON.stringify(holder), { mode: 0o600 });

test("a pinned seed is exclusive across instances; a dead holder is taken over", { timeout: 20_000 }, async () => {
  const dir = newDir();
  // Taken: one owner-only file named by the seed's SHA-256, the seed itself written nowhere.
  const mine = takeIdentity(SEED, { session: "work", profileId: "p-0123456789abcdef", name: "berlin" }, { dir, instance: "alpha" });
  assert.equal(mine.file, join(dir, `${sha256(SEED)}.lock`));
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(mine.file).mode & 0o777, 0o600);
  assert.ok(!readFileSync(mine.file, "utf8").includes(SEED), "the seed is never written");
  assert.deepEqual({ ...readIdentityHolder(mine.file), token: null }, { pid: process.pid, start: startOf(process.pid), token: null, session: "work", profileId: "p-0123456789abcdef", instance: "alpha" });
  // The same session again (a launch after a close that never came): taken again, the same hold.
  assert.equal(takeIdentity(SEED, { session: "work", profileId: "p-0123456789abcdef" }, { dir, instance: "alpha" }).token, mine.token);
  // Another session in this process: refused, naming the one that has it.
  assert.throws(() => takeIdentity(SEED, { session: "shop", profileId: "p-0123456789abcdef", name: "berlin" }, { dir }),
    (e) => e.code === "PROFILE_IDENTITY_HELD" && /browser profile "berlin" pins its seed, and session "work" of PairBrowse instance "alpha" .*has it open now/.test(e.message));
  mine.release();
  assert.equal(existsSync(mine.file), false, "given back");

  // Another instance's live helper holds it: refused, naming its session, instance and process.
  const other = liveProcess();
  await new Promise((r) => setTimeout(r, 200));
  writeHolder(dir, { pid: other.pid, start: startOf(other.pid), token: "a".repeat(32), session: "travel", profileId: "p-0123456789abcdef", instance: "beta", at: "2026-10-21T09:00:00Z" });
  assert.throws(() => takeIdentity(SEED, { session: "work", profileId: "p-0123456789abcdef", name: "berlin" }, { dir }),
    (e) => e.code === "PROFILE_IDENTITY_HELD" && e.message.includes(`session "travel" of PairBrowse instance "beta" (process ${other.pid}) has it open now: close that browser first, or give this session a profile without a pinned seed; nothing was started.`));
  // A release of a hold that isn't ours leaves it.
  assert.ok(existsSync(identityFile(SEED, dir)));

  // Its pid now another process's (it started at another time): gone, taken over.
  writeHolder(dir, { pid: other.pid, start: "another start", token: "b".repeat(32), session: "travel", profileId: "p-0123456789abcdef", instance: "beta" });
  const taken = takeIdentity(SEED, { session: "work", profileId: "p-0123456789abcdef" }, { dir });
  assert.equal(readIdentityHolder(taken.file).pid, process.pid);
  taken.release();

  // A holder whose process ended: taken over.
  const ended = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  writeHolder(dir, { pid: Number(ended.stdout), start: null, token: "c".repeat(32), session: "old", profileId: "p-0123456789abcdef", instance: null });
  const again = takeIdentity(SEED, { session: "work", profileId: "p-0123456789abcdef" }, { dir });
  assert.equal(readIdentityHolder(again.file).session, "work");
  again.release();
  // Nothing left beside it (no temporary or moved-aside files).
  assert.deepEqual(readdirSync(dir), []);
  // Only a pinned seed takes one.
  assert.throws(() => takeIdentity(null, {}, { dir }), /Only a pinned seed/);
});

test("an empty, cut short or non-JSON lock file is taken over, never blocking the profile for good", () => {
  for (const text of ["", "{\"pid\": 12", "not json", "null"]) {
    const dir = newDir();
    takeIdentity(SEED, { session: "x", profileId: "p-00000000000000aa" }, { dir }).release();
    writeFileSync(identityFile(SEED, dir), text, { mode: 0o600 });
    assert.deepEqual(readIdentityHolder(identityFile(SEED, dir)), { pid: 0, start: null, token: null }, JSON.stringify(text));
    const got = takeIdentity(SEED, { session: "x", profileId: "p-00000000000000aa" }, { dir });
    assert.equal(readIdentityHolder(got.file).token, got.token, JSON.stringify(text));
    assert.deepEqual(readdirSync(dir), [`${sha256(SEED)}.lock`], "the broken one moved aside and removed");
    got.release();
  }
  assert.equal(readIdentityHolder(join(newDir(), "none.lock")), null, "no file: no holder");
});

test("an unpinned profile runs in two sessions with different seeds; a pinned one in one browser at a time", () => {
  const dir = newDir();
  const store = createProfileStore({ dir: join(root, `store-${++n}`), now: () => T0 });
  const loose = store.create({ name: "loose", locale: { languages: ["de-DE"], timezone: "Europe/Berlin", source: "set" } });
  const pinned = store.create({ name: "pinned", persona: { source: "seed", seed: SEED } });
  for (const s of ["pl-a", "pl-b", "pl-c", "pl-d"]) createSession(s);
  assignProfile("pl-a", "loose", { store });
  assignProfile("pl-b", "loose", { store });
  assignProfile("pl-c", "pinned", { store });
  assignProfile("pl-d", "pinned", { store });
  // Two helpers (instances): each holds one browser.
  const helper = () => { const st = {}; return { st, profiles: createProfiles(st, { config: {}, profileStore: store, now: () => T0, platform: "linux", identityDir: dir }) }; };
  const one = helper(), two = helper();
  const OPEN = { browserKind: "pairbrowse-open" };
  const NATIVE = { browserKind: "pairbrowse", build: "155.0.8059.84" };
  // Unpinned: both start, no lock, no seed of the profile's (each session's own, from its folder).
  const a = one.profiles.forLaunch("pl-a", NATIVE), b = two.profiles.forLaunch("pl-b", NATIVE);
  assert.equal(a.id, loose.id);
  assert.equal(b.id, loose.id);
  assert.equal(a.engine.engineKeys.fingerprint, undefined);
  assert.equal(b.engine.engineKeys.fingerprint, undefined);
  assert.equal(existsSync(dir), false, "no identity lock for a profile without a pinned seed");
  one.profiles.release();
  two.profiles.release();
  // Pinned: the first takes it, the second is refused naming the first; after the close, it starts.
  const c = one.profiles.forLaunch("pl-c", NATIVE);
  assert.equal(c.engine.engineKeys.fingerprint, SEED);
  assert.throws(() => two.profiles.forLaunch("pl-d", NATIVE), (e) => /Session "pl-d" doesn't start: browser profile "pinned" pins its seed, and session "pl-c" .*has it open now/.test(e.message));
  assert.equal(two.st.profile, null);
  one.profiles.release();
  assert.equal(two.profiles.forLaunch("pl-d", NATIVE).id, pinned.id);
  // The open build refuses a seed anyway (it can't apply one), before any lock is taken.
  two.profiles.release();
  assert.throws(() => one.profiles.forLaunch("pl-c", OPEN), /seed/);
  assert.deepEqual(readdirSync(dir), [], "nothing held");
});
