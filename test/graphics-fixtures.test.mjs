// The graphics fixtures spike E-S1 recorded (test/optin/graphics-spike.test.mjs, FIXTURES in
// test/optin/server/scrub.mjs) and the Phase E unit tests read: each one there, in its shape, from a
// launch with the sandbox on, and scrubbed (no paths, no command line, no machine revision).
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES } from "./optin/server/scrub.mjs";

const dir = new URL("./fixtures/", import.meta.url).pathname;
const read = (file) => JSON.parse(readFileSync(join(dir, file), "utf8"));
const SOFTWARE = /llvmpipe|SwiftShader/i;

test("every graphics fixture is there, from a sandboxed launch of the pinned build, and scrubbed", () => {
  for (const [file, from, part] of FIXTURES) {
    const f = read(file);
    assert.equal(`${f.platform}-${f.candidate}-${f.mode}`, from, file);
    assert.equal(f.sandbox?.on, true, `${file}: sandbox on`);
    assert.equal(f.sandbox?.noSandboxSwitch, false, file);
    assert.ok(f[part], `${file}: has ${part}`);
    const text = JSON.stringify(f);
    assert.doesNotMatch(text, /\/Users\/|\/home\/|\/var\/folders|\/private\/|\/tmp\//, `${file}: no paths`);
    assert.doesNotMatch(text, /"commandLine"|"modelVersion"|user-data-dir|remote-debugging/, `${file}: no command line`);
    if (part === "systemInfo") assert.ok(Array.isArray(f.systemInfo.gpu?.devices) && f.systemInfo.gpu.featureStatus, `${file}: devices and feature status`);
    else for (const k of ["webgl", "webgl2", "webgpu", "navigator"]) assert.ok(f.probe[k], `${file}: ${k}`);
  }
});

test("the fixtures show what the spike found: Metal hardware on macOS, a named software renderer under Xvfb", () => {
  const renderer = (file) => read(file).systemInfo.gpu.auxAttributes.glRenderer;
  assert.match(renderer("systeminfo-macos-metal.json"), /Metal/);
  assert.doesNotMatch(renderer("systeminfo-macos-metal.json"), SOFTWARE);
  assert.match(renderer("systeminfo-linux-xvfb-llvmpipe.json"), /llvmpipe/);
  assert.match(renderer("systeminfo-linux-xvfb-swiftshader.json"), /SwiftShader/);
  assert.match(renderer("systeminfo-linux-xvfb-lavapipe.json"), /llvmpipe/);
  // --use-angle=vulkan ran ANGLE on Vulkan, and its page never answered, so no sandbox page was read
  // (the reason spec E2 rejects it).
  const lavapipe = read("systeminfo-linux-xvfb-lavapipe.json");
  assert.match(lavapipe.systemInfo.gpu.auxAttributes.glImplementationParts, /angle=vulkan/);
  assert.equal(lavapipe.sandbox.page, undefined);
  // The sandbox page is Linux only: the namespace layer on every Linux fixture whose page answered.
  for (const [file] of FIXTURES) {
    const f = read(file);
    if (f.platform === "macos") assert.equal(f.sandbox.page, "not on macOS", file);
    else if (file !== "systeminfo-linux-xvfb-lavapipe.json") assert.ok(f.sandbox.page.includes("Layer 1 Sandbox\tNamespace"), file);
  }
  assert.equal(read("systeminfo-linux-disable-gpu.json").systemInfo.gpu.featureStatus.webgl, "disabled_off");
  // Today's Linux persona claims hardware over llvmpipe (spec 13.1); the E2 plan shows the real one.
  assert.doesNotMatch(read("probe-linux-llvmpipe-persona.json").probe.webgl.unmaskedRenderer, SOFTWARE);
  assert.match(read("probe-linux-llvmpipe-real.json").probe.webgl.unmaskedRenderer, /llvmpipe/);
  assert.match(read("probe-linux-swiftshader-real.json").probe.webgl.unmaskedRenderer, /SwiftShader/);
  assert.equal(read("probe-linux-disable-gpu.json").probe.webgl.available, false);
  assert.equal(read("probe-linux-webgpu-fallback-real.json").probe.webgpu.isFallbackAdapter, true);
});
