// Requested against measured (spec server-mode Phase E, E5, E6, E8; scripts/native/validate.mjs,
// scripts/native/properties.mjs): the property matrix as data, one item per check in Phase D's
// shape, validated only with a measurement of this pack and runtime key, failed on a mismatch or a
// switch the page didn't answer, and the measurement kept in validation[build].graphics without a
// new revision. Measurements are built from spike E-S1's fixtures (test/fixtures/probe-*.json,
// systeminfo-*.json).
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate, measuredRecord, entryStatus, RULES, RULE_IDS } from "../scripts/native/validate.mjs";
import { GPU_LESS_IDENTITY } from "../scripts/native/graphics.mjs";
import { rendererFamily, COHERENCE_RULES } from "../scripts/rules/coherence.mjs";
import { COHERENCE } from "../scripts/native/validate.mjs";
import { PROPERTIES, RUNTIMES, property, classOf, runtimeOf } from "../scripts/native/properties.mjs";
import { checkProfile, ITEM_CLASSES, ITEM_STATUSES, ITEM_SEVERITIES } from "../scripts/profiles/schema.mjs";
import { PAIRBROWSE_ENGINE_KEYS } from "../scripts/config-schema.mjs";
import { SWITCHES } from "../scripts/profiles/map.mjs";
import { createProfileStore } from "../scripts/profiles/store.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const BUILD = "150.0.7871.114";
const PACK = "a".repeat(64);
const KEY = "b".repeat(64);
const AT = "2026-10-21T10:00:00Z";
// The E6 rules on the switches the launch passed find their page answers, so a measurement is the
// probe fixture's page and the matching SystemInfo's renderer, as step 42's probe will record them.
function measurement(probeName, systemInfoName, extra = {}) {
  const f = fixture(probeName), si = fixture(systemInfoName).systemInfo;
  const renderer = si.gpu.auxAttributes.glRenderer;
  const kind = /llvmpipe|SwiftShader/i.test(renderer) ? "software" : /Disabled/.test(renderer) ? "software" : "hardware";
  const [width, height, colorDepth] = f.probe.navigator.screen;
  return {
    at: AT, runtimeKey: KEY, pack: PACK,
    runtime: { platform: f.platform, arch: f.arch, display: f.platform === "macos" ? "native" : "xvfb", emulated: f.platform === "linux", sandbox: f.sandbox },
    backend: { kind, vendor: si.gpu.devices[0].vendorId, device: si.gpu.devices[0].deviceId, renderer, driver: si.gpu.devices[0].driverVersion, source: "systeminfo" },
    webgl: { ...f.probe.webgl, sameOrigins: true }, webgl2: f.probe.webgl2, webgpu: f.probe.webgpu,
    canvas: { stable: true, repeat: true, noise: false },
    fonts: { checked: 20, missing: [], controlFound: [] },
    media: { "video/mp4; codecs=avc1.42E01E": true },
    screen: { width, height, availWidth: width, availHeight: height, colorDepth, devicePixelRatio: f.probe.navigator.dpr },
    locale: { timezone: "Europe/Berlin", languages: ["de-DE", "de"] },
    navigator: { userAgent: f.probe.navigator.userAgent, platform: f.probe.navigator.platform, hardwareConcurrency: f.probe.navigator.hardwareConcurrency, deviceMemory: 8 },
    ...extra,
  };
}
const LINUX = { build: BUILD, pack: PACK, runtimeKey: KEY, platform: "linux", virtualScreen: { width: 1366, height: 768 } };
const LINUX_1366 = LINUX;
const MAC = { build: BUILD, pack: PACK, runtimeKey: KEY, platform: "darwin" };
const requested = (change = {}) => ({ graphics: { backend: "auto", require: null }, screen: null, locale: { timezone: null, languages: null }, switches: [], results: [], ...change });
const itemOf = (entry, rule, field) => entry.items.find((i) => i.rule === rule && (!field || i.field === field));
// A measurement without WebGPU: requestDevice with the reported limits fails everywhere until
// patch 961 (step 39), so the checks that pass are shown on the parts that can.
const noWebgpu = { available: false, reason: "requestAdapter returned null" };

test("the property matrix: every runtime classed, mechanisms from the known lists, every rule a validator or coherence rule", () => {
  assert.deepEqual(RUNTIMES, ["macos", "linux-software", "linux-gpu"]);
  const coherence = Object.keys(COHERENCE_RULES);
  const named = new Set();
  for (const p of PROPERTIES) {
    assert.match(p.field, /^[A-Za-z][A-Za-z0-9]{0,39}(?:\.[A-Za-z][A-Za-z0-9]{0,39}){0,3}$/, p.field);
    for (const r of RUNTIMES) assert.ok(ITEM_CLASSES.includes(p.classes[r]), `${p.field} on ${r}`);
    for (const k of p.mechanism.engineKeys || []) assert.ok(PAIRBROWSE_ENGINE_KEYS.includes(k), `${p.field}: engine key ${k}`);
    for (const s of p.mechanism.switches || []) assert.ok([...SWITCHES, "use-angle", "proxy-server", "webrtc-ip-handling-policy"].includes(s), `${p.field}: switch ${s}`);
    for (const r of p.rules) { assert.ok(RULE_IDS.includes(r) || coherence.includes(r), `${p.field}: rule ${r}`); named.add(r); }
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.classes), "frozen");
  }
  for (const r of RULES) {
    assert.ok(named.has(r.id), `${r.id} is named by a property`);
    assert.ok(property(r.field), `${r.id}'s field ${r.field} is a property`);
    assert.ok(ITEM_SEVERITIES.includes(r.severity), r.id);
  }
  assert.equal(new Set(PROPERTIES.map((p) => p.field)).size, PROPERTIES.length, "one row per field");
  // The rows the matrix calls out per runtime.
  assert.deepEqual(property("canvas.noise").classes, { macos: "C", "linux-software": "U", "linux-gpu": "U" });
  assert.deepEqual([property("webgpu.limits").classes["linux-software"], property("webgpu.limits").later, property("webgpu.limits").patch], ["D", "M", "961"]);
  assert.equal(classOf("hardware.imported", "linux-gpu"), "U");
  assert.equal(classOf("nothing", "macos"), null);
  assert.deepEqual([runtimeOf({ platform: "darwin" }), runtimeOf({ platform: "linux", backend: "hardware" }), runtimeOf({ platform: "linux", backend: "unverified" })], ["macos", "linux-gpu", "linux-software"]);
  // The spec's rule list, with its severities.
  const sev = Object.fromEntries(RULES.map((r) => [r.id, r.severity]));
  for (const id of ["backend.requested", "backend.stable", "require.webgl", "require.webgpu", "require.platforms", "webgl.strings-vs-backend", "webgl.limits-vs-backend", "webgl.context",
    "webgpu.vendor", "webgpu.device", "canvas.stable", "canvas.repeat", "screen.display", "locale", "ua.build", "sandbox.on", "bridge.absent"]) assert.equal(sev[id], "error", id);
  for (const id of ["webgl.same-origins", "webgpu.features-vs-limits", "fonts.available"]) assert.equal(sev[id], "warning", id);
  for (const id of ["media.capabilities", "memory"]) assert.equal(sev[id], "info", id);
  // The coherence rules the validator runs: the shared module's severities, each named by a property.
  for (const r of COHERENCE) {
    assert.equal(r.severity, COHERENCE_RULES[r.id], r.id);
    assert.ok(named.has(r.id) && property(r.field), `${r.id} is named by a property`);
  }
});

test("the E13 coherence rules are validation items: the Linux persona is gpu.software-as-hardware; a Mac's Apple GPU fits; an unbelievable window warns", () => {
  const persona = validate({ requested: requested(), derived: LINUX, measured: measurement("probe-linux-llvmpipe-persona", "systeminfo-linux-xvfb-llvmpipe", { webgpu: noWebgpu }) });
  const soft = itemOf(persona, "gpu.software-as-hardware");
  assert.deepEqual([soft.field, soft.status, soft.severity, soft.class], ["webgl.strings", "mismatch", "error", "M"]);
  assert.match(soft.reason, /hardware GPU \(ANGLE \(Intel, Mesa Intel\(R\) UHD Graphics 770.* while the browser renders in software/);
  assert.equal(itemOf(persona, "gpu.vs-platform").status, "matched", "an Intel GPU fits Linux");
  assert.equal(persona.status, "failed");
  // The real strings over llvmpipe: both rules matched, still validated.
  const real = validate({ requested: requested(), derived: LINUX, measured: measurement("probe-linux-llvmpipe-real", "systeminfo-linux-xvfb-llvmpipe", { webgpu: noWebgpu }) });
  assert.deepEqual([itemOf(real, "gpu.software-as-hardware").status, itemOf(real, "gpu.vs-platform").status, real.status], ["matched", "matched", "validated"]);
  // An Apple renderer read on Linux fails gpu.vs-platform.
  const m = measurement("probe-linux-llvmpipe-real", "systeminfo-linux-xvfb-llvmpipe", { webgpu: noWebgpu });
  m.webgl = { ...m.webgl, unmaskedRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)" };
  const apple = validate({ requested: requested(), derived: LINUX, measured: m });
  assert.deepEqual([itemOf(apple, "gpu.vs-platform").status, itemOf(apple, "gpu.vs-platform").field, itemOf(apple, "gpu.vs-platform").requested, apple.status], ["mismatch", "platform", "Linux x86_64", "failed"]);
  // The same Apple renderer when the browser really renders on an Apple GPU under Linux (Mesa's
  // asahi driver, a Linux guest on Apple Silicon): the real GPU, nothing to fix, no item fails.
  const asahi = measurement("probe-linux-llvmpipe-real", "systeminfo-linux-xvfb-llvmpipe", { webgpu: noWebgpu });
  asahi.webgl = { ...asahi.webgl, unmaskedRenderer: "ANGLE (Mesa, Apple M1 (G13G B0), OpenGL 4.6)" };
  asahi.backend = { ...asahi.backend, kind: "hardware", renderer: "Apple M1 (G13G B0)" };
  const onAsahi = itemOf(validate({ requested: requested(), derived: LINUX, measured: asahi }), "gpu.vs-platform");
  assert.deepEqual([onAsahi.status, onAsahi.reason], ["matched", "pages read the apple GPU the browser renders on"]);
  // A hardware backend of another family than the page's renderer is still judged.
  asahi.backend = { ...asahi.backend, renderer: "Mesa Intel(R) UHD Graphics 770 (RPL-S)" };
  assert.equal(itemOf(validate({ requested: requested(), derived: LINUX, measured: asahi }), "gpu.vs-platform").status, "mismatch");
  const mac = validate({ requested: requested(), derived: MAC, measured: measurement("probe-macos-metal", "systeminfo-macos-metal", { webgpu: noWebgpu, locale: null }) });
  assert.deepEqual([itemOf(mac, "gpu.vs-platform").status, itemOf(mac, "gpu.software-as-hardware"), mac.status], ["matched", undefined, "validated"]);
  // The profile's screen and window, with or without a measurement: a warning that never fails it.
  const screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1080, colorDepth: 24, devicePixelRatio: 1 };
  const win = validate({ requested: requested({ screen, window: { width: 2560, height: 1440 } }), derived: MAC, measured: null });
  const believable = itemOf(win, "screen.believable");
  assert.deepEqual([believable.field, believable.status, believable.severity, believable.class, win.status], ["window", "mismatch", "warning", "C", "unverified"]);
  assert.equal(itemOf(validate({ requested: requested({ screen }), derived: MAC, measured: null }), "screen.believable").status, "matched");
  assert.equal(itemOf(validate({ requested: requested(), derived: MAC, measured: null }), "gpu.vs-platform"), undefined, "nothing measured: no graphics coherence item");
});

test("a measurement that agrees everywhere is validated, every item in Phase D's shape, and the record passes the profile schema", () => {
  const entry = validate({ requested: requested({ locale: { timezone: "Europe/Berlin", languages: ["de-DE"] } }), derived: LINUX,
    measured: measurement("probe-linux-llvmpipe-real", "systeminfo-linux-xvfb-llvmpipe", { webgpu: noWebgpu }) });
  assert.equal(entry.status, "validated", JSON.stringify(entry.items.filter((i) => i.status !== "matched" && i.status !== "derived")));
  assert.equal(entry.runtimeKey, KEY);
  assert.equal(entry.pack, PACK);
  assert.equal(entry.graphics.backend.kind, "software");
  for (const i of entry.items) {
    assert.deepEqual(Object.keys(i), ["field", "rule", "class", "status", "requested", "measured", "severity", "reason"]);
    assert.ok(ITEM_STATUSES.includes(i.status) && ITEM_CLASSES.includes(i.class), JSON.stringify(i));
  }
  assert.equal(itemOf(entry, "webgl.strings-vs-backend").status, "matched");
  assert.equal(itemOf(entry, "webgl.strings-vs-backend").class, "M");
  assert.equal(itemOf(entry, "screen.display").status, "matched", "the virtual screen");
  assert.equal(itemOf(entry, "locale", "locale.timezone").class, "C");
  assert.equal(itemOf(entry, "memory").status, "derived");
  assert.equal(itemOf(entry, "memory").class, "D");
  assert.match(itemOf(entry, "sandbox.on").reason, /seccomp-BPF not required under emulation/);
  const record = JSON.parse(readFileSync(new URL("./fixtures/profiles/record-1.json", import.meta.url), "utf8"));
  assert.deepEqual(checkProfile({ ...record, validation: { [BUILD]: entry } }).problems, []);
  // macOS: Metal hardware agrees with the page's WebGL.
  const mac = validate({ requested: requested(), derived: MAC, measured: measurement("probe-macos-metal", "systeminfo-macos-metal", { webgpu: noWebgpu, locale: null }) });
  assert.equal(mac.status, "validated", JSON.stringify(mac.items.filter((i) => i.status === "mismatch" || i.status === "unverified")));
  assert.equal(itemOf(mac, "backend.requested").measured, "hardware");
  assert.equal(itemOf(mac, "screen.display"), undefined, "nothing to compare without a profile screen or a virtual one");
});

test("mismatch item carries field, rule, requested, measured, severity; status failed", () => {
  // The Linux persona before E2: WebGL says Intel UHD 770 over llvmpipe (condition 3, step 39).
  const persona = validate({ requested: requested(), derived: LINUX, measured: measurement("probe-linux-llvmpipe-persona", "systeminfo-linux-xvfb-llvmpipe", { webgpu: noWebgpu }) });
  assert.equal(persona.status, "failed");
  const strings = itemOf(persona, "webgl.strings-vs-backend");
  assert.deepEqual([strings.field, strings.status, strings.severity, strings.class], ["webgl.strings", "mismatch", "error", "M"]);
  assert.match(strings.reason, /^pages read a hardware renderer \(ANGLE \(Intel, Mesa Intel\(R\) UHD Graphics 770/);
  assert.match(strings.measured, /Intel/);
  // The persona's 1920x1080 over a 1366x768 Xvfb.
  const screen = itemOf(persona, "screen.display");
  assert.deepEqual([screen.status, screen.requested, screen.measured], ["mismatch", "1366x768", "1920x1080"]);
  assert.match(screen.reason, /^the virtual screen is a 1366x768 screen but pages read 1920x1080/);
  // A GPU asked for, software measured: the spec's sentence.
  const gpu = validate({ requested: requested({ graphics: { backend: "gpu", require: null } }), derived: LINUX, measured: measurement("probe-linux-llvmpipe-real", "systeminfo-linux-xvfb-llvmpipe", { webgpu: noWebgpu }) });
  const backend = itemOf(gpu, "backend.requested");
  assert.deepEqual([gpu.status, backend.field, backend.requested, backend.measured], ["failed", "graphics.backend", "gpu", "software"]);
  assert.match(backend.reason, /asks for a GPU \(graphics\.backend: gpu\) but this computer renders in software \(ANGLE \(Mesa\/X\.org, llvmpipe/);
  // Software on macOS isn't available with this build, measured or not.
  const soft = validate({ requested: requested({ graphics: { backend: "software", require: null } }), derived: MAC, measured: measurement("probe-macos-metal", "systeminfo-macos-metal", { webgpu: noWebgpu }) });
  assert.equal(itemOf(soft, "backend.requested").reason, "graphics.backend: software is not available on macOS with this build.");
  // Requirements unmet, a profile screen and locale that pages don't read, a canvas bridge switch.
  const req = validate({ requested: requested({ graphics: { backend: "auto", require: { webgl: 2, webgpu: true, platforms: ["macos"] } },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1050, colorDepth: 24, devicePixelRatio: 1 }, locale: { timezone: "Asia/Tokyo", languages: ["ja-JP"] },
    switches: ["--canvas-bridge-port=1"] }), derived: LINUX, measured: measurement("probe-linux-disable-gpu", "systeminfo-linux-disable-gpu") });
  assert.equal(req.status, "failed");
  for (const rule of ["require.webgl", "require.webgpu", "require.platforms", "screen.display", "bridge.absent"]) assert.equal(itemOf(req, rule).status, "mismatch", rule);
  assert.match(itemOf(req, "require.webgpu").reason, /requires WebGPU but no adapter is available here \(requestAdapter returned null\)/);
  assert.deepEqual([itemOf(req, "locale", "locale.timezone").requested, itemOf(req, "locale", "locale.timezone").measured], ["Asia/Tokyo", "Europe/Berlin"]);
  assert.equal(itemOf(req, "locale", "locale.languages").status, "mismatch");
  assert.equal(itemOf(req, "bridge.absent").reason, "the launch passed --canvas-bridge-port");
  // The mapping's own items come first, kept as they are.
  const mapped = { field: "window", rule: "profile.map", class: "C", status: "applied", requested: { width: 1440, height: 900 }, measured: null, severity: "info", reason: "--window-size" };
  assert.deepEqual(validate({ requested: requested({ results: [mapped] }), derived: LINUX, measured: null }).items[0], mapped);
});

test("missing measurement is unverified, never validated", () => {
  const none = validate({ requested: requested({ graphics: { backend: "gpu", require: null } }), derived: LINUX, measured: null, at: AT });
  assert.equal(none.status, "unverified");
  assert.equal(none.at, AT);
  assert.ok(!("graphics" in none) && !("runtimeKey" in none), "no measurement kept");
  assert.ok(none.items.length && none.items.every((i) => i.status !== "matched" || i.rule === "bridge.absent"), JSON.stringify(none.items));
  assert.equal(itemOf(none, "backend.requested").status, "unverified");
  // Another runtime key or pack: the measurement is not this runtime's, so it counts for nothing.
  const m = measurement("probe-linux-llvmpipe-real", "systeminfo-linux-xvfb-llvmpipe", { webgpu: noWebgpu });
  const moved = validate({ requested: requested(), derived: { ...LINUX, runtimeKey: "c".repeat(64) }, measured: m });
  assert.equal(moved.status, "unverified");
  assert.match(itemOf(moved, "sandbox.on").reason, /measured on another runtime/);
  assert.equal(validate({ requested: requested(), derived: { ...LINUX, pack: "d".repeat(64) }, measured: m }).status, "unverified");
  // Not a measurement at all (no time, key or runtime).
  for (const bad of [{}, { ...m, runtimeKey: "x" }, { ...m, runtime: { platform: "windows", arch: "x64", display: "native" } }, "text"]) {
    assert.equal(measuredRecord(bad), null);
    assert.equal(validate({ requested: requested(), derived: LINUX, measured: bad }).status, "unverified");
  }
  // A part an error rule needs, not answered (and no switch asked for it): unverified, not validated.
  const partial = validate({ requested: requested(), derived: LINUX, measured: { ...m, canvas: null } });
  assert.equal(partial.status, "unverified");
  assert.equal(itemOf(partial, "canvas.stable").status, "unverified");
  // The sandbox page timed out on Linux: unverified; a required layer missing: failed.
  const timedOut = validate({ requested: requested(), derived: LINUX, measured: { ...m, runtime: { ...m.runtime, sandbox: { on: true, page: "timeout" } } } });
  assert.deepEqual([timedOut.status, itemOf(timedOut, "sandbox.on").reason], ["unverified", "the sandbox page timed out"]);
  const noSeccomp = validate({ requested: requested(), derived: LINUX, measured: { ...m, runtime: { ...m.runtime, emulated: false } } });
  assert.deepEqual([noSeccomp.status, itemOf(noSeccomp, "sandbox.on").reason], ["failed", "the sandbox page shows seccomp-BPF missing"]);
  assert.equal(validate({ requested: requested(), derived: LINUX, measured: { ...m, runtime: { ...m.runtime, sandbox: { on: false, page: null } } } }).status, "failed");
});

test("switch without page result counts failed", () => {
  // This launch's page read a 1920x1080 screen (the seed's, before E7): its virtual screen here.
  const LINUX = { ...LINUX_1366, virtualScreen: { width: 1920, height: 1080 } };
  const m = measurement("probe-linux-swiftshader-real", "systeminfo-linux-xvfb-swiftshader", { webgpu: noWebgpu });
  const asked = requested({ graphics: { backend: "software", require: null }, switches: ["--use-angle=swiftshader"], locale: { timezone: null, languages: ["de-DE"] } });
  assert.equal(validate({ requested: asked, derived: LINUX, measured: m }).status, "validated");
  const noBackend = validate({ requested: asked, derived: LINUX, measured: { ...m, backend: null } });
  assert.equal(noBackend.status, "failed");
  assert.equal(itemOf(noBackend, "backend.requested").reason, "the launch passed --use-angle, and the page answered nothing for the backend");
  const noGl = validate({ requested: asked, derived: LINUX, measured: { ...m, webgl: null } });
  assert.equal(itemOf(noGl, "webgl.strings-vs-backend").status, "mismatch");
  assert.equal(validate({ requested: { ...asked, switches: ["--lang=de-DE"] }, derived: LINUX, measured: { ...m, locale: null } }).status, "failed");
  // The same parts missing without a switch for them: unverified.
  assert.equal(validate({ requested: requested(), derived: LINUX, measured: { ...m, backend: null } }).status, "unverified");
});

test("requestDevice failing with reported limits is a webgpu.device error", () => {
  const mac = validate({ requested: requested(), derived: MAC, measured: measurement("probe-macos-metal", "systeminfo-macos-metal", { locale: null }) });
  const device = itemOf(mac, "webgpu.device");
  assert.deepEqual([mac.status, device.field, device.severity, device.status, device.class], ["failed", "webgpu.limits", "error", "mismatch", "M"]);
  assert.match(device.reason, /^requestDevice with the adapter's reported limits fails \(Failed to execute 'requestDevice' on 'GPUAdapter': Required limit \(16\) is greater than the supported limit \(10\)\.\)/);
  assert.equal(itemOf(mac, "webgpu.vendor").status, "matched", "apple/metal-3 over Metal");
  assert.equal(itemOf(mac, "webgpu.features-vs-limits").status, "matched");
  // Linux's fallback adapter: a software adapter over a software backend, the device error the same; limits class D until 961.
  const linux = validate({ requested: requested({ switches: ["--enable-unsafe-webgpu"] }), derived: LINUX, measured: measurement("probe-linux-webgpu-fallback-real", "systeminfo-linux-xvfb-llvmpipe") });
  assert.equal(itemOf(linux, "webgpu.vendor").status, "matched");
  assert.deepEqual([itemOf(linux, "webgpu.device").status, itemOf(linux, "webgpu.device").class], ["mismatch", "D"]);
  assert.match(itemOf(linux, "webgpu.device").reason, /maxComputeInvocationsPerWorkgroup|supported limit/);
  // A device that works with the reported limits is matched; an Intel adapter over llvmpipe isn't.
  const ok = measurement("probe-linux-webgpu-fallback-real", "systeminfo-linux-xvfb-llvmpipe");
  ok.webgpu = { ...ok.webgpu, deviceWithReportedLimits: "ok" };
  assert.equal(itemOf(validate({ requested: requested(), derived: LINUX, measured: ok }), "webgpu.device").status, "matched");
  ok.webgpu = { ...ok.webgpu, vendor: "intel", architecture: "gen-12-lp", isFallbackAdapter: false };
  assert.equal(itemOf(validate({ requested: requested(), derived: LINUX, measured: ok }), "webgpu.vendor").status, "mismatch");
  // The measurement keeps at most 40 features and 48 limits, and a page string is cut.
  const big = measuredRecord({ ...ok, webgpu: { available: true, features: Array(100).fill("f"), limits: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`l${i}`, i])) }, navigator: { userAgent: "x".repeat(1000) } });
  assert.deepEqual([big.webgpu.features.length, Object.keys(big.webgpu.limits).length, big.navigator.userAgent.length], [40, 48, 300]);
  assert.deepEqual([rendererFamily("ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro)"), rendererFamily("Google SwiftShader"), rendererFamily("ANGLE (NVIDIA, GeForce)"), rendererFamily("")], ["apple", "software", "nvidia", null]);
});

// Decision 10: a measurement made under the identity a host without a GPU shows (its shown names
// native/graphics.mjs GPU_LESS_IDENTITY) is checked for consistency with that identity, WebGL and
// WebGPU agreeing, and its status is "consistent"; anything else under it fails.
test("under the identity shown on a host without a GPU the persona strings are consistent, not a mismatch; what disagrees with it fails", () => {
  const adapter = { available: true, reason: null, vendor: "intel", architecture: "gen-12-lp", isFallbackAdapter: false, features: ["depth-clip-control", "texture-compression-bc"],
    limits: { maxTextureDimension2D: 8192, maxBindGroups: 4, maxBindGroupsPlusVertexBuffers: 24, maxComputeInvocationsPerWorkgroup: 256, maxComputeWorkgroupSizeX: 256, maxBufferSize: 1073741824, maxUniformBufferBindingSize: 65536 },
    requestDevice: "ok", compute: "2,4,6,8" };
  const under = (extra = {}) => measurement("probe-linux-llvmpipe-persona", "systeminfo-linux-xvfb-llvmpipe", { shown: GPU_LESS_IDENTITY.name, webgpu: adapter, screen: { width: 1366, height: 768, availWidth: 1366, availHeight: 768, colorDepth: 24, devicePixelRatio: 1 }, ...extra });
  const entry = validate({ requested: requested(), derived: LINUX, measured: under() });
  assert.equal(entry.status, "consistent", JSON.stringify(entry.items.filter((i) => i.status === "mismatch" || i.status === "unverified")));
  assert.equal(entry.graphics.shown, GPU_LESS_IDENTITY.name);
  assert.equal(entry.graphics.backend.kind, "software", "the host's backend stays what it is");
  const strings = itemOf(entry, "webgl.strings-vs-backend");
  assert.deepEqual([strings.status, strings.requested], ["matched", "Intel UHD Graphics 770"]);
  assert.match(strings.reason, /pages read the identity shown over software rendering/);
  assert.equal(itemOf(entry, "webgpu.vendor").reason, "the adapter follows the identity shown (intel/gen-12-lp)");
  assert.match(itemOf(entry, "gpu.software-as-hardware").reason, /one identity over software rendering \(Intel UHD Graphics 770\), WebGL and WebGPU agreeing/);
  assert.equal(itemOf(entry, "gpu.vs-platform").status, "matched", "an Intel GPU fits Linux");
  assert.equal(itemOf(entry, "backend.requested").measured, "software");
  assert.equal(entryStatus(entry, { pack: PACK, runtimeKey: KEY }), "consistent");
  const record = JSON.parse(readFileSync(new URL("./fixtures/profiles/record-1.json", import.meta.url), "utf8"));
  assert.deepEqual(checkProfile({ ...record, validation: { [BUILD]: entry } }).problems, []);
  // No WebGPU adapter: still consistent (a defined result, nothing to compare).
  assert.equal(validate({ requested: requested(), derived: LINUX, measured: under({ webgpu: noWebgpu }) }).status, "consistent");
  // A fallback or another vendor's adapter under the identity: WebGPU doesn't follow it.
  const fallback = validate({ requested: requested(), derived: LINUX, measured: under({ webgpu: { ...adapter, vendor: "google", architecture: "swiftshader", isFallbackAdapter: true } }) });
  assert.equal(fallback.status, "failed");
  assert.match(itemOf(fallback, "webgpu.vendor").reason, /^the WebGPU adapter says google\/swiftshader \(a fallback adapter\) while the launch shows Intel UHD Graphics 770 \(intel\/gen-12-lp\)/);
  assert.match(itemOf(fallback, "gpu.software-as-hardware").reason, /the WebGPU adapter says google\/swiftshader \(a fallback adapter\) while the launch shows Intel UHD Graphics 770 over software rendering/);
  // The real llvmpipe strings under a launch that says it shows the identity: pages don't read it.
  const real = validate({ requested: requested(), derived: LINUX, measured: measurement("probe-linux-llvmpipe-real", "systeminfo-linux-xvfb-llvmpipe", { shown: GPU_LESS_IDENTITY.name, webgpu: noWebgpu }) });
  assert.equal(real.status, "failed");
  assert.match(itemOf(real, "webgl.strings-vs-backend").reason, /^pages read ANGLE \(Mesa\/X\.org, llvmpipe.* while the launch shows Intel UHD Graphics 770$/);
  assert.match(itemOf(real, "gpu.software-as-hardware").reason, /^WebGL reads ANGLE \(Mesa\/X\.org, llvmpipe.* while the launch shows Intel UHD Graphics 770 over software rendering$/);
  // An identity PairBrowse doesn't know, or one shown over a hardware backend: never consistent.
  const unknown = validate({ requested: requested(), derived: LINUX, measured: under({ shown: "Zq GPU 9000" }) });
  assert.equal(unknown.status, "failed");
  assert.match(itemOf(unknown, "webgl.strings-vs-backend").reason, /an identity PairBrowse doesn't know \(Zq GPU 9000\)/);
  const m = under();
  m.backend = { ...m.backend, kind: "hardware", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070)" };
  const overHardware = validate({ requested: requested(), derived: LINUX, measured: m });
  assert.equal(overHardware.status, "failed");
  assert.match(itemOf(overHardware, "webgl.strings-vs-backend").reason, /shows Intel UHD Graphics 770 over a nvidia backend; an identity is shown over software rendering only/);
  // Without shown the persona strings over llvmpipe stay the mismatch of section 13.1.
  assert.equal(validate({ requested: requested(), derived: LINUX, measured: under({ shown: null }) }).status, "failed");
  // A gpu request under the identity is still a software backend: refused as before.
  assert.equal(itemOf(validate({ requested: requested({ graphics: { backend: "gpu", require: null } }), derived: LINUX, measured: under() }), "backend.requested").status, "mismatch");
});

test("backend.stable compares this launch's read with the measurement", () => {
  const m = measurement("probe-linux-llvmpipe-real", "systeminfo-linux-xvfb-llvmpipe", { webgpu: noWebgpu });
  assert.equal(itemOf(validate({ requested: requested(), derived: LINUX, measured: m }), "backend.stable"), undefined, "no live read: not checked");
  assert.equal(itemOf(validate({ requested: requested(), derived: LINUX, measured: m, live: { kind: "software", renderer: m.backend.renderer } }), "backend.stable").status, "matched");
  const moved = validate({ requested: requested(), derived: LINUX, measured: m, live: { kind: "hardware", renderer: "ANGLE (NVIDIA)" } });
  assert.deepEqual([moved.status, itemOf(moved, "backend.stable").status], ["failed", "mismatch"]);
  assert.equal(validate({ requested: requested(), derived: LINUX, measured: m, live: { kind: "unverified" } }).status, "unverified");
});

test("measurement stored in validation[build].graphics, revision unchanged", () => {
  let t = Date.parse(AT), n = 0;
  const dir = join(mkdtempSync(join(tmpdir(), "pb-validate-")), "browser-profiles");
  const store = createProfileStore({ dir, now: () => (t += 1000), randomId: () => (++n).toString(16).padStart(16, "0") });
  const LINUX = { ...LINUX_1366, virtualScreen: { width: 1920, height: 1080 } };
  const p = store.create({ name: "server", graphics: { backend: "software", require: { webgl: 2, webgpu: false, platforms: ["linux"] } } });
  const entry = validate({ requested: requested({ graphics: p.graphics, switches: ["--use-angle=swiftshader"] }), derived: LINUX,
    measured: measurement("probe-linux-swiftshader-real", "systeminfo-linux-xvfb-swiftshader", { webgpu: noWebgpu, locale: null }) });
  assert.equal(entry.status, "validated", JSON.stringify(entry.items.filter((i) => i.status !== "matched")));
  assert.equal(store.recordValidation(p.id, { build: BUILD, entry }), true);
  assert.equal(store.recordValidation(p.id, { build: BUILD, entry }), false, "the same again writes nothing");
  const kept = store.get(p.id);
  assert.equal(kept.revision, 1);
  assert.deepEqual(kept.history, []);
  assert.deepEqual(kept.graphics, p.graphics, "the request is as it was");
  assert.deepEqual(kept.validation[BUILD].graphics, entry.graphics);
  assert.equal(kept.validation[BUILD].graphics.backend.kind, "software");
  // A launch's own entry never writes over the measurement; a launch-shaped entry isn't a measurement.
  assert.equal(store.recordLaunch(p.id, { build: BUILD, entry: { status: "unverified", at: AT, pack: PACK, items: [] } }), false);
  assert.throws(() => store.recordValidation(p.id, { build: BUILD, entry: { status: "unverified", at: AT, pack: PACK, items: [] } }), (e) => e.code === "PROFILE_INVALID");
  // validated without a measurement, or with another runtime's, is refused by the schema.
  const { graphics: _g, runtimeKey: _k, ...bare } = entry;
  assert.throws(() => store.recordValidation(p.id, { build: BUILD, entry: { ...bare, graphics: entry.graphics, runtimeKey: "c".repeat(64) } }), /another runtime key or pack/);
  const rec = store.get(p.id);
  assert.match(checkProfile({ ...rec, validation: { [BUILD]: bare } }).problems[0], /is validated only with a measurement/);
  // The config-backed default takes a measurement the same way.
  const def = store.configProfile({});
  assert.equal(store.recordValidation(def.id, { build: BUILD, entry }), true);
  assert.equal(store.configProfile({}).validation[BUILD].status, "validated");
  assert.equal(store.configProfile({}).revision, 1);
});

test("a store reload and a second forLaunch see the same request and measurement; a changed runtime key gives unverified", () => {
  let t = Date.parse(AT), n = 0;
  const dir = join(mkdtempSync(join(tmpdir(), "pb-validate-")), "browser-profiles");
  const opts = { dir, now: () => (t += 1000), randomId: () => (++n).toString(16).padStart(16, "0") };
  const store = createProfileStore(opts);
  const p = store.create({ name: "server", graphics: { backend: "software", require: null } });
  const entry = validate({ requested: requested({ graphics: p.graphics }), derived: LINUX, measured: measurement("probe-linux-llvmpipe-real", "systeminfo-linux-xvfb-llvmpipe", { webgpu: noWebgpu, locale: null }) });
  store.recordValidation(p.id, { build: BUILD, entry });
  const again = createProfileStore(opts).get(p.id);
  assert.deepEqual(again.graphics, { backend: "software", require: null });
  assert.deepEqual(again.validation[BUILD], entry);
  assert.equal(entryStatus(again.validation[BUILD], { pack: PACK, runtimeKey: KEY }), "validated");
  assert.equal(entryStatus(again.validation[BUILD], { pack: PACK }), "validated", "the runtime key unknown until the browser answers");
  assert.equal(entryStatus(again.validation[BUILD], { pack: PACK, runtimeKey: "c".repeat(64) }), "unverified");
  assert.equal(entryStatus(again.validation[BUILD], { pack: "d".repeat(64) }), "unverified");
  assert.equal(entryStatus(again.validation[BUILD], { pack: null }), "unverified");
  assert.equal(entryStatus({ status: "unverified", at: AT, pack: PACK, items: [] }, { pack: PACK }), "unverified");
  assert.equal(entryStatus(null), "unverified");
  // A launch must name its pack (undefined, or not a SHA-256, counts nothing), and so must the entry.
  assert.equal(entryStatus(again.validation[BUILD]), "unverified");
  assert.equal(entryStatus(again.validation[BUILD], { pack: "x" }), "unverified");
  assert.equal(entryStatus({ ...again.validation[BUILD], pack: null, graphics: { ...again.validation[BUILD].graphics, pack: null } }, { pack: null }), "unverified");
});

test("a measurement with no engine pack stays unverified, kept as evidence; the schema refuses it validated", () => {
  const m = measurement("probe-linux-llvmpipe-real", "systeminfo-linux-xvfb-llvmpipe", { webgpu: noWebgpu, locale: null, pack: null });
  const { pack: _p, ...noPack } = LINUX;
  const entry = validate({ requested: requested(), derived: noPack, measured: m });
  assert.deepEqual([entry.status, entry.pack, entry.runtimeKey, entry.graphics.pack], ["unverified", null, KEY, null]);
  assert.equal(entryStatus(entry, { pack: null }), "unverified");
  // The same measurement with its pack is validated, so only the missing pack held it back.
  assert.equal(validate({ requested: requested(), derived: LINUX, measured: { ...m, pack: PACK } }).status, "validated");
  const base = createProfileStore({ dir: join(mkdtempSync(join(tmpdir(), "pb-validate-")), "browser-profiles") }).create({ name: "nopack" });
  assert.deepEqual(checkProfile({ ...base, validation: { [BUILD]: entry } }).problems, [], "unverified with its measurement is accepted");
  for (const status of ["validated", "failed"]) {
    assert.match(checkProfile({ ...base, validation: { [BUILD]: { ...entry, status } } }).problems.join("; "), new RegExp(`is ${status} only with the engine pack`));
  }
});

test("the largest measurement measuredRecord keeps fits the schema's graphics size", () => {
  const q = (n) => '"'.repeat(n);
  const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const big = -1.7976931348623157e+308;
  const gl = { available: true, reason: q(999), unmaskedVendor: q(999), unmaskedRenderer: q(999), version: q(999),
    maxTextureSize: big, maxRenderbufferSize: big, extensions: big, sameOrigins: true };
  const raw = { at: "2026-10-21T10:00:00.000Z", runtimeKey: KEY, pack: PACK,
    runtime: { platform: "linux", arch: "x64", display: "xvfb", emulated: true, sandbox: { on: true, page: many(99, () => q(999)) } },
    backend: { kind: "unverified", vendor: q(999), device: q(999), renderer: q(999), driver: q(999) },
    webgl: gl, webgl2: gl,
    webgpu: { available: true, reason: q(999), vendor: q(999), architecture: q(999), isFallbackAdapter: false,
      features: many(99, (i) => `f${i}-`.padEnd(48, "x")), limits: Object.fromEntries(many(99, (i) => [`L${i}`.padEnd(40, "x"), Number.MAX_SAFE_INTEGER])),
      requestDevice: { ok: false, error: q(999) }, compute: { ok: false, error: q(999) } },
    canvas: { stable: true, repeat: true, noise: true },
    shown: q(999),
    fonts: { checked: big, missing: many(99, () => q(999)), controlFound: many(99, () => q(999)) },
    media: Object.fromEntries(many(99, (i) => [`${i}`.padEnd(64, '"'), q(999)])),
    screen: { width: big, height: big, availWidth: big, availHeight: big, colorDepth: big, devicePixelRatio: big },
    locale: { timezone: q(999), languages: many(99, () => q(999)) },
    navigator: { userAgent: q(999), platform: q(999), hardwareConcurrency: big, deviceMemory: big } };
  // Control characters and lone surrogates are dropped, so no character grows past two as JSON.
  const odd = measuredRecord({ ...raw, backend: { ...raw.backend, renderer: "\u0000".repeat(999) + "\ud800".repeat(999) } });
  assert.equal(odd.backend.renderer, "");
  const graphics = measuredRecord(raw);
  assert.ok(JSON.stringify(graphics).length <= 20000, String(JSON.stringify(graphics).length));
  const entry = { status: "validated", at: AT, pack: PACK, runtimeKey: KEY, graphics, items: [] };
  const base = createProfileStore({ dir: join(mkdtempSync(join(tmpdir(), "pb-validate-")), "browser-profiles") }).create({ name: "largest" });
  assert.deepEqual(checkProfile({ ...base, validation: { [BUILD]: entry } }).problems, []);
});
