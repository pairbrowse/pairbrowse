// The graphics probe (spec server-mode E4; scripts/native/probe.mjs) with no browser: a stand-in
// probe browser answers the page parts from spike E-S1's fixtures (test/fixtures/probe-*.json,
// systeminfo-*.json), so the record probeLaunch makes is checked part by part (WebGL vendor,
// extensions and limits; WebGPU unavailable, fallback and full; the canvas verdicts; fonts; media;
// the sandbox page), and against what validate() reads. Every step is bounded: a page or start that
// never answers costs its bound, the probe browser is closed and its folder removed, and the
// helper's SANDBOX and GRAPHICS state is put back.
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeLaunch, runProbe, probeRecord, probeOptions, runsEmulated, graphicsStep, readSandboxPage, boundedStep, launchWithin, localSite, PROBE_PARTS, PROBE_FONTS, CONTROL_FONTS, SANDBOX_PAGE } from "../scripts/native/probe.mjs";
import { GRAPHICS, runtimeKey } from "../scripts/native/graphics.mjs";
import { parseSystemInfo } from "../scripts/native/backend.mjs";
import { validate } from "../scripts/native/validate.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const BUILD = "150.0.7871.114";
const PACK = "a".repeat(64);
const AT = new Date("2026-10-21T10:00:00Z");
const made = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "pb-probe-")); made.push(d); return d; };
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

// The page's answers for one fixture, per part, as the probe page gives them.
function answers(probeName, { canvas = "c1:57600", other = canvas, again = canvas, fonts = { missing: [], controlFound: [] } } = {}) {
  const f = fixture(probeName).probe;
  const { deviceWithReportedLimits, ...webgpu } = f.webgpu;
  const [width, height, colorDepth] = f.navigator.screen;
  return {
    sandbox: fixture(probeName).sandbox,
    parts: {
      webgl: { ...f.webgl, scene: "s1:16384" }, webgl2: f.webgl2,
      webgpu: f.webgpu.available ? { ...webgpu, requestDevice: deviceWithReportedLimits } : webgpu,
      canvas: { first: canvas, second: canvas },
      fonts: (extra) => ({ checked: extra.list.length, ...fonts }),
      screen: { width, height, availWidth: width, availHeight: height, colorDepth, devicePixelRatio: f.navigator.dpr },
      media: { 'video/mp4; codecs="avc1.42E01E"': "probably", 'smooth video/mp4; codecs="avc1.42E01E"': true },
      locale: { timezone: "Europe/Berlin", languages: ["de-DE", "de"] },
      navigator: { userAgent: f.navigator.userAgent, platform: f.navigator.platform, hardwareConcurrency: f.navigator.hardwareConcurrency, deviceMemory: 8 },
    },
    other: { webgl: { ...f.webgl, scene: "s1:16384" }, canvas: { first: other, second: other } },
    again: { canvas: { first: again, second: again } },
  };
}

// A stand-in browser for probeLaunch: each start a context whose browser answers SystemInfo from
// a fixture and whose tab answers the page parts (the first start on 127.0.0.1, then localhost and
// the sandbox page; the second start its canvas). hang: the parts that never answer.
function standIn(page, systemInfoName, { hang = [], onStart = () => {}, gotoFails = false } = {}) {
  const log = { starts: [], closed: 0, urls: [], asked: [] };
  const launch = async (directory) => {
    log.starts.push(directory);
    const start = log.starts.length;
    onStart(start);
    let url = "";
    const tab = {
      goto: async (u) => { if (gotoFails) throw new Error("net::ERR_CONNECTION_REFUSED"); url = u; log.urls.push(u); },
      evaluate: async (fn, args) => {
        if (!args) return url === SANDBOX_PAGE ? (Array.isArray(page.sandbox.page) ? page.sandbox.page.join("\n") : "") : null;
        const [part, , extra] = args;
        log.asked.push(`${start}:${part}`);
        if (hang.includes(part)) return new Promise(() => {});
        const set = start > 1 ? page.again : url.includes("localhost") ? page.other : page.parts;
        const v = set[part];
        return typeof v === "function" ? v(extra) : structuredClone(v);
      },
    };
    return {
      pages: () => [tab],
      browser: () => ({ newBrowserCDPSession: async () => ({ send: async () => fixture(`systeminfo-${systemInfoName}`).systemInfo, detach: async () => {} }) }),
      close: async () => { log.closed++; },
    };
  };
  return { launch, log };
}

const linux = (extra = {}) => ({ build: BUILD, pack: PACK, platform: "linux", arch: "x64", display: "xvfb", emulated: true, now: () => AT, stepMs: 400, launchMs: 400, backendMs: 200, ...extra });

test("probe results parsed: WebGL vendor, extensions and limits; WebGPU unavailable; the Linux sandbox page; a record validate reads", async () => {
  const directory = dir();
  const { launch, log } = standIn(answers("probe-linux-llvmpipe-real"), "linux-xvfb-llvmpipe");
  const m = await probeLaunch({ launch, directory, ...linux() });
  assert.equal(log.starts.length, 2, "started twice");
  assert.equal(log.starts[0], log.starts[1], "on one throwaway folder");
  assert.ok(log.starts[0].startsWith(join(directory, ".graphics-probe-")));
  assert.deepEqual(readdirSync(directory), [], "the folder removed after");
  assert.equal(log.closed, 2);
  assert.match(log.urls[0], /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.match(log.urls[1], /^http:\/\/localhost:\d+\/$/);
  assert.equal(log.urls[2], SANDBOX_PAGE);
  assert.deepEqual(log.asked.filter((a) => a.startsWith("1:")).slice(0, PROBE_PARTS.length), PROBE_PARTS.map((p) => `1:${p}`));

  assert.equal(m.at, AT.toISOString());
  assert.deepEqual(m.runtime, { platform: "linux", arch: "x64", display: "xvfb", emulated: true, sandbox: { on: null, page: fixture("probe-linux-llvmpipe-real").sandbox.page } });
  const backend = parseSystemInfo(fixture("systeminfo-linux-xvfb-llvmpipe").systemInfo);
  assert.equal(m.backend.kind, "software");
  assert.match(m.backend.renderer, /llvmpipe/);
  assert.equal(m.runtimeKey, runtimeKey({ build: BUILD, pack: PACK, platform: "linux", arch: "x64", display: "xvfb", backend, switches: [] }));
  assert.equal(m.webgl.unmaskedVendor, "Google Inc. (Mesa/X.org)");
  assert.match(m.webgl.unmaskedRenderer, /llvmpipe/);
  assert.equal(m.webgl.extensions, 35);
  assert.equal(m.webgl.maxTextureSize, 16384);
  assert.equal(m.webgl.sameOrigins, true);
  assert.equal(m.webgl2.extensions, 32);
  assert.deepEqual({ available: m.webgpu.available, reason: m.webgpu.reason }, { available: false, reason: "requestAdapter returned null" });
  assert.deepEqual(m.canvas, { stable: true, repeat: true, noise: false });
  assert.deepEqual(m.fonts, { checked: PROBE_FONTS.linux.length, missing: [], controlFound: [] });
  assert.equal(m.media['video/mp4; codecs="avc1.42E01E"'], "probably");
  assert.deepEqual(m.locale, { timezone: "Europe/Berlin", languages: ["de-DE", "de"] });
  assert.equal(m.screen.width, 1366);

  const entry = validate({ requested: { graphics: { backend: "auto" }, switches: [] }, derived: { build: BUILD, pack: PACK, runtimeKey: m.runtimeKey, platform: "linux" }, measured: m });
  assert.equal(entry.runtimeKey, m.runtimeKey, "kept as this runtime's evidence");
  const item = (rule) => entry.items.find((i) => i.rule === rule);
  assert.equal(item("webgl.strings-vs-backend").status, "matched", "the real strings name the software backend");
  assert.equal(item("canvas.repeat").status, "matched");
  assert.equal(item("sandbox.on").status, "unverified", "no sandbox state given: never assumed on");
});

test("the Linux persona of section 13.1 shows up: hardware strings over a software backend", async () => {
  const { launch } = standIn(answers("probe-linux-llvmpipe-persona"), "linux-xvfb-llvmpipe");
  const m = await probeLaunch({ launch, directory: dir(), ...linux({ sandbox: { on: true } }) });
  const entry = validate({ requested: { graphics: { backend: "auto" } }, derived: { build: BUILD, pack: PACK, runtimeKey: m.runtimeKey, platform: "linux" }, measured: m });
  assert.equal(entry.items.find((i) => i.rule === "webgl.strings-vs-backend").status, "mismatch");
  assert.equal(entry.items.find((i) => i.rule === "sandbox.on").status, "matched", "on, with the namespace layer (seccomp-BPF not required under emulation)");
  assert.equal(entry.status, "failed");
});

test("WebGPU: a fallback adapter on Linux, a full adapter on macOS whose reported limits fail requestDevice", async () => {
  const fallback = await probeLaunch({ launch: standIn(answers("probe-linux-webgpu-fallback-real"), "linux-xvfb-swiftshader").launch, directory: dir(), ...linux() });
  assert.equal(fallback.webgpu.available, true);
  assert.equal(fallback.webgpu.isFallbackAdapter, true);
  assert.deepEqual(fallback.webgpu.compute, { ok: true, error: null });
  assert.equal(graphicsStep(fallback), "graphics: software, WebGL 2, WebGPU fallback adapter");

  const mac = await probeLaunch({ launch: standIn(answers("probe-macos-metal"), "macos-metal").launch, directory: dir(), ...linux({ platform: "darwin", arch: "arm64", display: "native", emulated: false }) });
  assert.equal(mac.runtime.sandbox.page, "not on macOS", "the macOS build has no sandbox page");
  assert.equal(mac.backend.kind, "hardware");
  assert.equal(mac.webgpu.vendor, "apple");
  assert.equal(mac.webgpu.isFallbackAdapter, false);
  assert.ok(mac.webgpu.features.includes("shader-f16"));
  assert.equal(mac.webgpu.limits.maxStorageBuffersPerShaderStage, 16);
  assert.equal(mac.webgpu.requestDevice.ok, false);
  assert.match(mac.webgpu.requestDevice.error, /maxStorageBuffersPerShaderStage|supported limit/);
  assert.equal(graphicsStep(mac), "graphics: hardware, WebGL 2, WebGPU adapter");
});

test("canvas verdicts: per-site noise between origins, a scene that differs across starts, one unstable in a page", () => {
  const first = { parts: { canvas: { first: "a", second: "a" } } };
  const record = (other, again) => probeRecord({ at: AT.toISOString(), key: "k", pack: PACK, runtime: {}, backend: null, first, other, again }).canvas;
  assert.deepEqual(record({ parts: { canvas: { first: "b", second: "b" } } }, { parts: { canvas: { first: "a", second: "a" } } }), { stable: true, repeat: true, noise: true });
  assert.deepEqual(record({ parts: { canvas: { first: "a", second: "a" } } }, { parts: { canvas: { first: "z", second: "z" } } }), { stable: true, repeat: false, noise: false });
  assert.deepEqual(record({ parts: { canvas: { first: "a", second: "x" } } }, null), { stable: false, repeat: null, noise: false });
  assert.equal(probeRecord({ first: { parts: { canvas: { unanswered: true } } } }).canvas, null, "no scene: not measured");
  // A part the page didn't answer, or that threw, is left out: the rules then say so.
  const r = probeRecord({ first: { parts: { webgl: { unanswered: true }, webgl2: { error: "x" }, fonts: { checked: 3, missing: ["A"], controlFound: [] } } } });
  assert.equal(r.webgl, null);
  assert.equal(r.webgl2, null);
  assert.deepEqual(r.fonts, { checked: 3, missing: ["A"], controlFound: [] });
});

test("fonts: the persona list and the control list go to the page cut to family names; a control font found is reported", async () => {
  let given = null;
  const page = { evaluate: async (fn, [part, , extra]) => { if (part === "fonts") { given = extra; return { checked: extra.list.length, missing: ["Avenir"], controlFound: [extra.control[0]] }; } return {}; } };
  const { parts } = await runProbe(page, { parts: ["fonts"], fonts: ["Helvetica", "Avenir", 'Bad"; font: x', 7], stepMs: 200 });
  assert.deepEqual(given, { list: ["Helvetica", "Avenir"], control: [...CONTROL_FONTS] });
  assert.deepEqual(parts.fonts, { checked: 2, missing: ["Avenir"], controlFound: [CONTROL_FONTS[0]] });
});

test("a page that stops answering costs one bound: the later parts are never asked, the browser is closed, nothing is left", async () => {
  const directory = dir();
  const { launch, log } = standIn(answers("probe-linux-llvmpipe-real"), "linux-xvfb-llvmpipe", { hang: ["webgpu"] });
  const at = Date.now();
  const lines = [];
  const m = await probeLaunch({ launch, directory, ...linux({ log: (l) => lines.push(l) }) });
  assert.ok(Date.now() - at < 3000, "bounded");
  assert.deepEqual(log.asked, ["1:webgl", "1:webgl2", "1:webgpu"], "nothing asked after the part that hung");
  assert.equal(log.starts.length, 1, "no second start for a page that hung");
  assert.equal(log.closed, 1);
  assert.deepEqual(readdirSync(directory), []);
  assert.equal(m.webgpu, null);
  assert.equal(m.canvas, null);
  assert.equal(m.runtime.sandbox.page, "not shown");
  assert.ok(lines.some((l) => /stopped answering/.test(l)));
  const entry = validate({ requested: {}, derived: { build: BUILD, pack: PACK, runtimeKey: m.runtimeKey, platform: "linux" }, measured: m });
  assert.equal(entry.items.find((i) => i.rule === "canvas.stable").status, "unverified");
});

test("a start that never answers fails the probe in its bound, and the late browser is closed when it comes", async () => {
  const directory = dir();
  let late = null, closed = false;
  const launch = () => new Promise((resolve) => { late = () => resolve({ pages: () => [], close: async () => { closed = true; } }); });
  await assert.rejects(probeLaunch({ launch, directory, ...linux({ launchMs: 100 }) }), /PairBrowse graphics probe failed: the probe browser's start took over 0\.1 s/);
  assert.deepEqual(readdirSync(directory), []);
  late();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(closed, true);
});

test("a probe page that doesn't load fails the probe; the browser is closed", async () => {
  const { launch, log } = standIn(answers("probe-linux-llvmpipe-real"), "linux-xvfb-llvmpipe", { gotoFails: true });
  await assert.rejects(probeLaunch({ launch, directory: dir(), ...linux() }), /graphics probe failed: net::ERR_CONNECTION_REFUSED/);
  assert.equal(log.closed, 1);
});

test("a second start that fails leaves only the canvas across starts unmeasured", async () => {
  const lines = [];
  const { launch } = standIn(answers("probe-linux-llvmpipe-real"), "linux-xvfb-llvmpipe", { onStart: (n) => { if (n === 2) throw new Error("no second start"); } });
  const m = await probeLaunch({ launch, directory: dir(), ...linux({ log: (l) => lines.push(l) }) });
  assert.equal(m.canvas.repeat, null);
  assert.equal(m.canvas.stable, true);
  assert.ok(lines.some((l) => /second start failed \(no second start\)/.test(l)));
});

test("the probe's start sets SANDBOX and GRAPHICS as any launch does; the probe reads them and puts both back", async () => {
  const sandbox = { on: true, reason: null, refused: null, blocked: null, required: null };
  const live = { ...GRAPHICS };
  Object.assign(GRAPHICS, { requested: "auto", switches: ["--live"], engineKeys: ["disableGpuFingerprint"], kind: "software", renderer: "llvmpipe", status: "validated" });
  const before = structuredClone(GRAPHICS);
  const { launch } = standIn(answers("probe-linux-swiftshader-real"), "linux-xvfb-swiftshader", {
    onStart: () => { Object.assign(sandbox, { on: true, required: "in server mode" }); Object.assign(GRAPHICS, { switches: ["--use-angle=swiftshader"], kind: "unverified", status: "unverified" }); },
  });
  try {
    const m = await probeLaunch({ launch, directory: dir(), ...linux({ sandbox }) });
    assert.equal(m.runtime.sandbox.on, true);
    const backend = parseSystemInfo(fixture("systeminfo-linux-xvfb-swiftshader").systemInfo);
    assert.equal(m.runtimeKey, runtimeKey({ build: BUILD, pack: PACK, platform: "linux", arch: "x64", display: "xvfb", backend, switches: ["--use-angle=swiftshader"] }), "the probe launch's backend switches count");
    assert.deepEqual(GRAPHICS, before, "the live browser's graphics state is back");
    assert.equal(sandbox.required, null, "and its sandbox state");
  } finally { Object.assign(GRAPHICS, live); }
});

test("no runtime key (no build named) and no probe outside macOS and Linux are refusals", async () => {
  const { launch } = standIn(answers("probe-linux-llvmpipe-real"), "linux-xvfb-llvmpipe");
  await assert.rejects(probeLaunch({ launch, directory: dir(), ...linux({ build: undefined }) }), /no runtime key or runtime/);
  await assert.rejects(probeLaunch({ launch, directory: dir(), ...linux({ platform: "win32" }) }), /no probe on win32/);
});

test("the sandbox page: its lines, not shown, or timed out", async () => {
  const page = (body, { goto = async () => {} } = {}) => ({ goto, evaluate: async () => body });
  assert.deepEqual(await readSandboxPage(page("Sandbox Status\n  Layer 1 Sandbox\tNamespace \n\nPID namespaces\tYes")), ["Sandbox Status", "Layer 1 Sandbox\tNamespace", "PID namespaces\tYes"]);
  assert.equal(await readSandboxPage(page("", { goto: async () => { throw new Error("blocked"); } })), "not shown");
  assert.equal(await readSandboxPage({ goto: async () => {}, evaluate: () => new Promise(() => {}) }, { stepMs: 50 }), "timeout");
});

test("probe options: hidden on macOS, headed on Linux", () => {
  assert.equal(probeOptions({ args: ["--x"], headless: false }, "darwin").headless, true);
  assert.deepEqual(probeOptions({ args: ["--x"], headless: true }, "linux"), { args: ["--x"], headless: false });
});

test("emulation: an x64 build on an ARM kernel; anything unread counts as not emulated", () => {
  assert.equal(runsEmulated({ platform: "linux", arch: "x64", cpuinfo: "processor\t: 0\nBogoMIPS\t: 48.00\nCPU implementer\t: 0x61\nCPU architecture: 8\n" }), true);
  assert.equal(runsEmulated({ platform: "linux", arch: "x64", cpuinfo: "processor\t: 0\nvendor_id\t: GenuineIntel\nflags\t\t: fpu vme sse2\n" }), false);
  // Rosetta under Docker Desktop or OrbStack shows an x86 CPU of its own vendor (measured in the A13 container).
  assert.equal(runsEmulated({ platform: "linux", arch: "x64", cpuinfo: "processor\t: 0\nvendor_id\t: VirtualApple\ncpu family\t: 6\nmodel name\t: VirtualApple @ 2.50GHz\n" }), true);
  assert.equal(runsEmulated({ platform: "linux", arch: "arm64", cpuinfo: "CPU implementer\t: 0x61\n" }), false);
  assert.equal(runsEmulated({ platform: "darwin", arch: "x64", cpuinfo: "CPU implementer\t: 0x61\n" }), false);
  assert.equal(runsEmulated({ platform: "linux", arch: "x64", cpuinfo: null }), false);
});

test("the self-check's line names the kind, WebGL's level and WebGPU's adapter, never the GPU", () => {
  const llvm = { backend: { kind: "software", renderer: "llvmpipe (LLVM 15.0.6 128 bits)", vendor: 4318 }, webgl: { available: true }, webgl2: { available: true }, webgpu: { available: false } };
  assert.equal(graphicsStep(llvm), "graphics: software, WebGL 2, WebGPU unavailable");
  assert.equal(graphicsStep({ ...llvm, webgl2: { available: false } }), "graphics: software, WebGL 1, WebGPU unavailable");
  assert.equal(graphicsStep({ backend: { kind: "software" }, webgl: { available: false }, webgl2: null, webgpu: null }), "graphics: software, no WebGL, WebGPU unavailable");
  assert.equal(graphicsStep(null), "graphics: unverified, no WebGL, WebGPU unavailable");
  assert.doesNotMatch(graphicsStep(llvm), /llvmpipe|4318/);
});

test("the shared bounded steps: a step past its time names itself; a local site on loopback only", async () => {
  await assert.rejects(boundedStep(50)("the collector", new Promise(() => {})), /^Error: the collector took over 0\.05 s$/);
  assert.equal(await boundedStep(50)("x", Promise.resolve(7)), 7);
  await assert.rejects(launchWithin(50, "a start", () => { throw new Error("no browser"); }), /no browser/);
  const site = await localSite();
  try {
    assert.match(site.origin, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const body = await (await fetch(site.origin)).text();
    assert.match(body, /PairBrowse graphics probe/);
  } finally { await site.close(); }
});
