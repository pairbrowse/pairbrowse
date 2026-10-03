import { test } from "node:test";
import assert from "node:assert/strict";
import { validateEngine, engineProfile, launchEngine } from "../scripts/engine.mjs";

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
