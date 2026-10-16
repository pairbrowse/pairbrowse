import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDepartures, resumeKey } from "../scripts/daemon/serve/departures.mjs";
import { sleep } from "./helpers/util.mjs";

test("resumeKey: the app and its bridge's parent process; never a joiner's agent or an unknown process", () => {
  assert.equal(resumeKey("claude-code", 4242), "claude-code|4242");
  assert.equal(resumeKey("claude-code", 4242, true), "");
  assert.equal(resumeKey("claude-code", 0), "");
  assert.equal(resumeKey("claude-code", 1), "");
  assert.equal(resumeKey("claude-code", "x"), "");
  assert.equal(resumeKey("", 4242), "");
  assert.notEqual(resumeKey("codex-mcp-client", 4242), resumeKey("claude-code", 4242));
});

test("a closed connection's identity waits the grace for the same app session, then is released", async () => {
  const d = createDepartures({ graceMs: 80 });
  const finished = [];
  d.hold("claude-code|1", { id: "old", label: "Claude old", page: null }, () => finished.push("old"));
  assert.equal(d.size(), 1);
  const back = d.take("claude-code|1");
  assert.equal(back.id, "old");
  assert.equal(back.label, "Claude old");
  assert.equal(d.take("claude-code|1"), null, "taken once");
  await sleep(150);
  assert.deepEqual(finished, [], "taken: the timer never releases it; the taker calls finish");
  back.finish();
  assert.deepEqual(finished, ["old"]);

  d.hold("claude-code|2", { id: "late" }, () => finished.push("late"));
  await sleep(150);
  assert.deepEqual(finished, ["old", "late"], "nobody came back within the grace: released");
  assert.equal(d.take("claude-code|2"), null);

  d.hold("", { id: "nokey" }, () => finished.push("nokey"));
  assert.equal(finished.at(-1), "nokey", "no key: released at once");

  d.hold("k", { id: "first" }, () => finished.push("first"));
  d.hold("k", { id: "second" }, () => finished.push("second"));
  assert.equal(finished.at(-1), "first", "a second close under the same key releases the first at once");
  assert.equal(d.take("k").id, "second");
  d.hold("k2", { id: "throws" }, () => { throw new Error("boom"); });
  await sleep(150); // a throwing finish is logged, never thrown
});
