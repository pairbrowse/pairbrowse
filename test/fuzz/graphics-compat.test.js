// Property-based fuzzing of a launch's graphics (scripts/native/graphics.mjs graphicsPlan and
// compatErrors; spec server-mode E2, E7, E9): for any requested backend, browser, platform,
// switches, screen and measurement, every set graphics field is applied or named in an error,
// never applied partly; a refused plan adds no switch and no engine key; the plan's switches pass
// the switch screen as they are and its engine keys are the engine's own. Nothing throws.
// Run with: npm ci && npm run test:fuzz
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { graphicsPlan, compatErrors, SOFTWARE_SWITCH, LINUX_REAL, GPU_LESS_IDENTITY, identityKeys } from "../../scripts/native/graphics.mjs";
import { parseSystemInfo } from "../../scripts/native/backend.mjs";
import { screenBrowserArgs } from "../../scripts/browser-args.mjs";
import { PAIRBROWSE_ENGINE_KEYS } from "../../scripts/config-schema.mjs";

const RUNS = Number(process.env.PAIRBROWSE_FUZZ_RUNS) || 3000;
const check = (property, runs = RUNS) => fc.assert(property, { numRuns: runs });

const backend = fc.constantFrom("auto", "software", "gpu", "metal", "", null);
const platform = fc.constantFrom("darwin", "linux", "win32");
const kind = fc.constantFrom("pairbrowse", "pairbrowse-open");
const args = fc.array(fc.oneof(fc.constantFrom("--disable-gpu", "--use-angle=swiftshader", "--use-angle=vulkan", "--use-gl=egl", "--use-gl=swiftshader",
  "--force-device-scale-factor=2", "--force-device-scale-factor=x", "--lang=de", "--enable-unsafe-webgpu"), fc.string({ maxLength: 10 })), { maxLength: 5 });
const side = fc.integer({ min: 320, max: 8000 });
const display = fc.option(fc.record({ width: side, height: side, depth: fc.constantFrom(16, 24) }), { nil: null });
const screen = fc.option(fc.record({ width: side, height: side }), { nil: null });
const read = fc.oneof(fc.constant(null), fc.constantFrom(
  { kind: "hardware", renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro)" }, { kind: "software", renderer: "llvmpipe" }, { kind: "unverified", renderer: null }),
fc.anything().map((x) => parseSystemInfo(x)));
const part = fc.option(fc.record({ available: fc.boolean(), reason: fc.option(fc.string({ maxLength: 20 }), { nil: null }) }), { nil: null });
const measured = fc.option(fc.record({ backend: read, webgl: part, webgl2: part, webgpu: part }), { nil: null });
const require = fc.option(fc.record({ webgl: fc.constantFrom(null, 1, 2), webgpu: fc.boolean(), platforms: fc.subarray(["linux", "macos"]) }), { nil: null });

test("for any profile, every set graphics field is applied or named in an error", () => {
  check(fc.property(backend, platform, kind, args, display, screen, measured, require, (requested, os, browserKind, userArgs, xvfb, set, m, req) => {
    const plan = graphicsPlan({ requested, platform: os, browserKind, measured: m?.backend ?? null, userArgs, display: xvfb, screenSet: !!set, name: "p" });
    assert.deepEqual(Object.keys(plan).sort(), ["engineKeys", "identity", "refusals", "switches"]);
    if (plan.refusals.length) assert.deepEqual([plan.switches, plan.engineKeys], [[], {}], "a refused plan applies nothing");
    for (const r of plan.refusals) assert.ok(typeof r.field === "string" && /^[^\n]+\.$/.test(r.message), r.message);
    assert.deepEqual(screenBrowserArgs(plan.switches, os, { harness: false }), { kept: plan.switches, dropped: [], refused: [] });
    for (const [k, v] of Object.entries(plan.engineKeys)) {
      assert.ok(PAIRBROWSE_ENGINE_KEYS.includes(k), k);
      assert.ok(typeof v === "number" || typeof v === "boolean", k);
    }
    // The backend: applied (software's switch, auto's nothing, gpu checked) or refused.
    if (!plan.refusals.length) {
      assert.ok(["auto", "software", "gpu"].includes(requested));
      if (requested === "software") assert.deepEqual(plan.switches, [SOFTWARE_SWITCH]);
      else assert.deepEqual(plan.switches, []);
      if (requested === "gpu" && m?.backend) assert.equal(m.backend.kind, "hardware", "gpu passes only on a measured hardware backend");
      if (browserKind === "pairbrowse-open") assert.equal(requested, "auto", "the open build takes no request");
      // The Linux plan, whatever was asked: the real backend's strings, or over a software read
      // the engine's one identity (decision 10: shown over software rendering only, never for a
      // GPU asked for, never off Linux or on the open build); the screen only on a display with
      // none set.
      if (browserKind === "pairbrowse" && os === "linux") {
        const shown = m?.backend?.kind === "software" && requested !== "gpu";
        assert.equal(plan.identity, shown ? GPU_LESS_IDENTITY.name : null);
        for (const [k, v] of Object.entries(shown ? identityKeys(true) : LINUX_REAL)) assert.equal(plan.engineKeys[k], v, k);
        assert.equal(plan.engineKeys.screenWidth, xvfb && !set ? xvfb.width : undefined);
      } else { assert.deepEqual(plan.engineKeys, {}); assert.equal(plan.identity, null); }
    }
    // compatErrors: the plan's refusals and every other set field it can't meet, never thrown.
    const errors = compatErrors({ name: "p", graphics: { backend: requested, require: req }, platform: os, browserKind, measured: m, userArgs, display: xvfb, screen: set });
    for (const r of plan.refusals) assert.ok(errors.some((e) => e.message === r.message), r.message);
    for (const e of errors) assert.ok(typeof e.field === "string" && /^[^\n]+\.$/.test(e.message), e.message);
    if (os === "linux" && browserKind === "pairbrowse" && xvfb && set && (set.width !== xvfb.width || set.height !== xvfb.height)) assert.ok(errors.some((e) => e.field === "screen"));
    if (req && browserKind === "pairbrowse-open") assert.ok(errors.some((e) => e.field === "graphics.require"));
    if (req?.webgpu && browserKind === "pairbrowse" && m && ["hardware", "software"].includes(m.backend?.kind) && m.webgpu?.available !== true) assert.ok(errors.some((e) => /requires WebGPU/.test(e.message)));
  }));
});
