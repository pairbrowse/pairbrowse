// The system's notification (scripts/notify.mjs): through PairBrowse Agent on macOS when a native
// build carries it, so it shows PairBrowse's name and logo; osascript only without one or when
// the Agent can't post; nothing more once the person declined or is still answering macOS.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { osNotify, NOTIFY_TITLE, LINUX_ICON } from "../scripts/notify.mjs";

const recorder = (code) => {
  const calls = [];
  const run = (file, args, opts, done) => {
    if (typeof opts === "function") { done = opts; opts = {}; }
    calls.push({ file, args, opts });
    const err = code === undefined || calls.length > 1 ? null : Object.assign(new Error("x"), { code });
    done(err);
  };
  return { calls, run };
};
const AGENT = "/A/PairBrowse.app/Contents/Helpers/PairBrowse Agent.app/Contents/MacOS/PairBrowse Agent";

test("macOS with a native build: the Agent posts it, as PairBrowse, the text an argument", () => {
  const r = recorder();
  assert.equal(osNotify("Measuring this Mac once; \"quotes\" stay text", { platform: "darwin", agent: () => AGENT, run: r.run }), "agent");
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].file, AGENT);
  assert.deepEqual(r.calls[0].args, ["--notify", NOTIFY_TITLE, "Measuring this Mac once; \"quotes\" stay text"]);
  assert.ok(r.calls[0].opts.timeout > 120_000, "longer than the Agent waits for the person's answer");
});

test("macOS: declined (3) or not answered yet (4) sends nothing else; an Agent that can't (64, 1) falls back", () => {
  for (const code of [3, 4]) { const r = recorder(code); osNotify("x", { platform: "darwin", agent: () => AGENT, run: r.run }); assert.equal(r.calls.length, 1, `code ${code}`); }
  for (const code of [64, 1, "ENOENT"]) {
    const r = recorder(code);
    osNotify("x", { platform: "darwin", agent: () => AGENT, run: r.run });
    assert.deepEqual(r.calls.map((c) => c.file), [AGENT, "osascript"], `code ${code}`);
    assert.deepEqual(r.calls[1].args.slice(-2), [NOTIFY_TITLE, "x"], "the text an argument, never in the script");
  }
});

test("macOS without a native build: osascript; Linux: notify-send; the text clipped", () => {
  const r = recorder();
  assert.equal(osNotify("x", { platform: "darwin", agent: () => null, run: r.run }), "osascript");
  assert.equal(osNotify("y".repeat(5000), { platform: "darwin", agent: () => { throw new Error("no config"); }, run: r.run }), "osascript");
  assert.equal(r.calls[1].args.at(-1).length, 2000);
  const l = recorder();
  assert.equal(osNotify("z", { platform: "linux", agent: () => AGENT, run: l.run }), "notify-send");
  assert.deepEqual(l.calls, [{ file: "notify-send", args: ["--app-name=PairBrowse", `--icon=${LINUX_ICON}`, "--", NOTIFY_TITLE, "z"], opts: {} }]);
  assert.ok(existsSync(LINUX_ICON), "the logo file is there");
  assert.equal(osNotify("z", { platform: "win32", run: l.run }), "none");
});
