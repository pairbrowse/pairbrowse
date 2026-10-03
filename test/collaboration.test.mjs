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
