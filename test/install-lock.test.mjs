// The install lock (scripts/install-lock.mjs): its holder named by pid, start time and a token of
// its own; a reused pid counts as gone; a release never removes a lock taken over since; and only
// one call chain is re-entrant.
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withInstallLock, withInstallLockSync, startOf, holderAlive } from "../scripts/install-lock.mjs";

const scratch = mkdtempSync(join(tmpdir(), "pb-lock-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const lockFile = () => { const d = join(scratch, String(n++)); mkdirSync(d); return join(d, "install.lock"); };

test("the lock names its holder by pid, start time and a token", async () => {
  const file = lockFile();
  await withInstallLock(async () => {
    const h = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(h.pid, process.pid);
    assert.match(h.token, /^[0-9a-f]{32}$/);
    if (process.platform !== "win32") assert.equal(h.start, startOf(process.pid));
  }, { file });
  assert.equal(existsSync(file), false);
});

test("start time: known for this process on POSIX, stable, and absent for no process", () => {
  if (process.platform === "win32") return;
  const a = startOf(process.pid);
  assert.ok(a, "this process's start time");
  assert.equal(startOf(process.pid), a);
  assert.equal(startOf(0), null);
  assert.equal(startOf(2 ** 22 + 12345), null, "no such process");
});

test("a live pid that started at another time (a pid used again after a reboot) is not the holder", () => {
  const alive = () => true;
  assert.equal(holderAlive({ pid: 42, start: "then" }, { alive, started: () => "now" }), false);
  assert.equal(holderAlive({ pid: 42, start: "now" }, { alive, started: () => "now" }), true);
  assert.equal(holderAlive({ pid: 42, start: null }, { alive, started: () => "now" }), true, "an older plain-pid lock: by pid");
  assert.equal(holderAlive({ pid: 42, start: "now" }, { alive: () => false, started: () => "now" }), false);
});

test("a lock left with this live pid but another start time is taken over at once", async () => {
  if (process.platform === "win32") return;
  const file = lockFile();
  writeFileSync(file, JSON.stringify({ pid: process.pid, start: "Thu Jan  1 00:00:00 1970", token: "x".repeat(32) })); chmodSync(file, 0o600);
  const t = Date.now();
  assert.equal(await withInstallLock(async () => "took", { file, waitMs: 2000 }), "took");
  assert.ok(Date.now() - t < 1500);
  // The sync form too: it would otherwise block the thread for the whole wait.
  writeFileSync(file, JSON.stringify({ pid: process.pid, start: "Thu Jan  1 00:00:00 1970", token: "y".repeat(32) }));
  assert.equal(withInstallLockSync(() => "took", { file, waitMs: 2000 }), "took");
});

test("a release never removes a lock that another holder took over since", async () => {
  const file = lockFile();
  const other = JSON.stringify({ pid: process.pid + 1, start: "later", token: "z".repeat(32) });
  await withInstallLock(async () => { writeFileSync(file, other); }, { file }); // taken over while held
  assert.equal(readFileSync(file, "utf8"), other, "the new holder's lock stays");
  rmSync(file);
  withInstallLockSync(() => { writeFileSync(file, other); }, { file });
  assert.equal(readFileSync(file, "utf8"), other);
  rmSync(file);
});

test("the holder keeps the lock fresh, so a long install isn't taken for a stale one", async () => {
  const file = lockFile();
  await withInstallLock(async () => {
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    await new Promise((r) => setTimeout(r, 1300)); // staleMs 3000: touched every second
    assert.ok(Date.now() - statSync(file).mtimeMs < 1500, "touched while held");
  }, { file, staleMs: 3000 });
});

test("two unrelated installs in one process take turns; nested calls along one chain don't wait", async () => {
  const file = lockFile();
  const order = [];
  const slow = (name) => withInstallLock(async () => { order.push(`${name}+`); await new Promise((r) => setTimeout(r, 40)); order.push(`${name}-`); }, { file });
  await Promise.all([slow("a"), slow("b"), slow("c")]);
  assert.deepEqual(order, ["a+", "a-", "b+", "b-", "c+", "c-"]);
  // Nested, async in async (across awaits), sync in async, sync in sync.
  assert.equal(await withInstallLock(async () => { await new Promise((r) => setTimeout(r, 5)); return withInstallLock(async () => 7, { file }); }, { file }), 7);
  assert.equal(await withInstallLock(async () => withInstallLockSync(() => 8, { file }), { file }), 8);
  assert.equal(withInstallLockSync(() => withInstallLockSync(() => 9, { file }), { file }), 9);
  assert.equal(existsSync(file), false);
  // The sync form, while an unrelated async install in this process holds it: refused at once,
  // never a blocked thread waiting on itself.
  let release;
  const holding = withInstallLock(() => new Promise((r) => { release = r; }), { file });
  await new Promise((r) => setTimeout(r, 20));
  const t = Date.now();
  assert.throws(() => withInstallLockSync(() => 1, { file, waitMs: 5000 }), /another PairBrowse install is still running/);
  assert.ok(Date.now() - t < 1000);
  release();
  await holding;
  assert.equal(existsSync(file), false);
});
