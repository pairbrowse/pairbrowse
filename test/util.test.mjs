// Shared helpers (scripts/util.mjs) with behaviour worth a check of their own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageLoaded } from "../scripts/util.mjs";

// A stand-in page: readyState answers in turn (a function throws or hangs), load states as given.
function fakePage(answers, states = {}) {
  const calls = [];
  return {
    calls,
    evaluate: async () => {
      calls.push("ask");
      const a = answers.shift();
      if (a === "hang") return new Promise(() => {});
      if (a === "throw") throw new Error("Execution context was destroyed");
      return a;
    },
    waitForLoadState: (state) => { calls.push(state); return states[state] === "never" ? new Promise(() => {}) : Promise.resolve(); },
  };
}

test("a page that says it's complete (restored by Back) isn't waited for", async () => {
  const page = fakePage(["complete"], { load: "never" });
  const t0 = Date.now();
  await pageLoaded(page, { maxMs: 4000 });
  assert.ok(Date.now() - t0 < 200, "no wait for a load event that never comes again");
  assert.deepEqual(page.calls, ["ask"]);
});

test("no answer right after the move: a short wait for domcontentloaded, then asked again", async () => {
  const page = fakePage(["throw", "complete"], { load: "never" });
  const t0 = Date.now();
  await pageLoaded(page, { maxMs: 4000, dclMs: 500 });
  assert.ok(Date.now() - t0 < 400);
  assert.deepEqual(page.calls, ["ask", "domcontentloaded", "ask"]);
  const hung = fakePage(["hang", "complete"], { load: "never" });
  await pageLoaded(hung, { maxMs: 4000, probeMs: 50, dclMs: 500 });
  assert.deepEqual(hung.calls, ["ask", "domcontentloaded", "ask"]);
});

test("a page still loading waits for its load event, up to the bound", async () => {
  const page = fakePage(["loading"]);
  await pageLoaded(page, { maxMs: 4000 });
  assert.deepEqual(page.calls, ["ask", "load"]);
  const slow = fakePage(["throw", "interactive"], { domcontentloaded: "never", load: "never" });
  const t0 = Date.now();
  await pageLoaded(slow, { maxMs: 150, probeMs: 50, dclMs: 50 });
  const ms = Date.now() - t0;
  assert.ok(ms >= 150 && ms < 1000, `bounded: ${ms} ms`);
  assert.deepEqual(slow.calls, ["ask", "domcontentloaded", "ask", "load"]);
});
