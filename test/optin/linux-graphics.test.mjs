// Phase E on a Linux host without a GPU (spec server-mode decision 10, step 49; acceptance
// "Runtimes"): in the A13 container (test/optin/server/container.mjs) the pinned native Linux build,
// installed as the helper installs it, starts in server mode on the helper's own virtual screen
// with its sandbox on; the first start measures its graphics once (software rendering, the page
// measured under the engine's identity) and pages then read that one identity, an Intel UHD
// Graphics 770, in WebGL and WebGPU alike, the canvas stable, the fonts resolving, the screen the
// virtual screen; the status part, the log and the default profile's verdict say "software
// rendering, shown as Intel UHD Graphics 770" and "consistent"; a start asking for a GPU is
// refused by name and nothing runs. The run inside is test/optin/server/graphics-run.mjs.
//
// Needs Docker (OrbStack on a Mac), PAIRBROWSE_TEST_DOCKER=1 and PAIRBROWSE_TEST_RUNTIME; the
// pinned Linux build and engine pack from PAIRBROWSE_TEST_LINUX_ARCHIVE and
// PAIRBROWSE_TEST_ENGINE_ARCHIVE (local files matching the pins), else from the release. On
// Apple Silicon the x64 container runs emulated (no seccomp filter there).
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerReady, startContainer } from "./server/container.mjs";
import { prepareNativeCache } from "./server/native-cache.mjs";
import { SCREEN } from "../helpers/server.mjs";
import { GPU_LESS_IDENTITY } from "../../scripts/native/graphics.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const SKIP = (!runtime || process.env.PAIRBROWSE_TEST_DOCKER !== "1") && "set PAIRBROWSE_TEST_DOCKER=1 and PAIRBROWSE_TEST_RUNTIME";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// One case of graphics-run.mjs in a container of its own: its RESULT line, parsed.
export async function runGraphicsCase(which) {
  assert.ok(dockerReady(), "Docker answers");
  const cache = await prepareNativeCache({ log: console.log });
  const c = startContainer({ name: `pb-graphics-${which}`, repo, log: console.log, mounts: [{ from: runtime, to: "/runtime" }, { from: cache, to: "/cache" }] });
  try {
    const r = await c.node("/repo/test/optin/server/graphics-run.mjs", [which], { ms: 2_700_000 });
    const line = r.out.split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, `the case ran:\n${r.out.slice(-6000)}`);
    const result = JSON.parse(line.slice("RESULT ".length));
    assert.equal(result.error, undefined, `${result.error}\n--- daemon.log ---\n${result.log || ""}`);
    return result;
  } finally { c.stop(); }
}

test("Linux without a GPU: backend software, the engine's identity shown in WebGL and WebGPU, consistent; canvas stable, fonts resolve, gpu refused, sandbox on", { skip: SKIP, timeout: 3_000_000 }, async (t) => {
  const r = await runGraphicsCase("graphics");
  t.diagnostic(JSON.stringify({ page: r.page, status: r.status, lines: r.launchLines, validation: r.validation && { status: r.validation.status, shown: r.validation.graphics?.shown, backend: r.validation.graphics?.backend?.renderer, mismatches: r.validation.items.filter((i) => i.status === "mismatch") }, gpu: r.gpu }, null, 1).slice(0, 12000));
  assert.notEqual(r.uid, 0, "a normal user");
  // Measured once, and the launch said what it shows.
  assert.equal(r.measured, 1, `measured once: ${r.launchLines.join("\n")}`);
  assert.ok(r.launchLines.some((l) => /launch: graphics: software rendering, shown as Intel UHD Graphics 770 \(the engine's one graphics identity for a host without a GPU, decision 10; canvas noise on\), screen 1280x800 \(the virtual screen\)/.test(l)), r.launchLines.join("\n"));
  assert.ok(r.launchLines.some((l) => /graphics probe: software rendering \(.*\); measuring what pages read under the identity shown there/.test(l)), "the probe measured again under the identity");
  // What pages read: the one identity, in WebGL and WebGPU alike.
  const p = r.page;
  assert.ok(p.webgl.available && p.webgl2.available, JSON.stringify(p.webgl));
  assert.match(p.webgl.renderer, /Intel\(R\) UHD Graphics 770/, "pages read the identity's WebGL renderer");
  assert.match(p.webgl.vendor, /Intel/);
  assert.match(p.webgl2.renderer, /UHD Graphics 770/);
  assert.ok(p.webgl.maxTextureSize >= 8192 && p.webgl.extensions > 20, `the identity's limits and extensions: ${JSON.stringify(p.webgl)}`);
  if (p.webgpu.available) {
    assert.deepEqual([p.webgpu.vendor, p.webgpu.architecture, p.webgpu.isFallbackAdapter], ["intel", "gen-12-lp", false], "WebGPU follows the identity (patch 961)");
    assert.equal(p.webgpu.requestDevice, "ok", "a device with the reported limits");
    assert.ok(p.webgpu.features > 0 && p.webgpu.limits > 0);
  } else {
    assert.equal(typeof p.webgpu.reason, "string", "a defined WebGPU result");
  }
  assert.equal(p.canvas.first, p.canvas.second, "the canvas scene draws the same pixels twice (noise is per site, stable within it)");
  assert.ok(p.fonts.found.length >= 2, `fonts resolve: ${JSON.stringify(p.fonts)}`);
  assert.deepEqual(p.fonts.controlFound, [], "no made-up font is found");
  assert.deepEqual([p.screen.width, p.screen.height], [SCREEN.width, SCREEN.height], "the screen pages read is the virtual screen");
  // PairBrowse's own diagnostics stay honest.
  assert.match(r.status, /Graphics: software \(.+\), shown as Intel UHD Graphics 770, requested auto, consistent on \d+\.\d+\.\d+\.\d+/, r.status);
  assert.doesNotMatch(r.status, /sandbox is off/i);
  assert.ok(r.validation, "the default profile keeps the verdict");
  assert.equal(r.validation.status, "consistent", JSON.stringify(r.validation.items.filter((i) => i.status !== "matched" && i.status !== "derived")));
  assert.equal(r.validation.graphics.shown, GPU_LESS_IDENTITY.name);
  assert.equal(r.validation.graphics.backend.kind, "software");
  assert.match(r.validation.graphics.backend.renderer, /llvmpipe|SwiftShader/i, "the host's own renderer stays in the record");
  assert.match(r.validation.graphics.webgl.unmaskedRenderer, /UHD Graphics 770/);
  assert.equal(r.validation.items.find((i) => i.rule === "gpu.software-as-hardware")?.status, "matched");
  assert.equal(r.validation.items.find((i) => i.rule === "sandbox.on")?.status, "matched", JSON.stringify(r.validation.items.find((i) => i.rule === "sandbox.on")));
  // The sandbox, from the kernel.
  assert.ok(r.sandbox, "the browser ran");
  assert.equal(r.sandbox.noSandboxSwitch, false, "no --no-sandbox");
  assert.ok(r.sandbox.renderers > 0 && r.sandbox.namespaced === r.sandbox.renderers, `every renderer in its own namespaces: ${JSON.stringify(r.sandbox)}`);
  if (process.arch === "x64") assert.equal(r.sandbox.seccomp, r.sandbox.renderers, "and under the seccomp filter");
  // A GPU asked for over software rendering: refused by name, nothing started, no second measurement.
  assert.match(r.gpu.navigate, /asks for a GPU \(graphics\.backend: gpu\) but this computer renders in software \(/, r.gpu.navigate);
  assert.equal(r.gpu.browsers, 0, "no browser runs");
  assert.equal(r.gpu.measured, 1, "the kept measurement answered, no new probe");
  assert.doesNotMatch(r.gpu.navigate, /shown as/, "never shown an identity");
});
