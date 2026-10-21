// Graphics diagnostics on the open build (spec server-mode Phase E acceptance, "Runtimes"): the
// probe started as the self-check, the helper's first launch per runtime key and cli.mjs validate
// start it (native/check.mjs graphicsCheck over probeLauncher, the server sandbox rule: a sandbox
// that can't start fails, never a launch without it) measures the backend from the browser process,
// the page's WebGL strings name that same renderer (or, where the engine refused the GPU it found,
// the process says rendering is off and pages get no WebGL), and the sandbox is on: on Linux read from the
// engine's sandbox page (its namespace layer; seccomp-BPF too off emulation), on macOS the launch's
// own state. A GPU-less Linux host reports software. Linux runs it under CI's xvfb-run (DISPLAY
// set, headed as the probe starts there); macOS hidden, as its probe always is (the open build's
// hidden browser renders in software there, and says so: only the native build's probe runs in
// the product). Needs PAIRBROWSE_TEST_RUNTIME.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphicsCheck, probeLauncher } from "../../scripts/native/check.mjs";
import { validate } from "../../scripts/native/validate.mjs";
import { SANDBOX } from "../../scripts/engine.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const linux = process.platform === "linux";
const SKIP = !runtime ? "set PAIRBROWSE_TEST_RUNTIME"
  : linux && !process.env.DISPLAY ? "Linux under xvfb-run (DISPLAY set) only"
  : !["linux", "darwin"].includes(process.platform) ? "Linux and macOS only" : false;
const BUILD = "150.0.7871.114";
const PACK = "b".repeat(64);
// No render node: no GPU this browser could use, so it can only render in software.
const gpuLess = () => !existsSync("/dev/dri") || !readdirSync("/dev/dri").some((n) => n.startsWith("renderD"));

test("open build under CI's xvfb-run: probe runs, backend measured, WebGL strings agree with SystemInfo, sandbox on", { skip: SKIP, timeout: 300_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const scratch = mkdtempSync(join(tmpdir(), "pb-graphics-diag-"));
  const sandboxBefore = { ...SANDBOX };
  const logs = [];
  let measured = null;
  try {
    const launch = probeLauncher({ chromium, engine: {}, config: {}, shell: null, screen: null, env: process.env, server: true, log: (l) => logs.push(l) });
    const line = await graphicsCheck({ launch, build: BUILD, pack: PACK, display: "native", scratch, log: (l) => logs.push(l), onMeasured: (m) => { measured = m; } });
    assert.ok(measured, `the probe ran: ${line}\n${logs.join("\n")}`);
    assert.deepEqual(readdirSync(scratch), [], "the probe's folder removed");
    assert.match(line, /^graphics: (hardware|software), (WebGL [12]|no WebGL), WebGPU /, "the self-check's line names a measured backend");

    // Backend measured from the browser process, never assumed.
    assert.equal(measured.backend.source, "systeminfo");
    assert.ok(["hardware", "software"].includes(measured.backend.kind), `measured, not ${measured.backend.kind}: ${measured.backend.reason || ""}`);
    assert.ok(measured.backend.renderer, "the browser process names its renderer");
    if (linux && gpuLess()) assert.equal(measured.backend.kind, "software", `a GPU-less Linux host renders in software: ${measured.backend.renderer}`);

    // The page's WebGL strings against SystemInfo's renderer, and the sandbox, by the validator's rules.
    const entry = validate({ requested: { graphics: { backend: "auto" }, switches: [] }, derived: { build: BUILD, pack: PACK, runtimeKey: measured.runtimeKey, platform: process.platform }, measured });
    const rule = (id) => entry.items.find((i) => i.rule === id);
    if (measured.backend.renderer === "software rasterizer (GPU rendering off)") {
      // The engine refused the GPU it found (the open build's blocklist takes Mesa's llvmpipe):
      // the browser process says so, and pages get no WebGL to claim otherwise.
      assert.deepEqual([measured.webgl.available, measured.webgl2.available], [false, false], "GPU rendering off: no WebGL");
    } else {
      assert.ok(measured.webgl.available && measured.webgl.unmaskedRenderer, "pages get WebGL");
      assert.equal(rule("webgl.strings-vs-backend")?.status, "matched", `WebGL strings agree with SystemInfo: ${JSON.stringify(rule("webgl.strings-vs-backend"))} (page ${measured.webgl.unmaskedRenderer}, process ${measured.backend.renderer})`);
    }
    assert.equal(measured.runtime.sandbox.on, true, "the launch ran with its sandbox");
    if (linux) assert.ok(Array.isArray(measured.runtime.sandbox.page), `the engine's sandbox page was read: ${measured.runtime.sandbox.page}`);
    assert.equal(rule("sandbox.on")?.status, "matched", `sandbox on: ${JSON.stringify(rule("sandbox.on"))}`);
    assert.ok(!logs.some((l) => /sandbox is off/i.test(l)), "never started without it");
    assert.deepEqual({ ...SANDBOX }, sandboxBefore, "the helper's sandbox state put back");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
