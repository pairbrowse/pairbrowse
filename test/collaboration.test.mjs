import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserCoordinator } from "../scripts/collaboration.mjs";

const setup = () => { let now = 1000; const c = new BrowserCoordinator({ now: () => now }); return { c, advance: (n) => { now += n; } }; };

test("serializes actions FIFO and exposes active participant", async () => {
  const { c } = setup(); c.register("a", "Alice"); c.register("b", "Bob");
  const order = []; let release;
  const first = c.run("a", async () => { order.push("a:start"); await new Promise((r) => { release = r; }); order.push("a:end"); });
  const second = c.run("b", async () => order.push("b:second"));
  await Promise.resolve();
  assert.deepEqual(c.state().active, { id: "a", label: "Alice" });
  release(); await Promise.all([first, second]); assert.deepEqual(order, ["a:start", "a:end", "b:second"]);
});

test("lease excludes another peer and labels are sanitized", async () => {
  const { c } = setup(); c.register("a", "A\n".repeat(80)); c.register("b", "Bob"); c.acquire("a");
  assert.equal(c.state().participants[0].label, "A".repeat(60));
  await assert.rejects(c.run("b", async () => {}), /A{60}/);
});

test("queued work notices disconnect", async () => {
  const { c } = setup(); c.register("a", "Alice"); c.register("b", "Bob"); let release;
  const first = c.run("a", () => new Promise((r) => { release = r; }));
  const queued = c.run("b", async () => {}); c.unregister("b"); await Promise.resolve(); release(); await first;
  await assert.rejects(queued, /not registered/);
});

test("leases expire lazily", () => {
  const { c, advance } = setup(); c.register("a", "Alice"); c.acquire("a"); advance(120001);
  assert.equal(c.state().owner, null); c.register("b", "Bob"); assert.doesNotThrow(() => c.acquire("b"));
});

test("explicit lease can renew, and another peer cannot release it", () => {
  const { c, advance } = setup(); c.register("a", "Alice"); c.register("b", "Bob");
  c.acquire("a"); const firstExpiry = c.state().owner.expiresAt; advance(1000); c.acquire("a");
  assert.ok(c.state().owner.expiresAt > firstExpiry);
  assert.throws(() => c.release("b"), /Alice/);
  c.release("a"); assert.equal(c.state().owner, null);
});

test("tasks in different tabs run at the same time; one tab takes turns; a browser-wide task waits for all", async () => {
  const c = new BrowserCoordinator();
  c.register("a", "A");
  c.register("b", "B");
  const log = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const task = (name, ms) => async () => { log.push(`${name}+`); await sleep(ms); log.push(`${name}-`); };
  const tab1 = {}, tab2 = {};
  await Promise.all([c.run("a", task("a1", 100), tab1), c.run("b", task("b2", 100), tab2)]);
  assert.deepEqual(log.slice(0, 2).sort(), ["a1+", "b2+"], "two tabs at once: both start before either ends");
  log.length = 0;
  await Promise.all([c.run("a", task("x", 40), tab1), c.run("b", task("y", 40), tab1)]);
  assert.deepEqual(log, ["x+", "x-", "y+", "y-"], "one tab: in turn");
  log.length = 0;
  await Promise.all([c.run("a", task("t1", 60), tab1), c.run("b", task("all", 20)), c.run("a", task("t2", 20), tab2)]);
  assert.deepEqual(log, ["t1+", "t1-", "all+", "all-", "t2+", "t2-"], "the browser-wide task waits for the tab before it, and the tab after waits for it");
  assert.equal(c.isActing("a"), false);
});

test("untilSeen: an agent shows once it called a tool, stops showing when quiet too long or hidden, and comes back when it calls again", () => {
  let now = 1000;
  const changes = [];
  const c = new BrowserCoordinator({ now: () => now, untilSeen: true, unseenMs: 30 * 60_000, onChange: (s) => changes.push(s.participants.map((p) => p.id).join(",")) });
  c.register("a", "Claude a"); c.register("b", "Codex b");
  assert.deepEqual(c.state().participants, [], "connected only (a window left open): nobody shows");
  c.seen("a");
  assert.deepEqual(c.state().participants.map((p) => p.id), ["a"]);
  assert.equal(changes.at(-1), "a", "showing is news");
  c.register("a", "Alice · Claude Code");
  assert.deepEqual(c.state().participants, [{ id: "a", label: "Alice · Claude Code" }], "a relabel keeps it shown");
  now += 29 * 60_000;
  assert.deepEqual(c.sweep(), [], "quiet, not yet long");
  now += 2 * 60_000;
  assert.deepEqual(c.sweep(), ["a"], "quiet 31 minutes: it stops showing, told once");
  assert.deepEqual(c.sweep(), []);
  assert.deepEqual(c.state().participants, []);
  c.seen("a");
  assert.deepEqual(c.state().participants.map((p) => p.id), ["a"], "a call brings it back");
  c.hide("a");
  assert.deepEqual(c.state().participants, [], "its connection closed: gone at once");
  assert.ok(c.participants.has("a"), "still registered for a resume");
  assert.deepEqual(c.shown(), []);
  const plain = new BrowserCoordinator();
  plain.register("x", "X");
  assert.deepEqual(plain.state().participants.map((p) => p.id), ["x"], "without untilSeen every registered participant shows");
});
