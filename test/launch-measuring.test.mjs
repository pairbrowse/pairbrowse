// The first launch of a browser version on a Mac measures it once (native-engine.mjs MEASURING),
// up to a minute with no browser to show anything: the live view's status line and a notification
// say so, and the status line goes back to the badge when the launch ends.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAIRBROWSE_HOME = mkdtempSync(join(tmpdir(), "pb-measuring-"));
const { measuringLog, MEASURING_STATUS } = await import("../scripts/daemon/context.mjs");
const { MEASURING } = await import("../scripts/native-engine.mjs");

test("measuring this Mac shows in the status line and a notification, once, until the launch ends", () => {
  const logged = [], statuses = [], notes = [];
  const launchLog = measuringLog({ log: (...a) => logged.push(a.join(" ")), status: (s) => statuses.push(s), notify: (t) => notes.push(t) });
  launchLog("launch: engine 1 ms");
  assert.deepEqual(statuses, [], "other launch lines say nothing");
  launchLog(MEASURING);
  launchLog(MEASURING);
  assert.deepEqual(statuses, [{ text: MEASURING_STATUS, kind: "claude" }]);
  assert.deepEqual(notes, [MEASURING_STATUS]);
  assert.ok(MEASURING_STATUS.length <= 140, "fits the live view's status line");
  launchLog.done({ text: "", kind: "clear" });
  assert.deepEqual(statuses.at(-1), { text: "", kind: "clear" });
  launchLog.done({ text: "x", kind: "clear" });
  assert.equal(statuses.length, 2, "nothing more to put back");
  assert.deepEqual(logged, ["launch: engine 1 ms", MEASURING, MEASURING], "every line still logged");
  // A cached profile: no measuring line, nothing shown.
  const quiet = [];
  const cached = measuringLog({ log: () => {}, status: (s) => quiet.push(s), notify: (t) => quiet.push(t) });
  cached("launch: fingerprint 300 ms");
  cached.done({ text: "", kind: "clear" });
  assert.deepEqual(quiet, []);
});

after(() => setImmediate(() => process.exit(process.exitCode || 0)));
