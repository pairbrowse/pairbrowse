// browser_wait_for wakes when the hand-off it waits on ends (spec server-mode B15): the agent
// returns as soon as the person finishes, and stops when the hand-off timed out.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { createWaitForTool, endedLine } = await import("../scripts/daemon/serve/tools/wait-for.mjs");
const { createGrants } = await import("../scripts/daemon/grants.mjs");

const page = { url: () => "https://shop.example/login", isClosed: () => false, frames: () => [] };

function tool(grants) {
  const conn = { participant: "p1", disconnected: new AbortController(), actingIn: page };
  const api = { context: { watchClose: () => () => {} }, serverPage: async () => page, yourTurn: grants ? { ended: (p) => grants.ended(p) } : null };
  return createWaitForTool(conn, api).browser_wait_for;
}

test("browser_wait_for time 120 returns within 300 ms of the grant ending", async () => {
  const grants = createGrants();
  const { id } = grants.mint({ session: "default", page, action: "login" });
  const wait = tool(grants);
  const started = Date.now();
  setTimeout(() => grants.end(id, "done"), 200);
  const r = await wait({ time: 120 });
  const took = Date.now() - started;
  assert.ok(took < 500, `returned after ${took} ms`);
  assert.equal(r.error, false);
  assert.match(r.text, new RegExp(`^Waited 0\\.[0-9] s\\. The hand-off ${id} ended \\(done\\)\\. Take a browser_snapshot`));
});

test("a hand-off that timed out tells the agent to stop; without one the wait is as before", async () => {
  assert.match(endedLine({ id: "0123abcd", reason: "expired" }), /^The hand-off 0123abcd timed out: nobody finished the step in time\. Stop here/);
  const started = Date.now();
  const r = await tool(createGrants())({ time: 0.2 });
  assert.equal(r.text, "Waited 0.2 s.");
  assert.ok(Date.now() - started >= 190);
  assert.equal((await tool(null)({ time: 0.1 })).text, "Waited 0.1 s.");
});

test("a wait for text, or with nothing named, also returns when the hand-off ends", async () => {
  for (const args of [{ text: "Welcome back" }, { textGone: "Sign in" }, {}]) {
    const grants = createGrants();
    const { id } = grants.mint({ session: "default", page, action: "login" });
    const started = Date.now();
    setTimeout(() => grants.end(id, "done"), 200);
    const r = await tool(grants)(args);
    const took = Date.now() - started;
    assert.ok(took < 800, `${JSON.stringify(args)}: returned after ${took} ms`);
    if (args.textGone) continue; // nothing on this page to be gone: it is gone at once
    assert.equal(r.error, false);
    assert.match(r.text, new RegExp(`The hand-off ${id} ended \\(done\\)`), JSON.stringify(args));
  }
  const grants = createGrants();
  const { id } = grants.mint({ session: "default", page, action: "login" });
  setTimeout(() => grants.end(id, "expired"), 100);
  const r = await tool(grants)({ text: "Welcome back" });
  assert.equal(r.error, true);
  assert.match(r.text, /timed out: nobody finished the step in time/);
});
