import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBrowserDriver, validateBrowserDriver } from "../scripts/driver.mjs";

test("Patchright is the default driver and Playwright is an explicit fallback", () => {
  assert.equal(validateBrowserDriver({}, "20.0.0"), "patchright");
  assert.equal(validateBrowserDriver({ browserDriver: "playwright" }, "18.0.0"), "playwright");
  assert.throws(() => validateBrowserDriver({}, "18.0.0"), /Patchright requires Node.js 20/);
  assert.throws(() => validateBrowserDriver({ browserDriver: "unknown" }, "22.0.0"), /Unknown browserDriver/);
});

test("driver loader selects only the requested chromium package", () => {
  const calls = [];
  const fakeRequire = (name) => { calls.push(name); return { chromium: { name } }; };
  assert.equal(loadBrowserDriver(fakeRequire, {}, "22.0.0").chromium.name, "patchright");
  assert.equal(loadBrowserDriver(fakeRequire, { browserDriver: "playwright" }, "18.0.0").chromium.name, "playwright");
  assert.deepEqual(calls, ["patchright", "playwright"]);
});
