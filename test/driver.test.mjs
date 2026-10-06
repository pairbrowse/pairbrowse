import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chooseBrowserDriver, loadBrowserDriver, validateBrowserDriver, patchrightNodeMinimum, fallbackNotice } from "../scripts/driver.mjs";

test("Node.js version and config decide the driver and whether to tell the user", () => {
  const cases = [
    // [config, node, driver, warns]
    [{}, "22.1.0", "patchright", false],
    [{}, "20.0.0", "patchright", false],
    [{ browserDriver: "patchright" }, "26.0.0", "patchright", false],
    [{ browserDriver: "playwright" }, "22.0.0", "playwright", false], // explicit opt-in
    [{ browserDriver: "playwright" }, "18.19.0", "playwright", false],
    [{}, "18.19.0", "playwright", true], // too old for Patchright: falls back, says so
    [{ browserDriver: "patchright" }, "19.9.0", "playwright", true],
  ];
  for (const [config, node, driver, warns] of cases) {
    const got = chooseBrowserDriver(config, node, 20);
    assert.equal(got.driver, driver, `${JSON.stringify(config)} on ${node}`);
    assert.equal(Boolean(got.notice), warns, `${JSON.stringify(config)} on ${node}`);
    if (warns) assert.equal(got.notice, fallbackNotice(node));
  }
  assert.match(fallbackNotice("18.19.0"), /using Playwright instead of Patchright because Node\.js 18\.19\.0 is too old for Patchright\. Update to Node\.js 20 or newer/);
  assert.throws(() => chooseBrowserDriver({ browserDriver: "unknown" }, "22.0.0"), /Unknown browserDriver/);
  assert.equal(validateBrowserDriver({}, "18.0.0", 20), "playwright");
});

test("the Patchright minimum comes from its package.json engines field", () => {
  const runtime = mkdtempSync(join(tmpdir(), "pb-driver-"));
  try {
    assert.equal(patchrightNodeMinimum(runtime), 20, "not installed yet: the pinned version's minimum");
    mkdirSync(join(runtime, "node_modules", "patchright"), { recursive: true });
    writeFileSync(join(runtime, "node_modules", "patchright", "package.json"), JSON.stringify({ engines: { node: ">=22" } }));
    assert.equal(patchrightNodeMinimum(runtime), 22);
    assert.equal(chooseBrowserDriver({}, "20.5.0", patchrightNodeMinimum(runtime)).driver, "playwright");
  } finally { rmSync(runtime, { recursive: true, force: true }); }
  const live = process.env.PAIRBROWSE_TEST_RUNTIME;
  if (live) assert.equal(patchrightNodeMinimum(live), 20, "the pinned patchright says >=20");
});

test("driver loader selects only the chosen chromium package", () => {
  const calls = [];
  const fakeRequire = (name) => { calls.push(name); return { chromium: { name } }; };
  assert.equal(loadBrowserDriver(fakeRequire, {}, "22.0.0").chromium.name, "patchright");
  assert.equal(loadBrowserDriver(fakeRequire, { browserDriver: "playwright" }, "22.0.0").chromium.name, "playwright");
  assert.equal(loadBrowserDriver(fakeRequire, {}, "18.0.0").chromium.name, "playwright");
  assert.deepEqual(calls, ["patchright", "playwright", "playwright"]);
});
