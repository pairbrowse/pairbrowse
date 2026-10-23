// The graphics probe's page side in a real browser (spec server-mode E4; native/probe.mjs): the
// open build (the native build with PAIRBROWSE_TEST_EXECUTABLE, helpers/daemon.mjs nativeExe),
// started twice on one throwaway folder as probeLaunch starts a probe browser, answers every part
// on a local page (WebGL and WebGL2 strings and limits, WebGPU or why not, the canvas scenes on two
// origins and across the two starts, fonts against a control list, screen, media, locale, user
// agent), the browser process names its backend, and the record is the one measuredRecord keeps
// and validate() reads. Nothing is left behind. Needs PAIRBROWSE_TEST_RUNTIME.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeLaunch, graphicsStep, PROBE_FONTS } from "../../scripts/native/probe.mjs";
import { validate } from "../../scripts/native/validate.mjs";
import { runtimeKey } from "../../scripts/native/graphics.mjs";
import { nativeExe } from "../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const BUILD = "155.0.8059.84";
const PACK = "a".repeat(64);

test("the probe measures a real browser in every part, twice started, and leaves nothing", { skip: !runtime && "set PAIRBROWSE_TEST_RUNTIME", timeout: 180_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const directory = mkdtempSync(join(tmpdir(), "pb-probe-"));
  const starts = [];
  const sandbox = { on: true, reason: null, refused: null, blocked: null, required: null };
  try {
    const measured = await probeLaunch({
      launch: (dir) => { starts.push(dir); return chromium.launchPersistentContext(dir, { headless: true, ...(nativeExe ? { executablePath: nativeExe } : {}) }); },
      directory, build: BUILD, pack: PACK, display: "native", sandbox, stepMs: 20_000, launchMs: 60_000,
    });
    assert.equal(starts.length, 2, "started twice");
    assert.equal(starts[0], starts[1], "on one folder");
    assert.deepEqual(readdirSync(directory), [], "its folder removed");
    const platform = process.platform === "darwin" ? "macos" : "linux";
    assert.equal(measured.runtime.platform, platform);
    assert.equal(measured.runtimeKey, runtimeKey({ build: BUILD, pack: PACK, platform, arch: process.arch, display: "native", backend: measured.backend, switches: [] }));
    assert.ok(["hardware", "software", "unverified"].includes(measured.backend.kind));
    assert.equal(measured.backend.source, "systeminfo");
    for (const part of ["webgl", "webgl2"]) {
      const gl = measured[part];
      assert.equal(typeof gl.available, "boolean", part);
      if (gl.available) {
        assert.ok(gl.unmaskedRenderer, `${part} renderer`);
        assert.ok(gl.maxTextureSize > 0 && gl.extensions > 0, `${part} limits and extensions`);
      }
    }
    if (measured.webgl.available) assert.equal(typeof measured.webgl.sameOrigins, "boolean", "the WebGL scene compared on two origins");
    assert.equal(typeof measured.webgpu.available, "boolean");
    if (!measured.webgpu.available) assert.ok(measured.webgpu.reason);
    assert.equal(measured.canvas.stable, true, "one scene, the same pixels twice in a page");
    assert.equal(typeof measured.canvas.repeat, "boolean", "compared across the two starts");
    assert.equal(typeof measured.canvas.noise, "boolean");
    assert.equal(measured.fonts.checked, PROBE_FONTS[platform].length);
    assert.deepEqual(measured.fonts.controlFound, [], "no control font is found");
    assert.ok(measured.screen.width > 0 && measured.screen.devicePixelRatio > 0);
    assert.ok(Object.keys(measured.media).length > 0, "codec answers");
    assert.ok(measured.locale.timezone && measured.locale.languages.length);
    assert.match(measured.navigator.userAgent, /Mozilla/);
    assert.equal(measured.runtime.sandbox.on, true);
    assert.ok(platform === "macos" ? measured.runtime.sandbox.page === "not on macOS" : Array.isArray(measured.runtime.sandbox.page) || measured.runtime.sandbox.page);
    assert.match(graphicsStep(measured), /^graphics: (hardware|software|unverified), (WebGL [12]|no WebGL), WebGPU /);
    const entry = validate({ requested: { graphics: { backend: "auto" }, switches: [] }, derived: { build: BUILD, pack: PACK, runtimeKey: measured.runtimeKey, platform: process.platform }, measured });
    assert.ok(entry.graphics, "validate keeps it as this runtime's evidence");
    assert.ok(entry.items.some((i) => i.rule === "canvas.stable" && i.status === "matched"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
