// Phase E on the native build on a Mac (spec server-mode acceptance "Runtimes", native-graphics):
// the product's own measurement (cli.mjs validate's measureGraphics over the probe) reads a
// hardware backend on this Mac's GPU; the probe's WebGL strings agree with the host capture the
// launch takes once per Mac (the persona pages read is this Mac's own); WebGL's and WebGPU's
// vendors agree (one GPU family); and the verdict is "validated" on this build and engine pack,
// never "consistent" (no identity is shown over hardware). Needs PAIRBROWSE_TEST_RUNTIME,
// PAIRBROWSE_TEST_EXECUTABLE (a native build) and PAIRBROWSE_TEST_ENGINE on macOS; skipped
// otherwise. The probe runs hidden, as it does in the product.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { measureGraphics } from "../../scripts/native/check.mjs";
import { validate } from "../../scripts/native/validate.mjs";
import { rendererFamily } from "../../scripts/rules/coherence.mjs";
import { paths } from "../../scripts/paths.mjs";
import { NATIVE } from "../../scripts/native-pack.mjs";
import { testHome } from "../helpers/home.mjs";
import { nativeExe, nativeVersion, linkInstalls } from "../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const SKIP = process.platform !== "darwin" ? "macOS only" : !runtime ? "set PAIRBROWSE_TEST_RUNTIME" : !nativeExe && "set PAIRBROWSE_TEST_EXECUTABLE (a native build) and PAIRBROWSE_TEST_ENGINE";

test("macOS native: backend hardware; the probe agrees with the host capture; WebGL and WebGPU vendors agree; validated", { skip: SKIP, timeout: 600_000 }, async (t) => {
  linkInstalls(testHome, runtime);
  const logs = [];
  const { measured, line, display } = await measureGraphics(nativeExe, { config: {}, log: (l) => logs.push(l) });
  assert.ok(measured, `the probe ran: ${line}\n${logs.join("\n")}`);
  t.diagnostic(JSON.stringify({ line, backend: measured.backend, webgl: measured.webgl?.unmaskedRenderer, webgpu: measured.webgpu && { vendor: measured.webgpu.vendor, architecture: measured.webgpu.architecture, fallback: measured.webgpu.isFallbackAdapter, requestDevice: measured.webgpu.requestDevice } }));
  assert.equal(display, "native");
  assert.match(line, /^graphics: hardware, WebGL 2, WebGPU adapter$/, "this Mac's GPU, measured, with a WebGPU adapter");
  assert.deepEqual([measured.backend.source, measured.backend.kind], ["systeminfo", "hardware"], measured.backend.renderer);
  assert.equal(measured.shown, null, "no identity shown over hardware");
  // The host capture, taken once per Mac by the probe's launch, is what pages read.
  const capture = JSON.parse(readFileSync(paths.hostProfile, "utf8")).profile;
  const captured = capture.webgl?.webgl1?.debug;
  assert.ok(captured?.UNMASKED_RENDERER_WEBGL, "the host capture holds this Mac's WebGL renderer");
  assert.equal(measured.webgl.unmaskedRenderer, captured.UNMASKED_RENDERER_WEBGL, "the probe's WebGL renderer is the capture's");
  assert.equal(measured.webgl.unmaskedVendor, captured.UNMASKED_VENDOR_WEBGL);
  assert.equal(measured.webgpu?.vendor, capture.webgpu?.vendor, "the probe's WebGPU vendor is the capture's");
  // One GPU family everywhere: the backend, WebGL and WebGPU.
  const family = rendererFamily(measured.backend.renderer);
  assert.ok(family && family !== "software", `a hardware family: ${measured.backend.renderer}`);
  assert.equal(rendererFamily(measured.webgl.unmaskedRenderer), family, "WebGL's renderer is the backend's family");
  assert.equal(rendererFamily(measured.webgpu.vendor), family, "WebGPU's vendor is the backend's family");
  assert.equal(measured.webgpu.isFallbackAdapter, false);
  assert.deepEqual(measured.webgpu.requestDevice, { ok: true, error: null }, "a device with the reported limits (patch 961 keeps real limits with real strings)");
  // Validated on this build and engine pack.
  const entry = validate({ requested: { graphics: { backend: "auto" }, switches: [] }, derived: { build: nativeVersion, pack: NATIVE.engine.sha256, runtimeKey: measured.runtimeKey, platform: process.platform }, measured });
  assert.equal(entry.status, "validated", JSON.stringify(entry.items.filter((i) => i.status === "mismatch" || i.status === "unverified")));
  for (const rule of ["webgl.strings-vs-backend", "webgpu.vendor", "webgpu.device", "sandbox.on", "bridge.absent", "canvas.stable", "canvas.repeat"]) {
    assert.equal(entry.items.find((i) => i.rule === rule)?.status, "matched", `${rule}: ${JSON.stringify(entry.items.find((i) => i.rule === rule))}`);
  }
});
