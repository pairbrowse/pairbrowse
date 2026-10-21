// The graphics probe (server-mode spec, Phase E, E4): what this computer's runtime really renders,
// measured in a throwaway browser and never in a tab of the person's browser. probeLaunch starts
// the native build the way the caller resolves it (the profile's options, launchOptions) on a
// temporary user-data folder inside the given directory: headless on macOS (the host capture's
// Metal path), headed on Linux on whatever screen the caller's options name (probeOptions): the
// private virtual screen on a server, the person's own desktop otherwise. It reads the browser
// process's backend (native/backend.mjs readBackend, E3), runs the probe page on a local server
// (127.0.0.1, then localhost), reads the engine's sandbox page on Linux, starts the browser a second
// time on the same folder for the canvas across launches, and answers the measurement in the one
// stored shape (native/validate.mjs measuredRecord), under this runtime's key (native/graphics.mjs
// runtimeKey). Its temporary folder and local server are gone after, whatever happened.
//
// Every step is bounded (boundedStep, launchWithin; the host capture in native-engine.mjs shares
// them): a page or browser that never answers costs its bound, and a part that answers nothing
// leaves the parts after it unasked. The probe's launch sets the helper's SANDBOX and GRAPHICS
// state as any launch does; probeLaunch puts both back after, so the live browser's stay.
//
// The record holds this computer's renderer and GPU IDs: it goes to the profile's 0600 file as
// evidence, never into a report or to joiners (graphicsStep's line names the kind only). Node's
// standard library only.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { within } from "../util.mjs";
import { readBackend, BACKEND_MS } from "./backend.mjs";
import { GRAPHICS, runtimeKey } from "./graphics.mjs";
import { measuredRecord } from "./validate.mjs";

// How long one step may take (a page part, a navigation), and a probe browser's start.
export const PROBE_STEP_MS = 30_000;
export const PROBE_LAUNCH_MS = 120_000;
// The engine's own sandbox status page (Linux builds; the macOS build has none).
export const SANDBOX_PAGE = "chrome://sandbox";
const SANDBOX_LINES = 30;
// The parts the probe page answers, in the order asked: WebGL first (a renderer that hangs shows
// there), the sandbox page after all of them.
export const PROBE_PARTS = Object.freeze(["webgl", "webgl2", "webgpu", "canvas", "fonts", "screen", "media", "locale", "navigator"]);
// Fonts every persona on this platform shows pages (fonts.available, a warning): on macOS the
// families the native build's persona keeps (measured: it hides others this Mac has, Menlo and
// Avenir among them), on Linux the families the engine's font set and the server image carry. The
// control list names fonts no computer has: one found means the page's font answers can't be
// trusted.
export const PROBE_FONTS = Object.freeze({
  macos: Object.freeze(["Helvetica", "Helvetica Neue", "Arial", "Times New Roman", "Courier New", "Georgia", "Verdana"]),
  linux: Object.freeze(["DejaVu Sans", "DejaVu Serif", "DejaVu Sans Mono", "Liberation Sans", "Liberation Serif", "Liberation Mono", "Noto Sans", "Noto Serif"]),
});
export const CONTROL_FONTS = Object.freeze(["PairBrowse Control Sans 7f3a", "Probe Missing Serif 19c2", "Zq Control Mono 4be1"]);
const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 -]{0,47}$/;
const RUNTIME_PLATFORMS = { darwin: "macos", linux: "linux" };

// One bounded step: the promise's value, or an error naming what took longer than stepMs.
export function boundedStep(stepMs) {
  return async (what, promise) => {
    const done = await within(stepMs, Promise.resolve(promise).then((value) => ({ value })));
    if (!done) throw new Error(`${what} took over ${stepMs / 1000} s`);
    return done.value;
  };
}

// A browser start (start(): its context) bounded by ms; one that comes back after its time is
// closed all the same, so no hidden browser outlives the step that gave up on it.
export async function launchWithin(ms, what, start) {
  let gaveUp = false;
  const launching = Promise.resolve().then(start);
  launching.then((late) => { if (gaveUp) Promise.resolve().then(() => late?.close?.()).catch(() => {}); }, () => {});
  try { return await boundedStep(ms)(what, launching); } catch (error) { gaveUp = true; throw error; }
}

// A local page on 127.0.0.1 (reached as localhost too): { origin, localhost, close() }.
export async function localSite(title = "PairBrowse graphics probe") {
  const server = createServer((_, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end(`<!doctype html><title>${title}</title>`); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}/`, localhost: `http://localhost:${port}/`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

// The launch options of a probe browser (E4): headless on macOS, where it still renders on the
// real GPU with Metal; headed on Linux, on the screen the options already name.
export const probeOptions = (options, platform = process.platform) => ({ ...options, headless: platform === "darwin" });

// An x64 build on an ARM kernel (a container under emulation on Apple Silicon): there the emulator
// refuses every seccomp filter, so sandbox.on doesn't require seccomp-BPF (native/validate.mjs).
// Read from the kernel's own CPU description: an ARM one (QEMU's user emulation shows the host's),
// or Rosetta's x86 one, whose vendor is VirtualApple (Docker Desktop and OrbStack on Apple Silicon;
// the engine's sandbox page then shows seccomp-BPF missing). Anything unread or unknown counts as
// not emulated, which keeps the stricter rule.
export function runsEmulated({ platform = process.platform, arch = process.arch, cpuinfo } = {}) {
  if (platform !== "linux" || arch !== "x64") return false;
  let text = cpuinfo;
  if (text === undefined) try { text = readFileSync("/proc/cpuinfo", "utf8"); } catch { return false; }
  return typeof text === "string" && (/^CPU implementer\s*:/m.test(text) || /^CPU architecture\s*:\s*8\b/m.test(text) || /^vendor_id\s*:\s*VirtualApple\b/m.test(text));
}

// The probe page's side, run in the page one part per call (a part that hangs costs only its own
// bound). Self-contained: the driver sends it to the page as source. Every await inside is
// bounded by awaitMs (a fifth of the step: WebGPU's four awaits fit in it); so is the call around
// it (runProbe).
async function probePart([part, awaitMs, extra]) {
  const bounded = (p) => Promise.race([p, new Promise((resolve) => setTimeout(() => resolve("timeout"), awaitMs))]);
  const message = (e) => String(e?.message || e);
  // FNV-1a over pixel bytes, with their count: one fixed scene's fingerprint.
  const hash = (bytes) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return `${h.toString(16).padStart(8, "0")}:${bytes.length}`;
  };
  function glScene(g) {
    try {
      const shader = (type, source) => { const s = g.createShader(type); g.shaderSource(s, source); g.compileShader(s); return s; };
      const program = g.createProgram();
      g.attachShader(program, shader(g.VERTEX_SHADER, "attribute vec2 p; varying vec2 v; void main() { v = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }"));
      g.attachShader(program, shader(g.FRAGMENT_SHADER, "precision mediump float; varying vec2 v; void main() { gl_FragColor = vec4(v.x, v.y, fract(sin(v.x * 12.9898 + v.y * 78.233) * 43758.5453), 1.0); }"));
      g.linkProgram(program);
      g.useProgram(program);
      g.bindBuffer(g.ARRAY_BUFFER, g.createBuffer());
      g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 0, 1]), g.STATIC_DRAW);
      const at = g.getAttribLocation(program, "p");
      g.enableVertexAttribArray(at);
      g.vertexAttribPointer(at, 2, g.FLOAT, false, 0, 0);
      g.clearColor(0.1, 0.2, 0.3, 1);
      g.clear(g.COLOR_BUFFER_BIT);
      g.drawArrays(g.TRIANGLES, 0, 3);
      const pixels = new Uint8Array(64 * 64 * 4);
      g.readPixels(0, 0, 64, 64, g.RGBA, g.UNSIGNED_BYTE, pixels);
      return hash(pixels);
    } catch { return null; }
  }
  function gl(kind) {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const g = canvas.getContext(kind, { preserveDrawingBuffer: true });
    if (!g) return { available: false, reason: `no ${kind} context` };
    const d = g.getExtension("WEBGL_debug_renderer_info");
    return {
      available: true, version: g.getParameter(g.VERSION),
      unmaskedVendor: d ? g.getParameter(d.UNMASKED_VENDOR_WEBGL) : null, unmaskedRenderer: d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : null,
      maxTextureSize: g.getParameter(g.MAX_TEXTURE_SIZE), maxRenderbufferSize: g.getParameter(g.MAX_RENDERBUFFER_SIZE),
      extensions: (g.getSupportedExtensions() || []).length, scene: glScene(g),
    };
  }
  async function webgpu() {
    if (!navigator.gpu) return { available: false, reason: "navigator.gpu undefined" };
    const adapter = await bounded(navigator.gpu.requestAdapter().catch((e) => message(e)));
    if (adapter === "timeout") return { available: false, reason: "requestAdapter timed out" };
    if (typeof adapter === "string") return { available: false, reason: adapter };
    if (!adapter) return { available: false, reason: "requestAdapter returned null" };
    const info = adapter.info || {};
    const limits = {};
    for (const k in adapter.limits) if (typeof adapter.limits[k] === "number") limits[k] = adapter.limits[k];
    const out = { available: true, vendor: info.vendor, architecture: info.architecture, isFallbackAdapter: info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null, features: [...adapter.features].sort(), limits };
    // A device with the limits the adapter reports: pages that ask for them must get one (E10).
    out.requestDevice = await bounded(adapter.requestDevice({ requiredLimits: limits }).then((d) => { d.destroy(); return "ok"; }, (e) => message(e)));
    const device = await bounded(adapter.requestDevice().catch((e) => message(e)));
    if (typeof device === "string") { out.compute = device; return out; }
    const run = async () => {
      const module = device.createShaderModule({ code: "@group(0) @binding(0) var<storage, read_write> v: array<u32>; @compute @workgroup_size(4) fn main(@builtin(global_invocation_id) i: vec3<u32>) { v[i.x] = v[i.x] * 2u; }" });
      const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
      const data = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      const read = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(data, 0, new Uint32Array([1, 2, 3, 4]));
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: data } }] }));
      pass.dispatchWorkgroups(1);
      pass.end();
      encoder.copyBufferToBuffer(data, 0, read, 0, 16);
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      return [...new Uint32Array(read.getMappedRange())].join(",");
    };
    out.compute = await bounded(run().catch((e) => message(e)));
    device.destroy();
    return out;
  }
  // A fixed 2D and text scene, drawn twice in this page.
  function canvasScene() {
    const c = document.createElement("canvas");
    c.width = 240;
    c.height = 60;
    const x = c.getContext("2d");
    if (!x) return null;
    const gradient = x.createLinearGradient(0, 0, 240, 0);
    gradient.addColorStop(0, "#f60");
    gradient.addColorStop(1, "#069");
    x.fillStyle = gradient;
    x.fillRect(0, 0, 240, 60);
    x.textBaseline = "top";
    x.font = "16px sans-serif";
    x.fillStyle = "rgba(102, 204, 0, 0.7)";
    x.fillText("PairBrowse probe éß 1.5", 4, 6);
    x.font = "italic 14px serif";
    x.fillStyle = "#123";
    x.fillText("Sphinx of black quartz", 8, 30);
    x.beginPath();
    x.arc(200, 30, 18, 0, Math.PI * 2);
    x.strokeStyle = "#fff";
    x.lineWidth = 3;
    x.stroke();
    return hash(x.getImageData(0, 0, 240, 60).data);
  }
  // A font is there when text in it measures other than in each generic family alone.
  function fonts({ list, control }) {
    const x = document.createElement("canvas").getContext("2d");
    const sample = "mmmmmmmmmmlli1WQ@#éß";
    const bases = ["monospace", "serif", "sans-serif"];
    const width = (family) => { x.font = `72px ${family}`; return x.measureText(sample).width; };
    const base = bases.map(width);
    const has = (name) => bases.some((b, i) => width(`"${name}", ${b}`) !== base[i]);
    return { checked: list.length, missing: list.filter((n) => !has(n)), controlFound: control.filter(has) };
  }
  async function media() {
    const out = {};
    const video = document.createElement("video");
    const types = ['video/mp4; codecs="avc1.42E01E"', 'video/webm; codecs="vp9"', 'video/mp4; codecs="av01.0.05M.08"', 'video/mp4; codecs="hev1.1.6.L93.B0"', 'audio/mp4; codecs="mp4a.40.2"', 'audio/webm; codecs="opus"'];
    for (const t of types) out[t] = video.canPlayType(t);
    if (!navigator.mediaCapabilities) return out;
    for (const t of types.slice(0, 3)) {
      const info = await bounded(navigator.mediaCapabilities.decodingInfo({ type: "file", video: { contentType: t, width: 1920, height: 1080, bitrate: 2000000, framerate: 30 } }).catch(() => null));
      if (!info || info === "timeout") continue;
      out[`smooth ${t}`] = !!info.smooth;
      out[`efficient ${t}`] = !!info.powerEfficient;
    }
    return out;
  }
  if (part === "webgl") return gl("webgl");
  if (part === "webgl2") return gl("webgl2");
  if (part === "webgpu") return webgpu();
  if (part === "canvas") return { first: canvasScene(), second: canvasScene() };
  if (part === "fonts") return fonts(extra);
  if (part === "media") return media();
  if (part === "screen") return { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth, devicePixelRatio: devicePixelRatio };
  if (part === "locale") return { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, languages: [...(navigator.languages || [])] };
  if (part === "navigator") return { userAgent: navigator.userAgent, platform: navigator.platform, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory ?? null };
  return { error: `no part ${part}` };
}

// The probe page's answers on the page as it is now: { parts: { name: answer }, hung }. A part that
// throws answers { error }; one that answers nothing within its bound { unanswered: true }, and
// then the page answered nothing more, so no later part is asked (hung). fonts: the names to look
// for (cut to plain family names), control: names no computer has.
export async function runProbe(page, { parts = PROBE_PARTS, stepMs = PROBE_STEP_MS, fonts = [], control = CONTROL_FONTS } = {}) {
  const extra = { list: fonts.filter((n) => typeof n === "string" && FONT_NAME.test(n)).slice(0, 24), control: control.filter((n) => typeof n === "string" && FONT_NAME.test(n)).slice(0, 6) };
  const out = {};
  let hung = false;
  for (const part of parts) {
    if (hung) { out[part] = { unanswered: true, skipped: "the page answered nothing before" }; continue; }
    const asked = Promise.resolve().then(() => page.evaluate(probePart, [part, Math.max(1, Math.floor(stepMs / 5)), part === "fonts" ? extra : null])).catch((e) => ({ error: String(e?.message || e).split("\n")[0].slice(0, 160) }));
    out[part] = await within(stepMs, asked) ?? { unanswered: true };
    hung = out[part].unanswered === true;
  }
  return { parts: out, hung };
}

// The engine's sandbox page's lines (Linux): its text, or "timeout" or "not shown".
export async function readSandboxPage(page, { stepMs = PROBE_STEP_MS } = {}) {
  const NOT_SHOWN = {};
  const text = await within(stepMs, Promise.resolve().then(() => page.goto(SANDBOX_PAGE))
    .then(() => within(stepMs, page.evaluate(() => document.body?.innerText ?? "")), () => NOT_SHOWN).catch(() => NOT_SHOWN));
  if (text === NOT_SHOWN) return "not shown";
  if (typeof text !== "string") return "timeout";
  return text.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, SANDBOX_LINES);
}

const answered = (v) => !!v && typeof v === "object" && !v.unanswered && !v.error;
const same = (a, b) => (typeof a === "string" && typeof b === "string" ? a === b : null);

// The probe's answers as the record measuredRecord reads (E8): canvas.stable (one scene drew the
// same pixels twice in a page, on each origin), canvas.repeat (the same on the second launch),
// canvas.noise (the scene differs between the two origins: per-site noise over its pixels),
// webgl.sameOrigins (the WebGL scene the same on both).
export function probeRecord({ at, key, pack, runtime, backend, first, other = null, again = null }) {
  const p = first?.parts ?? {}, o = other?.parts ?? {};
  const scene = (c) => (answered(c) && typeof c.first === "string" ? c : null);
  const c1 = scene(p.canvas), c2 = scene(o.canvas), c3 = scene(again?.parts?.canvas);
  const stableIn = (c) => (c ? c.first === c.second : null);
  const stable = c1 ? (c2 ? stableIn(c1) && stableIn(c2) : stableIn(c1)) : null;
  // A part the page didn't answer is left out (null): the rules then say so, or count it failed
  // where the launch passed a switch for it.
  const part = (v) => (answered(v) ? v : null);
  const webgl = answered(p.webgl) ? { ...p.webgl, sameOrigins: answered(o.webgl) ? same(p.webgl.scene, o.webgl.scene) : null } : null;
  return {
    at, runtimeKey: key, pack, runtime, backend,
    webgl, webgl2: part(p.webgl2), webgpu: part(p.webgpu),
    canvas: c1 ? { stable, repeat: c3 ? same(c1.first, c3.first) : null, noise: c2 ? c1.first !== c2.first : null } : null,
    fonts: part(p.fonts), media: part(p.media), screen: part(p.screen), locale: part(p.locale), navigator: part(p.navigator),
  };
}

// Measures this runtime once (E4). launch(directory): starts the probe browser on that user-data
// folder with the resolved options (probeOptions) and answers its context; it is called twice on
// one temporary folder inside directory. build: the native build's version; pack: the engine
// pack's SHA-256; platform and arch: this computer's; display: "xvfb" on the helper's virtual
// screen, else "native"; emulated: runsEmulated(); sandbox: the helper's SANDBOX state (read after
// the launch, put back after). launches: 2 (1 leaves canvas.repeat unmeasured). signal: an
// AbortSignal for a caller that gives up first: the probe browser is closed at once, no further
// start or step is made, and the probe throws once its cleanup (folder, server, state put back) is
// done; a start in flight then ends by its own bound. Answers the measurement (measuredRecord's
// shape). Throws, the probe browser closed and its folder removed, when the browser doesn't start,
// the page doesn't load, the record has no runtime key, or it was stopped.
export async function probeLaunch({ launch, directory, build, pack = null, platform = process.platform, arch = process.arch, display = "native", emulated = runsEmulated({ platform, arch }), sandbox = null, fonts = null, launches = 2, stepMs = PROBE_STEP_MS, launchMs = PROBE_LAUNCH_MS, backendMs = BACKEND_MS, log = () => {}, now = () => new Date(), signal = null } = {}) {
  const where = RUNTIME_PLATFORMS[platform];
  if (!where) throw new Error(`PairBrowse graphics probe: no probe on ${platform}`);
  if (typeof launch !== "function") throw new Error("PairBrowse graphics probe: no launch given");
  const step = boundedStep(stepMs);
  const before = { sandbox: sandbox ? { ...sandbox } : null, graphics: { ...GRAPHICS, switches: [...GRAPHICS.switches], engineKeys: [...GRAPHICS.engineKeys] } };
  const list = Array.isArray(fonts) ? fonts : PROBE_FONTS[where];
  let scratch = null, site = null, ctx = null, closing = Promise.resolve();
  // Every close waits for any one already under way (a stop's), so the folder outlives the browser.
  const close = async () => {
    const c = ctx;
    ctx = null;
    if (c) closing = closing.then(() => within(10_000, Promise.resolve().then(() => c.close()).catch(() => {})));
    await closing;
  };
  // Stopped: nothing more is started or asked; closing the browser ends the step in progress.
  const halt = () => { if (signal?.aborted) throw new Error("stopped: the caller's time was up"); };
  const onStop = () => { close(); };
  signal?.addEventListener("abort", onStop, { once: true });
  const open = async (what) => {
    halt();
    const c = await launchWithin(launchMs, what, () => launch(scratch));
    ctx = c;
    halt(); // a start that came back after the stop: closed in the finally below
    return c.pages?.()[0] ?? await step("the probe tab", Promise.resolve().then(() => c.newPage()));
  };
  try {
    halt();
    scratch = mkdtempSync(join(directory, ".graphics-probe-"));
    site = await localSite();
    const page = await open("the probe browser's start");
    const sandboxOn = sandbox ? sandbox.on : null;
    const switches = [...GRAPHICS.switches];
    const backend = await readBackend(ctx, { ms: backendMs });
    await step("the probe page", page.goto(site.origin, { waitUntil: "domcontentloaded" }));
    const first = await runProbe(page, { stepMs, fonts: list });
    if (first.hung) log("graphics probe: the page stopped answering; the parts after it are unmeasured");
    let other = null, sandboxPage = where === "macos" ? "not on macOS" : "not shown";
    if (!first.hung) {
      const moved = await within(stepMs, Promise.resolve().then(() => page.goto(site.localhost, { waitUntil: "domcontentloaded" })).then(() => true, () => false));
      if (moved) other = await runProbe(page, { parts: ["webgl", "canvas"], stepMs });
      if (where === "linux") sandboxPage = await readSandboxPage(page, { stepMs });
    }
    await close();
    let again = null;
    if (launches > 1 && !first.hung && first.parts.canvas?.first) {
      try {
        const page2 = await open("the probe browser's second start");
        await step("the probe page", page2.goto(site.origin, { waitUntil: "domcontentloaded" }));
        again = await runProbe(page2, { parts: ["canvas"], stepMs });
      } catch (error) {
        log(`graphics probe: the second start failed (${error.message}); the canvas across launches is unmeasured`);
      } finally { await close(); }
    }
    halt();
    const key = runtimeKey({ build, pack, platform: where, arch, display, backend, switches });
    const runtime = { platform: where, arch, display, emulated: !!emulated, sandbox: { on: sandboxOn, page: sandboxPage } };
    const measured = measuredRecord(probeRecord({ at: now().toISOString(), key, pack, runtime, backend, first, other, again }));
    if (!measured) throw new Error(`the measurement has no runtime key or runtime (build ${build || "not named"}, ${where} ${arch}, display ${display})`);
    return measured;
  } catch (error) {
    throw new Error(`PairBrowse graphics probe failed: ${error.message}`, { cause: error });
  } finally {
    signal?.removeEventListener("abort", onStop);
    await close();
    if (site) await within(5000, site.close());
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    if (sandbox && before.sandbox) Object.assign(sandbox, before.sandbox);
    Object.assign(GRAPHICS, before.graphics);
  }
}

// The self-check's line for a measurement (spec Phase E design, native/check.mjs): the backend's
// kind, WebGL's level and WebGPU's adapter, never the GPU's name or IDs.
export function graphicsStep(measured) {
  const kind = measured?.backend?.kind || "unverified";
  const webgl = measured?.webgl2?.available ? "WebGL 2" : measured?.webgl?.available ? "WebGL 1" : "no WebGL";
  const g = measured?.webgpu;
  const webgpu = g?.available ? (g.isFallbackAdapter ? "WebGPU fallback adapter" : "WebGPU adapter") : "WebGPU unavailable";
  return `graphics: ${kind}, ${webgl}, ${webgpu}`;
}
