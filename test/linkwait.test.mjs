// Agents wait while a sharing connection switches (scripts/daemon/linkwait.mjs), on both sides:
// the joiner's call (follow.mjs: the relay's `switching`) and the host's tab tools (serve.mjs:
// the live view's `reconnecting()`), with fakes standing in for either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForLink, waitedLine, NOTE_AFTER_MS } from "../scripts/daemon/linkwait.mjs";

test("a joiner's call issued while the relay is switching goes on only once the channel is back", async () => {
  const join = { switching: true }; // the relay, as follow.mjs reads it
  setTimeout(() => { join.switching = false; }, 300);
  const from = Date.now();
  const waited = await waitForLink(() => join.switching, { max: 5000, every: 20 });
  assert.ok(Date.now() - from >= 300 && waited >= 300, `waited ${waited} ms`);
  assert.ok(waited < 1000, "then straight on");
  assert.equal(await waitForLink(() => join.switching, { max: 5000 }), 0, "no wait while the channel is up");
});

test("a host's tab tool holds while a joiner's connection is away and proceeds when it's back; the grace is a cap", async () => {
  let lost = "Alice"; // the live view's reconnecting()
  const reconnecting = () => lost;
  setTimeout(() => { lost = null; }, 250);
  const waited = await waitForLink(reconnecting, { max: 5000, every: 20 });
  assert.ok(waited >= 250 && waited < 1000, `waited ${waited} ms`);
  const capped = await waitForLink(() => "Alice", { max: 200, every: 20 });
  assert.ok(capped >= 200 && capped < 600, `the grace ran out at ${capped} ms`);
  let current = true;
  setTimeout(() => { current = false; }, 100);
  const left = await waitForLink(() => "Alice", { max: 5000, every: 20, isCurrent: () => current });
  assert.ok(left < 1000, "stops when the session is over");
});

test("the wait is mentioned only past a few seconds, in plain words", () => {
  assert.equal(waitedLine(2900, "Alice's connection"), "");
  assert.equal(NOTE_AFTER_MS, 3000);
  assert.equal(waitedLine(6400, "Alice's connection"), "Waited 6 s for Alice's connection to come back.");
  assert.equal(waitedLine(3000, "the connection to Bob's session"), "Waited 3 s for the connection to Bob's session to come back.");
  assert.doesNotMatch(waitedLine(9000, "Alice's connection"), /tunnel|cloudflare|pool/i);
});
