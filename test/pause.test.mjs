import { test } from "node:test";
import assert from "node:assert/strict";
import { createPause } from "../scripts/daemon/pause.mjs";
import { fieldOwner, leftAlone, OWN_MS } from "../scripts/daemon/fields.mjs";

test("pause agents: people pause and resume, agents hear who, and a long pause answers instead of hanging", async () => {
  const changes = [];
  const pause = createPause({ onChange: (v) => changes.push(v), replyMs: 300 });
  const start = pause.seq();
  assert.equal(await pause.wait(), null, "not paused: no wait");
  assert.ok(pause.pause("Alice"));
  assert.equal(pause.pause("Bob"), false, "already paused: Alice stays the one who paused");
  assert.deepEqual([pause.view().paused, pause.view().by], [true, "Alice"]);
  const t = Date.now();
  assert.deepEqual(await pause.wait(), { by: "Alice" }, "still paused after replyMs: says by whom");
  assert.ok(Date.now() - t >= 250);
  const waiting = pause.wait();
  setTimeout(() => pause.resume("Bob"), 100);
  assert.equal(await waiting, null, "resumed: the action goes on");
  assert.match(pause.noteAfter(start).text, /paused by Alice, then resumed by Bob/);
  assert.equal(pause.noteAfter(pause.noteAfter(start).n).text, "", "once");
  assert.equal(changes.length, 2);
  const ac = new AbortController();
  pause.pause("Alice");
  setTimeout(() => ac.abort(), 50);
  assert.deepEqual(await pause.wait(ac.signal), { by: "Alice" }, "a disconnected agent stops waiting");
  assert.match(pause.noteAfter(start).text, /Agents are paused/);
});

test("a joined helper mirrors the host's pause, and leaving lets its agents go", () => {
  const pause = createPause();
  pause.mirror({ paused: true, by: "Bob<script>" });
  assert.equal(pause.view().by, "Bobscript", "names are cleaned");
  pause.mirror({ paused: true, by: "Bob" });
  pause.mirror({ paused: false, resumedBy: "Alice" });
  assert.deepEqual([pause.view().paused, pause.view().resumedBy], [false, "Alice"]);
});

test("a field a person edited is theirs for a while; an agent's own typing never makes it so", () => {
  const now = 10_000_000;
  const byAgent = (t) => t >= now - 1000 && t <= now - 500;
  assert.equal(fieldOwner(null, { host: "Bob", now }), null);
  assert.equal(fieldOwner({ times: [now - 800], name: "Notes" }, { host: "Bob", byAgent, now }), null, "the agent typed it");
  assert.deepEqual(fieldOwner({ times: [now - 5000], name: "Notes" }, { host: "Bob", byAgent, now }), { who: "Bob", local: true, name: "Notes" });
  assert.equal(fieldOwner({ times: [now - OWN_MS - 1] }, { host: "Bob", now }), null, "long ago");
  assert.ok(fieldOwner({ times: [now - OWN_MS - 1], focused: true }, { host: "Bob", now }), "still at it (focused)");
  assert.equal(fieldOwner({ times: [now + 60_000] }, { host: "Bob", now }), null, "a time in the future counts for nothing");
  const remote = fieldOwner({ times: [now - 9000], rw: "Alice", rt: now - 1000, name: "Delivery instructions" }, { host: "Bob", now });
  assert.deepEqual(remote, { who: "Alice", local: false, name: "Delivery instructions" }, "latest edit wins");
  assert.equal(leftAlone(remote), "Alice is filling Delivery instructions; left it as they wrote it.");
});
