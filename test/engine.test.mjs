import { test } from "node:test";
import assert from "node:assert/strict";
import { validateEngine, engineProfile, launchEngine, sandboxDecision } from "../scripts/engine.mjs";

test("only the standard and native engines exist", () => {
  assert.equal(validateEngine({}), "chromium");
  assert.equal(validateEngine({ browserEngine: "chromium" }), "chromium");
  assert.throws(() => validateEngine({ browserEngine: "typo" }), /Unknown/);
  assert.throws(() => validateEngine({ browserEngine: "pairbrowse" }, "18.0.0"), /Node.js 20/);
  assert.throws(() => validateEngine({ browserEngine: "pairbrowse" }, "22.0.0"), /executablePath/);
});

test("the native engine keeps its own profile", () => {
  assert.equal(engineProfile({}, "/profiles/a"), "/profiles/a");
  assert.equal(engineProfile({ browserEngine: "pairbrowse" }, "/profiles/a"), "/profiles/a/pairbrowse-native");
});

test("standard engine removes automation signals without loading the engine pack", async () => {
  const options = { headless: false };
  const result = await launchEngine({ launchPersistentContext: async (profile, opts) => ({ profile, opts }) }, {}, "/a", options, undefined, () => { throw Error("unexpected engine pack load"); });
  assert.equal(result.profile, "/a");
  assert.equal(result.opts.headless, false);
  assert.deepEqual(result.opts.ignoreDefaultArgs, ["--enable-automation"]);
  assert.deepEqual(result.opts.args, ["--disable-blink-features=AutomationControlled"]);
});

test("Chromium's sandbox is on unless config, root on Linux, or the system turns it off", async () => {
  assert.equal(sandboxDecision({}, { platform: "darwin", uid: 501 }).on, true);
  assert.equal(sandboxDecision({}, { platform: "linux", uid: 1000 }).on, true);
  assert.equal(sandboxDecision({}, { platform: "darwin", uid: 0 }).on, true);
  assert.match(sandboxDecision({}, { platform: "linux", uid: 0 }).reason, /root/);
  assert.equal(sandboxDecision({ chromeSandbox: false }, { platform: "darwin", uid: 501 }).on, false);
  assert.equal(sandboxDecision({ chromeArgs: ["--no-sandbox"] }, { platform: "darwin", uid: 501 }).on, false);
  const tries = [];
  const logs = [];
  const fake = { launchPersistentContext: async (profile, opts) => {
    tries.push(opts.chromiumSandbox);
    if (opts.chromiumSandbox) throw new Error("Chromium sandboxing failed!\nNo usable sandbox!");
    return { opts };
  } };
  const result = await launchEngine(fake, {}, "/a", {}, (m) => logs.push(m));
  const expected = process.platform === "linux" && process.getuid?.() === 0 ? [false] : [true, false];
  assert.deepEqual(tries, expected);
  assert.equal(result.opts.chromiumSandbox, false);
  assert.equal(logs.filter((m) => /sandbox off/.test(m)).length, 1);
  const other = { launchPersistentContext: async () => { throw new Error("profile in use"); } };
  if (expected.length === 2) await assert.rejects(launchEngine(other, {}, "/a", {}), /profile in use/);
});
