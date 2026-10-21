// The native build's graphics (spec server-mode Phase E, E2, E3, E7, E8, E9; scripts/native/
// graphics.mjs, scripts/native/backend.mjs): the backend a launch asks for and how, every request
// that can't be met as an error naming it (never a partial apply), the runtime key a measurement
// belongs to, the browser process's own read of its backend (over spike E-S1's SystemInfo
// fixtures), and the Linux plan of section 13.1: the real backend's strings, no noise, the virtual
// screen as the screen.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GRAPHICS_BACKENDS, SOFTWARE_SWITCH, graphicsPlan, compatErrors, runtimeKey, backendSwitches, GRAPHICS } from "../scripts/native/graphics.mjs";
import { parseSystemInfo, readBackend, unverifiedBackend } from "../scripts/native/backend.mjs";
import { applyGraphicsPlan } from "../scripts/native-engine.mjs";
import { configProblem, PAIRBROWSE_ENGINE_KEYS } from "../scripts/config-schema.mjs";
import { readConfig, toLaunch, SWITCHES } from "../scripts/profiles/map.mjs";
import { screenBrowserArgs, switchName } from "../scripts/browser-args.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const systemInfo = (name) => fixture(`systeminfo-${name}`).systemInfo;
const XVFB = { width: 1366, height: 900, depth: 24 };
const messages = (list) => list.map((e) => e.message);

test("auto, software, gpu accepted, others refused", () => {
  assert.deepEqual([...GRAPHICS_BACKENDS], ["auto", "software", "gpu"]);
  for (const requested of GRAPHICS_BACKENDS) assert.deepEqual(graphicsPlan({ requested, platform: "linux" }).refusals, [], requested);
  for (const requested of ["metal", "", null, 1, "GPU"]) {
    const plan = graphicsPlan({ requested, platform: "linux" });
    assert.deepEqual(messages(plan.refusals), ['graphics.backend takes "auto", "software" or "gpu".'], String(requested));
    assert.deepEqual([plan.switches, plan.engineKeys], [[], {}], "nothing applies partly");
  }
  // software is the engine's own software path on Linux, and nothing new in browserArgs' allowlist.
  const soft = graphicsPlan({ requested: "software", platform: "linux" });
  assert.deepEqual(soft.switches, [SOFTWARE_SWITCH]);
  assert.deepEqual(screenBrowserArgs(soft.switches, "linux", { harness: false }), { kept: soft.switches, dropped: [], refused: [] });
  assert.deepEqual(graphicsPlan({ requested: "auto", platform: "linux" }).switches, [], "auto adds no switch: Xvfb already renders in software");
  // config.json's pairbrowse.graphics (the default profile's backend) takes the same values.
  for (const graphics of GRAPHICS_BACKENDS) assert.equal(configProblem({ pairbrowse: { graphics } }), "", graphics);
  assert.match(configProblem({ pairbrowse: { graphics: "metal" } }), /^pairbrowse\.graphics is "auto", "software" or "gpu", not "metal"/);
  assert.ok(!PAIRBROWSE_ENGINE_KEYS.includes("graphics"), "a PairBrowse setting, never an engine option");
});

test("gpu with --disable-gpu refused", () => {
  for (const arg of ["--disable-gpu", "--use-angle=swiftshader", "--use-gl=swiftshader"]) {
    const plan = graphicsPlan({ requested: "gpu", platform: "linux", userArgs: ["--lang=de", arg], name: "berlin" });
    assert.equal(plan.refusals.length, 1, arg);
    assert.equal(plan.refusals[0].message, `Profile berlin asks for a GPU (graphics.backend: gpu) but browserArgs forces software rendering (${arg.split("=")[0]}); remove it or ask for "auto".`);
    assert.deepEqual([plan.switches, plan.engineKeys], [[], {}]);
  }
  assert.deepEqual(graphicsPlan({ requested: "gpu", platform: "linux", userArgs: ["--use-angle=vulkan"] }).refusals, [], "a hardware path is no refusal before launch");
  // software with another renderer picked in browserArgs: two renderers, refused.
  assert.match(messages(graphicsPlan({ requested: "software", platform: "linux", userArgs: ["--use-angle=vulkan"] }).refusals)[0], /browserArgs picks another renderer \(--use-angle\)/);
  assert.deepEqual(graphicsPlan({ requested: "software", platform: "linux", userArgs: ["--disable-gpu"] }).refusals, [], "already software");
});

test("Linux plan sets disableGpuFingerprint and noise off", () => {
  const plan = graphicsPlan({ requested: "auto", platform: "linux", display: XVFB });
  assert.deepEqual(plan.engineKeys, { disableGpuFingerprint: true, fingerprintNoise: false, screenWidth: 1366, screenHeight: 900, availWidth: 1366, availHeight: 900, colorDepth: 24, devicePixelRatio: 1 });
  for (const k of Object.keys(plan.engineKeys)) assert.ok(PAIRBROWSE_ENGINE_KEYS.includes(k), `${k} is an engine key`);
  // Every backend on Linux; a forced scale factor is the screen's ratio; no display, no screen keys;
  // a screen a profile or config.json sets is left to E7's check, never replaced.
  for (const requested of GRAPHICS_BACKENDS) assert.equal(graphicsPlan({ requested, platform: "linux" }).engineKeys.disableGpuFingerprint, true, requested);
  assert.equal(graphicsPlan({ platform: "linux", display: { width: 1920, height: 1080, depth: 16 }, userArgs: ["--force-device-scale-factor=2"] }).engineKeys.devicePixelRatio, 2);
  assert.equal(graphicsPlan({ platform: "linux", display: { width: 1920, height: 1080, depth: 16 } }).engineKeys.colorDepth, 16);
  assert.deepEqual(graphicsPlan({ platform: "linux" }).engineKeys, { disableGpuFingerprint: true, fingerprintNoise: false });
  assert.deepEqual(graphicsPlan({ platform: "linux", display: XVFB, screenSet: true }).engineKeys, { disableGpuFingerprint: true, fingerprintNoise: false });
  // macOS keeps the host capture (its own GPU): the plan adds nothing there.
  assert.deepEqual(graphicsPlan({ platform: "darwin", display: XVFB }), { switches: [], engineKeys: {}, refusals: [] });
  // The open build: nothing, and anything but auto is refused (E9).
  assert.deepEqual(graphicsPlan({ platform: "linux", browserKind: "pairbrowse-open", display: XVFB }), { switches: [], engineKeys: {}, refusals: [] });
  assert.match(messages(graphicsPlan({ requested: "software", platform: "linux", browserKind: "pairbrowse-open" }).refusals)[0], /only the native PairBrowse build can do/);
});

test("the Linux plan on a launch's fingerprint: persona untouched, legacy GPU keys named and left out", () => {
  const logs = [];
  const settings = { overrides: { gpuVendor: "Zq GPU", fingerprintNoise: true }, saved: {} };
  const fingerprint = { fingerprint: "seed", gpuVendor: "Zq GPU", gpuRenderer: "Zq Renderer", fingerprintNoise: true, timezone: "UTC" };
  const plan = applyGraphicsPlan(fingerprint, settings, { platform: "linux", display: XVFB, log: (l) => logs.push(l) });
  assert.deepEqual(fingerprint, { fingerprint: "seed", timezone: "UTC", ...plan.engineKeys });
  assert.equal(fingerprint.screenWidth, 1366);
  assert.ok(logs.some((l) => /gpuVendor, gpuRenderer \(another device's GPU\) are deprecated and go in the next release \(decision U6\)/.test(l)));
  assert.ok(logs.some((l) => /gpuVendor, gpuRenderer not applied on Linux/.test(l)));
  assert.ok(logs.some((l) => /fingerprintNoise not applied on Linux/.test(l)));
  assert.ok(logs.some((l) => /screen 1366x900 \(the virtual screen\)/.test(l)));
  assert.ok(!logs.join("\n").includes("Zq"), "no value repeated");
  // A screen the settings set stays (E7 compares it with the display).
  const own = { fingerprint: "seed", screenWidth: 1920, screenHeight: 1080 };
  applyGraphicsPlan(own, { overrides: { screenWidth: 1920, screenHeight: 1080 }, saved: {} }, { platform: "linux", display: XVFB });
  assert.deepEqual([own.screenWidth, own.screenHeight, own.disableGpuFingerprint], [1920, 1080, true]);
  // macOS: the legacy keys still apply for this release, named deprecated; nothing else changes.
  const mac = { gpuVendor: "Zq GPU" }, macLogs = [];
  applyGraphicsPlan(mac, { overrides: mac, saved: {} }, { platform: "darwin", display: null, log: (l) => macLogs.push(l) });
  assert.deepEqual(mac, { gpuVendor: "Zq GPU" });
  assert.equal(macLogs.length, 1);
  assert.match(macLogs[0], /gpuVendor \(another device's GPU\) is deprecated and goes in the next release/);
});

test("gpu requested, software measured: error", () => {
  const measured = { backend: parseSystemInfo(systemInfo("linux-xvfb-llvmpipe")) };
  const errors = compatErrors({ name: "berlin", graphics: { backend: "gpu", require: null }, platform: "linux", measured });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /^Profile berlin asks for a GPU \(graphics\.backend: gpu\) but this computer renders in software \(ANGLE \(Mesa\/X\.org, llvmpipe/);
  assert.deepEqual(compatErrors({ graphics: { backend: "gpu", require: null }, platform: "darwin", measured: { backend: parseSystemInfo(systemInfo("macos-metal")) } }), [], "a hardware backend meets it");
  // SystemInfo unanswered: never assumed; with gpu set the launch can't go on.
  const unanswered = compatErrors({ name: "berlin", graphics: { backend: "gpu", require: null }, platform: "linux", measured: { backend: unverifiedBackend("timeout") } });
  assert.match(unanswered[0].message, /could not confirm which renderer this browser uses/);
  assert.deepEqual(compatErrors({ graphics: { backend: "gpu", require: null }, platform: "linux", measured: null }), [], "before any measurement: checked after launch");
});

test("software on macOS refused", () => {
  for (const platform of ["darwin", "win32"]) {
    const plan = graphicsPlan({ requested: "software", platform });
    assert.deepEqual(plan.switches, [], platform);
    assert.equal(plan.refusals.length, 1);
  }
  assert.equal(messages(graphicsPlan({ requested: "software", platform: "darwin" }).refusals)[0], "graphics.backend: software is not available on macOS with this build.");
  assert.deepEqual(graphicsPlan({ requested: "software", platform: "linux" }).refusals, [], "Linux has a software path");
});

test("require unmet errors", () => {
  const llvmpipe = { backend: parseSystemInfo(systemInfo("linux-xvfb-llvmpipe")), webgl: { available: true }, webgl2: { available: true }, webgpu: { available: false, reason: "no adapter without --enable-unsafe-webgpu" } };
  const req = (r) => ({ backend: "auto", require: { webgl: null, webgpu: false, platforms: [], ...r } });
  assert.deepEqual(compatErrors({ name: "p", graphics: req({ webgl: 2 }), platform: "linux", measured: llvmpipe }), []);
  assert.equal(messages(compatErrors({ name: "p", graphics: req({ webgpu: true }), platform: "linux", measured: llvmpipe }))[0],
    "Profile p requires WebGPU but no adapter is available here (no adapter without --enable-unsafe-webgpu).");
  const off = { backend: parseSystemInfo(systemInfo("linux-disable-gpu")), webgl: { available: false, reason: "no context" }, webgl2: { available: false }, webgpu: null };
  assert.match(messages(compatErrors({ name: "p", graphics: req({ webgl: 2 }), platform: "linux", measured: off }))[0], /^Profile p requires WebGL2 but it is not available here/);
  assert.match(messages(compatErrors({ name: "p", graphics: req({ webgl: 1 }), platform: "linux", measured: off }))[0], /^Profile p requires WebGL but it is not available here \(no context\)/);
  // A platform requirement needs no measurement.
  assert.deepEqual(messages(compatErrors({ name: "p", graphics: req({ platforms: ["macos"] }), platform: "linux" })), ["Profile p requires macos, and this computer runs Linux."]);
  assert.deepEqual(compatErrors({ name: "p", graphics: req({ platforms: ["linux"] }), platform: "linux" }), []);
  // An unanswered backend with a requirement: could not confirm.
  assert.match(messages(compatErrors({ name: "p", graphics: req({ webgl: 2 }), platform: "linux", measured: { backend: unverifiedBackend("timeout") } }))[0], /could not confirm/);
  // The open build checks none: any graphics field there is an error.
  assert.match(messages(compatErrors({ name: "p", graphics: req({ webgl: 2 }), platform: "linux", browserKind: "pairbrowse-open" }))[0], /only the native PairBrowse build checks/);
  // The other E9 errors: canvasBridge, a legacy GPU identity the measured backend can't back.
  assert.match(messages(compatErrors({ name: "p", canvasBridge: true, platform: "linux" }))[0], /canvasBridge: refused/);
  const metal = { backend: parseSystemInfo(systemInfo("macos-metal")) };
  assert.deepEqual(messages(compatErrors({ platform: "darwin", measured: metal, legacy: { gpuVendor: "Intel Inc.", gpuRenderer: "Intel Iris" } })),
    ["config.json sets a GPU identity (gpuVendor, gpuRenderer) that this computer's hardware renderer cannot back."]);
  assert.deepEqual(compatErrors({ platform: "darwin", measured: metal, legacy: { gpuVendor: "Apple" } }), [], "the measured GPU's own vendor");
  assert.deepEqual(compatErrors({ platform: "linux", measured: llvmpipe, legacy: { gpuVendor: "Intel" } }), [], "never applied on Linux, so never an error there");
  assert.deepEqual(compatErrors({ platform: "darwin", legacy: { gpuVendor: "Intel" } }), [], "needs a measurement");
});

test("screen vs virtualScreen", () => {
  assert.deepEqual(messages(compatErrors({ name: "berlin", platform: "linux", display: XVFB, screen: { width: 1920, height: 1080 } })),
    ["Profile berlin sets a 1920x1080 screen but the virtual screen is 1366x900 (virtualScreen)."]);
  assert.deepEqual(compatErrors({ name: "berlin", platform: "linux", display: XVFB, screen: { width: 1366, height: 900 } }), []);
  assert.deepEqual(compatErrors({ name: "berlin", platform: "linux", display: null, screen: { width: 1920, height: 1080 } }), [], "a desktop's own screen");
  assert.deepEqual(compatErrors({ name: "berlin", platform: "darwin", display: XVFB, screen: { width: 1920, height: 1080 } }), []);
});

test("runtimeKey changes with driver, display kind, pack", () => {
  const backend = parseSystemInfo(systemInfo("linux-xvfb-llvmpipe"));
  const base = { build: "150.0.7871.114", pack: "a".repeat(64), platform: "linux", arch: "x64", display: "xvfb", backend, switches: ["--lang=de", "--use-angle=swiftshader"] };
  const key = runtimeKey(base);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(runtimeKey({ ...base, switches: ["--use-angle=swiftshader", "--window-size=1,1"] }), key, "only the backend switches count");
  const changed = [
    { ...base, backend: { ...backend, driver: "23.0.0" } }, { ...base, display: "native" }, { ...base, pack: "b".repeat(64) },
    { ...base, build: "150.0.7871.200" }, { ...base, arch: "arm64" }, { ...base, backend: { ...backend, device: 7 } }, { ...base, switches: [] },
  ];
  const keys = changed.map(runtimeKey);
  assert.equal(new Set([key, ...keys]).size, changed.length + 1, "each change is another runtime");
  assert.equal(runtimeKey({ ...base, build: undefined }), null);
  assert.equal(runtimeKey({ ...base, display: "" }), null);
  assert.deepEqual(backendSwitches(["--lang=de", "--disable-gpu", "--use-gl=egl", "--USE-ANGLE=metal", 7, "--enable-unsafe-webgpu"]), ["--disable-gpu", "--use-gl=egl", "--USE-ANGLE=metal", "--enable-unsafe-webgpu"]);
});

test("parseSystemInfo: Metal hardware, Xvfb software, garbage unverified", () => {
  const metal = parseSystemInfo(systemInfo("macos-metal"));
  assert.deepEqual(metal, { kind: "hardware", vendor: 4203, device: 0, renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Version 26.0.1 (Build 25A362))", driver: "26.0.1", source: "systeminfo" });
  for (const [name, renderer] of [["linux-xvfb-llvmpipe", /llvmpipe/], ["linux-xvfb-swiftshader", /SwiftShader/], ["linux-xvfb-lavapipe", /llvmpipe/]]) {
    const b = parseSystemInfo(systemInfo(name));
    assert.equal(b.kind, "software", name);
    assert.match(b.renderer, renderer, name);
    assert.equal(b.source, "systeminfo");
  }
  const off = parseSystemInfo(systemInfo("linux-disable-gpu"));
  assert.deepEqual([off.kind, off.renderer], ["software", "software rasterizer (GPU rendering off)"]);
  // A GPU the engine's blocklist refused is still named, but nothing renders on it (measured: the
  // open build 153 under Xvfb over Mesa's llvmpipe, no WebGL); the software fallback names its own.
  const named = { devices: [{ vendorId: 0, deviceId: 0, deviceString: "ANGLE (Mesa/X.org, llvmpipe (LLVM 15.0.6 128 bits))", driverVersion: "22.3.6" }],
    auxAttributes: { glRenderer: "ANGLE (Mesa/X.org, llvmpipe (LLVM 15.0.6 128 bits))", glImplementationParts: "(gl=egl-angle,angle=opengl)" } };
  const refused = parseSystemInfo({ gpu: { ...named, featureStatus: { gpu_compositing: "disabled_software", opengl: "disabled_off", webgl: "disabled_off" } } });
  assert.deepEqual([refused.kind, refused.renderer, refused.driver], ["software", "software rasterizer (GPU rendering off)", "22.3.6"]);
  const nvidia = { devices: [{ vendorId: 4318, deviceId: 7, deviceString: "NVIDIA GeForce" }], auxAttributes: { glRenderer: "NVIDIA GeForce" } };
  assert.equal(parseSystemInfo({ gpu: { ...nvidia, featureStatus: { gpu_compositing: "disabled_software", webgl: "unavailable_off" } } }).renderer, "software rasterizer (GPU rendering off)", "a refused hardware GPU is no hardware backend");
  assert.equal(parseSystemInfo({ gpu: { ...nvidia, featureStatus: { gpu_compositing: "enabled", webgl: "enabled" } } }).kind, "hardware");
  const fallback = parseSystemInfo({ gpu: { devices: [{ deviceString: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)" }],
    auxAttributes: { glRenderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)", glImplementationParts: "(gl=egl-angle,angle=swiftshader)" },
    featureStatus: { gpu_compositing: "disabled_software", webgl: "unavailable_software" } } });
  assert.deepEqual([fallback.kind, /SwiftShader/.test(fallback.renderer)], ["software", true], "WebGL on the software fallback names it");
  for (const garbage of [null, undefined, 7, "x", [], {}, { gpu: null }, { gpu: { devices: [] } }, { gpu: { devices: "x", auxAttributes: 3 } }, { gpu: { devices: [{}], auxAttributes: { glRenderer: "" } } }]) {
    const b = parseSystemInfo(garbage);
    assert.equal(b.kind, "unverified", JSON.stringify(garbage));
    assert.deepEqual([b.vendor, b.device, b.renderer, b.driver], [null, null, null, null]);
    assert.equal(typeof b.reason, "string");
  }
  // Strings are bounded and cleaned; IDs only whole numbers.
  const odd = parseSystemInfo({ gpu: { devices: [{ vendorId: -1, deviceId: 1.5, driverVersion: "1\u0000.2" }], auxAttributes: { glRenderer: `NVIDIA ${"x".repeat(400)}` } } });
  assert.deepEqual([odd.kind, odd.vendor, odd.device, odd.driver, odd.renderer.length], ["hardware", null, null, "1.2", 160]);
  // A device marked active wins.
  assert.equal(parseSystemInfo({ gpu: { devices: [{ vendorId: 1, deviceString: "Intel" }, { vendorId: 2, active: true, deviceString: "NVIDIA" }], auxAttributes: {} } }).vendor, 2);
});

test("readBackend asks the browser process over its own session, bounded, never assumed", async () => {
  const sent = [];
  let detached = 0;
  const ctx = (send, open = async () => ({ send: async (m) => { sent.push(m); return send(m); }, detach: async () => { detached++; } })) => ({ browser: () => ({ newBrowserCDPSession: open }) });
  const read = await readBackend(ctx(() => systemInfo("linux-xvfb-llvmpipe")));
  assert.equal(read.kind, "software");
  assert.deepEqual(sent, ["SystemInfo.getInfo"]);
  assert.equal(detached, 1, "the session is let go");
  const at = Date.now();
  const hang = await readBackend(ctx(() => new Promise(() => {})), { ms: 100 });
  assert.deepEqual([hang.kind, hang.reason], ["unverified", "SystemInfo didn't answer within 0.1 s"]);
  assert.ok(Date.now() - at < 2000);
  assert.equal((await readBackend(ctx(() => { throw new Error("nope"); }))).reason, "SystemInfo refused the request");
  assert.match((await readBackend(ctx(null, () => new Promise(() => {})), { ms: 50 })).reason, /opened no session/);
  assert.equal((await readBackend({ browser: () => null })).kind, "unverified");
  assert.equal((await readBackend(null)).kind, "unverified");
  assert.equal((await readBackend({ browser: () => { throw new Error("closed"); } })).kind, "unverified");
  // A driver that throws at once, opening or asking, gives unverified, never a throw.
  assert.equal((await readBackend({ browser: () => ({ newBrowserCDPSession: () => { throw new Error("gone"); } }) }, { ms: 50 })).kind, "unverified");
  const syncSend = await readBackend(ctx(null, async () => ({ send: () => { throw new Error("gone"); }, detach: async () => { detached++; } })), { ms: 50 });
  assert.deepEqual([syncSend.kind, syncSend.reason], ["unverified", "SystemInfo refused the request"]);
  // A session that opens only after its bound is still let go.
  let late = 0;
  const slow = await readBackend(ctx(null, () => new Promise((r) => setTimeout(() => r({ send: async () => ({}), detach: async () => { late++; } }), 80))), { ms: 20 });
  assert.match(slow.reason, /opened no session/);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(late, 1, "the late session is detached");
  assert.deepEqual(Object.keys(GRAPHICS).sort(), ["engineKeys", "kind", "renderer", "requested", "status", "switches"]);
});

test("a profile's backend reaches the launch through the plan; config.json's pairbrowse.graphics is the default's", () => {
  const record = JSON.parse(readFileSync(new URL("./fixtures/profiles/record-1.json", import.meta.url), "utf8"));
  const p = (backend) => ({ ...structuredClone(record), display: { colorScheme: null, reducedMotion: null }, graphics: { backend, require: null } });
  const linux = toLaunch(p("software"), { browserKind: "pairbrowse", platform: "linux" });
  assert.equal(linux.problem, null, linux.problem);
  assert.ok(linux.switches.includes(SOFTWARE_SWITCH));
  for (const s of linux.switches) assert.ok(SWITCHES.includes(switchName(s, "linux")), s);
  assert.match(toLaunch(p("software"), { browserKind: "pairbrowse", platform: "darwin" }).problem, /graphics\.backend \(graphics\.backend: software is not available on macOS with this build\)/);
  assert.match(toLaunch({ ...p("software"), browser: { kind: "pairbrowse-open" }, screen: null, persona: { source: "seed", seed: null }, locale: { languages: null, timezone: null, source: "system" } }, { browserKind: "pairbrowse-open", platform: "linux" }).problem, /only the native PairBrowse build can do/);
  assert.ok(!toLaunch(p("auto"), { browserKind: "pairbrowse", platform: "linux" }).switches.some((s) => /use-angle|disable-gpu/.test(s)));
  // config.json's browserArgs reach the plan: a renderer switch the backend contradicts refuses.
  assert.match(toLaunch(p("software"), { browserKind: "pairbrowse", platform: "linux", userArgs: ["--use-angle=gl"] }).problem, /software graphics \(graphics\.backend: software\) but browserArgs picks another renderer \(--use-angle\)/);
  assert.equal(toLaunch(p("software"), { browserKind: "pairbrowse", platform: "linux", userArgs: ["--use-angle=swiftshader"] }).problem, null);
  // The default profile: pairbrowse.graphics on the native build; --disable-gpu stays in browserArgs as written.
  assert.equal(readConfig({ browser: "pairbrowse", pairbrowse: { graphics: "software" } }, { platform: "linux" }).settings.graphics.backend, "software");
  const kept = readConfig({ browser: "pairbrowse", browserArgs: ["--disable-gpu"] }, { platform: "linux" });
  assert.equal(kept.settings.graphics.backend, "auto");
  assert.ok(kept.items.some((i) => i.field === "browserArgs" && /--disable-gpu is kept in browserArgs as written/.test(i.reason)));
  const odd = readConfig({ browser: "pairbrowse", pairbrowse: { graphics: "metal" } }, { platform: "linux" });
  assert.equal(odd.settings.graphics.backend, "auto");
  assert.ok(odd.items.some((i) => i.field === "pairbrowse.graphics" && i.severity === "warning" && !i.reason.includes("metal")));
  assert.equal(readConfig({ browser: "pairbrowse-open", pairbrowse: { graphics: "software" } }, { platform: "linux" }).settings.graphics.backend, "auto", "the open build reads no pairbrowse block");
});
