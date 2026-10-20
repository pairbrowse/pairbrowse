// Spike E-S1 (server-mode spec, Phase E), the side that runs on the measured machine: in the A13
// container (graphics-spike.test.mjs starts it there) or on this Mac. For each candidate set of
// graphics switches it launches the native build the way the helper does (engine.mjs launchEngine
// with launchOptions, on a throwaway profile, the sandbox required on a server), reads
// SystemInfo.getInfo over a browser-level session on the driver's pipe (no TCP port), and probes a
// local page: WebGL and WebGL2 strings and limits, WebGPU's adapter, a device with the reported
// limits and one compute round trip. Each result is written, scrubbed (scrub.mjs), to PB_OUT as
// <platform>-<candidate>.json; one summary line per candidate goes to stdout.
//
// PAIRBROWSE_HOME: this run's own home (never a person's). PB_RUNTIME: the pinned runtime, linked
// into it. PB_INSTALL=1 (the container): the pinned native build and engine pack are installed the
// way the helper installs them (native/install.mjs ensureNative: SHA-256, manifest, self-check);
// otherwise PB_EXECUTABLE is the native build and PB_ENGINE the engine pack to link.
// PB_CANDIDATES: a comma list to run only those.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.PAIRBROWSE_HOME;
if (!home) throw new Error("PAIRBROWSE_HOME must name this run's own home");
mkdirSync(home, { recursive: true, mode: 0o700 });
const link = (from, name) => { if (from && !existsSync(join(home, name))) symlinkSync(from, join(home, name), "dir"); };
link(process.env.PB_RUNTIME, "runtime");
link(process.env.PB_ENGINE, "engine");
writeFileSync(join(home, "config.json"), JSON.stringify({ browser: "pairbrowse" }));

const { paths, loadConfig } = await import("../../../scripts/paths.mjs");
const { launchOptions, prepareProfile } = await import("../../../scripts/browser.mjs");
const { engineConfig, shellOf } = await import("../../../scripts/browser/choice.mjs");
const { launchEngine, SANDBOX } = await import("../../../scripts/engine.mjs");
const { needsVirtualDisplay, screenGeometry, serverMode, startVirtualDisplay } = await import("../../../scripts/display.mjs");
const { loadBrowserDriver, patchrightNodeMinimum } = await import("../../../scripts/driver.mjs");
const { within } = await import("../../../scripts/util.mjs");
const { scrubSystemInfo, scrubProbe } = await import("./scrub.mjs");

const platform = process.platform === "darwin" ? "macos" : process.platform;
const STEP_MS = 30_000;
const log = (m) => process.stderr.write(`measure: ${m}\n`);

// The candidates (spec E2): the default path, the engine's software GL (SwiftShader through ANGLE,
// with and without the switch the driver adds and the engine pack ignores), Mesa through ANGLE's
// desktop GL (llvmpipe under Xvfb) and Vulkan (lavapipe), the GPU off, and WebGPU's paths.
const CANDIDATES = {
  linux: {
    auto: [],
    "disable-gpu": ["--disable-gpu"],
    swiftshader: ["--use-angle=swiftshader"],
    "swiftshader-unsafe": ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    "mesa-gl": ["--use-gl=angle", "--use-angle=gl"],
    "mesa-vulkan": ["--use-angle=vulkan", "--enable-features=Vulkan"],
    "webgpu-unsafe": ["--enable-unsafe-webgpu"],
    "webgpu-swiftshader": ["--enable-unsafe-webgpu", "--use-webgpu-adapter=swiftshader", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  },
  macos: {
    auto: [],
    "swiftshader-unsafe": ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    "disable-gpu": ["--disable-gpu"],
  },
};

// The page side, run in the probed page, one part per call (a context that hangs loses only its
// own part). Every await inside is bounded; so is the call around it.
async function probePage([part, stepMs]) {
  const bounded = (p) => Promise.race([p, new Promise((resolve) => setTimeout(() => resolve("timeout"), stepMs))]);
  const gl = (kind) => {
    const g = document.createElement("canvas").getContext(kind);
    if (!g) return { available: false };
    const d = g.getExtension("WEBGL_debug_renderer_info");
    return {
      available: true, vendor: g.getParameter(g.VENDOR), renderer: g.getParameter(g.RENDERER), version: g.getParameter(g.VERSION),
      unmaskedVendor: d ? g.getParameter(d.UNMASKED_VENDOR_WEBGL) : null, unmaskedRenderer: d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : null,
      maxTextureSize: g.getParameter(g.MAX_TEXTURE_SIZE), maxRenderbufferSize: g.getParameter(g.MAX_RENDERBUFFER_SIZE),
      extensions: (g.getSupportedExtensions() || []).length,
    };
  };
  async function webgpu() {
    if (!navigator.gpu) return { available: false, reason: "navigator.gpu undefined" };
    const adapter = await bounded(navigator.gpu.requestAdapter());
    if (adapter === "timeout") return { available: false, reason: "requestAdapter timed out" };
    if (!adapter) return { available: false, reason: "requestAdapter returned null" };
    const info = adapter.info || {};
    const limits = {};
    for (const k in adapter.limits) if (typeof adapter.limits[k] === "number") limits[k] = adapter.limits[k];
    const out = {
      available: true, vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
      isFallbackAdapter: info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null, features: [...adapter.features].sort(), limits,
    };
    const asked = await bounded(adapter.requestDevice({ requiredLimits: limits }).then(() => "ok", (e) => String(e?.message || e)));
    out.deviceWithReportedLimits = asked;
    const device = await bounded(adapter.requestDevice().catch((e) => String(e?.message || e)));
    if (typeof device === "string") { out.compute = device; return out; }
    const run = async () => {
      const module = device.createShaderModule({ code: "@group(0) @binding(0) var<storage, read_write> v: array<u32>; @compute @workgroup_size(4) fn main(@builtin(global_invocation_id) i: vec3<u32>) { v[i.x] = v[i.x] * 2u; }" });
      const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });
      const data = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      const read = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(data, 0, new Uint32Array([1, 2, 3, 4]));
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: data } }] }));
      pass.dispatchWorkgroups(1);
      pass.end();
      enc.copyBufferToBuffer(data, 0, read, 0, 16);
      device.queue.submit([enc.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      return [...new Uint32Array(read.getMappedRange())].join(",");
    };
    out.compute = await bounded(run().catch((e) => String(e?.message || e)));
    device.destroy();
    return out;
  }
  if (part === "webgpu") return webgpu();
  if (part === "navigator") return { userAgent: navigator.userAgent, platform: navigator.platform, hardwareConcurrency: navigator.hardwareConcurrency, screen: [screen.width, screen.height, screen.colorDepth], dpr: devicePixelRatio };
  return gl(part);
}

function probeServer() {
  const server = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>probe</title>probe"); });
  return new Promise((ok, no) => { server.once("error", no); server.listen(0, "127.0.0.1", () => ok(server)); });
}

// The persona modes: today's launch (the seed persona's GPU), and the Linux plan of spec E2 (the
// real backend's strings and limits: disableGpuFingerprint, fingerprintNoise off).
const MODES = { persona: {}, real: { disableGpuFingerprint: true, fingerprintNoise: false } };
const PARTS = ["webgl", "webgl2", "webgpu", "navigator"];

async function measure(chromium, exec, name, args, mode, base, screen) {
  const config = { ...base, pairbrowse: { ...base.pairbrowse, ...MODES[mode] } };
  const engine = engineConfig(config, { binary: "native", executablePath: exec });
  const shell = shellOf(engine);
  const scratch = mkdtempSync(join(paths.browser, ".measure-"));
  const profile = join(scratch, "profile");
  prepareProfile(profile, undefined, { browserPages: shell.ownPages, layout: config.layout });
  const server = await probeServer();
  const env = { ...process.env, ...(screen?.env || {}) };
  const opts = launchOptions(config, { shell, screen, env, executablePath: exec, blankStart: true });
  opts.args = [...opts.args, ...args];
  // On this Mac the window stays off screen (headless, the host capture's Metal path, spec E4).
  if (platform === "macos") opts.headless = true;
  const result = { platform, arch: process.arch, candidate: name, mode, args, at: new Date().toISOString() };
  let ctx = null;
  try {
    ctx = await within(120_000, launchEngine(chromium, engine, profile, opts, log, undefined, { server: serverMode(config, process.env) }));
    if (!ctx) throw new Error("the launch took longer than 120 s");
    result.version = ctx.browser()?.version() || null;
    result.sandbox = { on: SANDBOX.on, required: SANDBOX.required };
    const cdp = await within(STEP_MS, ctx.browser().newBrowserCDPSession());
    const info = cdp && await within(STEP_MS, cdp.send("SystemInfo.getInfo").catch((e) => ({ error: String(e?.message || e) })));
    result.systemInfo = info ? scrubSystemInfo(info) : { unanswered: true };
    result.sandbox.noSandboxSwitch = /(?:^|\s)--no-sandbox(?:\s|=|$)/.test(info?.commandLine || "");
    const page = ctx.pages()[0] || await within(STEP_MS, ctx.newPage());
    if (!page) throw new Error("no page");
    const loaded = await within(STEP_MS, page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "domcontentloaded" }).then(() => true, (e) => String(e?.message || e)));
    if (loaded !== true) throw new Error(`the probe page didn't load (${loaded ?? "timed out"})`);
    const probe = {};
    // A page that answers nothing (its renderer hung) answers no later part either.
    let hung = false;
    for (const part of PARTS) {
      probe[part] = hung ? { unanswered: true, skipped: "the page answered nothing before" }
        : await within(STEP_MS * 3, page.evaluate(probePage, [part, STEP_MS]).catch((e) => ({ error: String(e?.message || e) }))) ?? { unanswered: true };
      hung ||= probe[part].unanswered === true;
    }
    result.probe = scrubProbe(probe);
    // The engine's own sandbox status page: each layer for the renderers (namespaces, seccomp-BPF).
    // Linux only: the macOS build has no such page.
    if (platform === "macos") result.sandbox.page = "not on macOS";
    else if (!hung) {
      const shown = await within(STEP_MS, page.goto("chrome://sandbox").then(() => page.evaluate(() => document.body.innerText), (e) => `not shown (${String(e?.message || e).split("\n")[0]})`));
      result.sandbox.page = shown === null ? "timed out" : scrubProbe(String(shown).split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 30));
    }
  } catch (e) {
    result.error = String(e?.message || e).split("\n").slice(0, 6).join("\n");
  } finally {
    await within(STEP_MS, ctx?.close().catch(() => {}) ?? Promise.resolve());
    server.close();
    rmSync(scratch, { recursive: true, force: true });
  }
  return result;
}

const config = loadConfig();
let exec = process.env.PB_EXECUTABLE;
if (process.env.PB_INSTALL === "1") {
  const { ensureNative } = await import("../../../scripts/native/install.mjs");
  exec = await ensureNative(log, { config });
}
if (!exec) throw new Error("no native build (PB_EXECUTABLE or PB_INSTALL=1)");
const { chromium } = loadBrowserDriver(createRequire(join(paths.runtime, "package.json")), config, process.versions.node, patchrightNodeMinimum(paths.runtime));
mkdirSync(paths.browser, { recursive: true });
const screen = needsVirtualDisplay(config, process.env) ? await startVirtualDisplay(log, { name: "Xauthority-measure", geometry: screenGeometry(config) }) : null;
const out = process.env.PB_OUT;
const only = process.env.PB_CANDIDATES ? process.env.PB_CANDIDATES.split(",") : null;
try {
  for (const [name, args] of Object.entries(CANDIDATES[platform] || {})) for (const mode of Object.keys(MODES)) {
    if (only && !only.includes(name)) continue;
    log(`${name} (${mode}): ${args.join(" ") || "(no switches)"}`);
    const r = await measure(chromium, exec, name, args, mode, config, screen);
    if (out) writeFileSync(join(out, `${platform}-${name}-${mode}.json`), JSON.stringify(r, null, 2) + "\n");
    const dev = r.systemInfo?.gpu?.devices?.[0];
    console.log(JSON.stringify({
      candidate: name, mode, error: r.error, sandbox: r.sandbox, version: r.version,
      device: dev ? `${dev.vendorString || dev.vendorId} / ${dev.deviceString || dev.deviceId}` : null,
      glRenderer: r.systemInfo?.gpu?.auxAttributes?.glRenderer, softwareRendering: r.systemInfo?.gpu?.auxAttributes?.softwareRendering,
      webgl: r.probe?.webgl?.unmaskedRenderer ?? r.probe?.webgl?.available, webgl2: r.probe?.webgl2?.available,
      webgpu: r.probe?.webgpu?.available ? `${r.probe.webgpu.vendor}/${r.probe.webgpu.architecture} fallback=${r.probe.webgpu.isFallbackAdapter} limits=${r.probe.webgpu.deviceWithReportedLimits} compute=${r.probe.webgpu.compute}` : r.probe?.webgpu?.reason,
    }));
  }
} finally {
  await screen?.stop();
}
