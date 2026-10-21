// Phase E persistence and recovery (spec server-mode acceptance "Persistence and recovery", step
// 49): in the A13 container the native Linux build is started in server mode, measured once, and
// its browser killed; the next action brings it back on the same graphics request and the same
// measurement (the same runtime key and time, no second probe), its verdict and status part the
// same, its sandbox on. The run inside is test/optin/server/graphics-run.mjs ("recovery").
//
// Needs Docker (OrbStack on a Mac), PAIRBROWSE_TEST_DOCKER=1 and PAIRBROWSE_TEST_RUNTIME; the
// pinned Linux build and engine pack from PAIRBROWSE_TEST_LINUX_ARCHIVE and
// PAIRBROWSE_TEST_ENGINE_ARCHIVE (local files matching the pins), else from the release.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runGraphicsCase } from "./linux-graphics.test.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const SKIP = (!runtime || process.env.PAIRBROWSE_TEST_DOCKER !== "1") && "set PAIRBROWSE_TEST_DOCKER=1 and PAIRBROWSE_TEST_RUNTIME";

test("a killed browser relaunches with the same graphics request and measurement", { skip: SKIP, timeout: 3_000_000 }, async (t) => {
  const r = await runGraphicsCase("recovery");
  t.diagnostic(JSON.stringify({ lines: r.launchLinesAfter, status: r.statusAfter, before: r.validation && { status: r.validation.status, key: r.validation.runtimeKey, at: r.validation.at }, after: r.validationAfter && { status: r.validationAfter.status, key: r.validationAfter.runtimeKey, at: r.validationAfter.at } }, null, 1));
  assert.equal(r.measured, 1, "measured once at the first start");
  assert.equal(r.validation?.status, "consistent", JSON.stringify(r.validation?.items?.filter((i) => i.status === "mismatch")));
  assert.ok(r.killed, "the browser was killed");
  assert.ok(r.newBrowser, "a new browser came back on the next action");
  assert.match(r.pageAfter.webgl.renderer, /UHD Graphics 770/, "the same identity shown");
  assert.equal(r.pageAfter.canvas.first, r.page.canvas.first, "the same canvas pixels: the same seed and noise");
  assert.equal(r.measuredAfter, 1, `no second measurement: ${r.launchLinesAfter.join("\n")}`);
  assert.ok(!r.launchLinesAfter.some((l) => /measured again/.test(l)), "the measurement was kept, not dropped");
  assert.equal(r.validationAfter.runtimeKey, r.validation.runtimeKey, "the same runtime key");
  assert.equal(r.validationAfter.at, r.validation.at, "the same measurement");
  assert.equal(r.validationAfter.status, "consistent");
  assert.deepEqual(r.validationAfter.graphics, r.validation.graphics, "the measurement unchanged");
  assert.match(r.statusAfter, /Graphics: software \(.+\), shown as Intel UHD Graphics 770, requested auto, consistent on/);
  assert.ok(r.launchLinesAfter.filter((l) => /launch: graphics: software, shown as Intel UHD Graphics 770, consistent on/.test(l)).length >= 2, `both starts filed the verdict: ${r.launchLinesAfter.join("\n")}`);
  assert.ok(r.sandboxAfter && r.sandboxAfter.noSandboxSwitch === false && r.sandboxAfter.namespaced === r.sandboxAfter.renderers && r.sandboxAfter.renderers > 0, `the sandbox after: ${JSON.stringify(r.sandboxAfter)}`);
});
