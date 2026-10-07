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
  const started = Date.now();
  await Promise.all([c.run("a", task("a1", 100), tab1), c.run("b", task("b2", 100), tab2)]);
  assert.ok(Date.now() - started < 180, `two tabs at once (${Date.now() - started} ms)`);
  assert.deepEqual(log.slice(0, 2).sort(), ["a1+", "b2+"]);
  log.length = 0;
  await Promise.all([c.run("a", task("x", 40), tab1), c.run("b", task("y", 40), tab1)]);
  assert.deepEqual(log, ["x+", "x-", "y+", "y-"], "one tab: in turn");
  log.length = 0;
  await Promise.all([c.run("a", task("t1", 60), tab1), c.run("b", task("all", 20)), c.run("a", task("t2", 20), tab2)]);
  assert.deepEqual(log, ["t1+", "t1-", "all+", "all-", "t2+", "t2-"], "the browser-wide task waits for the tab before it, and the tab after waits for it");
  assert.equal(c.isActing("a"), false);
});
