// The launch self-check a native build passes before it's kept (scripts/native/check.mjs): its
// failure paths up to the launch, with no browser. The runtime here looks installed and its
// driver is a stub that only notes a launch was asked for; the engine pack is missing or altered,
// so the check must refuse before any browser starts, and leave nothing behind.
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "pb-nc-"));
process.env.PAIRBROWSE_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { selfCheck } = await import("../scripts/native/check.mjs");
const { paths } = await import("../scripts/paths.mjs");
const { NATIVE } = await import("../scripts/native-pack.mjs");

const launched = join(home, "launched");
const runtimeModules = join(paths.runtime, "node_modules");
mkdirSync(join(runtimeModules, "@playwright", "mcp"), { recursive: true });
writeFileSync(join(paths.runtime, "package-lock.json"), readFileSync(join(root, "runtime", "package-lock.json")));

// The driver the check loads from the runtime: a stub whose launch only leaves a mark.
function stubDriver() {
  const dir = join(runtimeModules, "patchright");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "patchright", version: "0.0.0", main: "index.js", engines: { node: ">=18" } }));
  writeFileSync(join(dir, "index.js"), `const fs = require("node:fs");
const mark = () => { fs.writeFileSync(${JSON.stringify(launched)}, "1"); throw new Error("stub driver: no browser here"); };
exports.chromium = { launchPersistentContext: mark, launch: mark };
`);
}

// The engine pack, marked installed at the pinned version; files: name -> contents.
function enginePack(files) {
  rmSync(paths.engine, { recursive: true, force: true });
  mkdirSync(paths.engine, { recursive: true });
  writeFileSync(join(paths.engine, "installed.json"), JSON.stringify({ sha256: NATIVE.engine.sha256 }));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(paths.engine, name), body);
}

// A program that isn't a browser: the check must never get as far as running it.
const exec = join(home, "fake-build", "PairBrowse");
mkdirSync(dirname(exec), { recursive: true });
writeFileSync(exec, "#!/bin/sh\necho ran > \"$(dirname \"$0\")/ran\"\n", { mode: 0o755 });

const leftovers = () => (existsSync(paths.browser) ? readdirSync(paths.browser).filter((n) => n.startsWith(".selfcheck-")) : []);

test("no driver in the runtime: refused before anything is made", async () => {
  await assert.rejects(selfCheck(exec, { config: {}, timeoutMs: 20_000 }), /patchright|Cannot find module/);
  assert.deepEqual(leftovers(), []);
  assert.ok(!existsSync(launched));
});

// The build's manifest beside the program (a Linux or Windows layout).
const manifest = (m) => writeFileSync(join(dirname(exec), "PairBrowse-build.json"), JSON.stringify(m));
const MAJOR = NATIVE.version.split(".")[0];

test("a build without its manifest, or one for another product or engine version: refused before any launch", async () => {
  stubDriver();
  enginePack({});
  await assert.rejects(selfCheck(exec, { config: {}, timeoutMs: 20_000 }), /PairBrowse-build\.json/);
  for (const bad of [{ product: "Chromium", version: `${MAJOR}.0.0.1`, platform: "linux" }, { product: "PairBrowse", version: "1.0.0.1", platform: "linux" }, { product: "PairBrowse", version: `${MAJOR}.0`, platform: "linux" }]) {
    manifest(bad);
    await assert.rejects(selfCheck(exec, { config: {}, timeoutMs: 20_000 }), new RegExp(`requires a PairBrowse build of engine version ${MAJOR}`), JSON.stringify(bad));
  }
  manifest({ product: "PairBrowse", version: `${MAJOR}.0.0.1` });
  await assert.rejects(selfCheck(exec, { config: {}, timeoutMs: 20_000 }), /names no platform/);
  assert.ok(!existsSync(launched));
  assert.deepEqual(leftovers(), []);
});

test("the engine pack missing a file: refused before any launch, the throwaway profile removed", async () => {
  stubDriver();
  manifest({ product: "PairBrowse", version: `${MAJOR}.0.0.1`, platform: "linux" });
  enginePack({ "collector.js": "x" });
  await assert.rejects(selfCheck(exec, { config: {}, timeoutMs: 20_000 }), /engine pack has no engine\.mjs/);
  assert.ok(!existsSync(launched), "no browser launch was asked for");
  assert.ok(!existsSync(join(dirname(exec), "ran")), "the build was never run");
  assert.deepEqual(leftovers(), [], "nothing left in the browser folder");
});

test("an engine pack file altered after install: refused by its pinned SHA-256", async () => {
  stubDriver();
  enginePack({ "engine.mjs": "export const launchNative = () => { throw new Error('altered'); };", "collector.js": "x" });
  await assert.rejects(selfCheck(exec, { config: {}, timeoutMs: 20_000 }), /engine\.mjs doesn't match its pinned SHA-256/);
  assert.ok(!existsSync(launched));
  assert.deepEqual(leftovers(), []);
});

// The wiring (read from the source: the launch needs a real browser): the check launches on the
// screen it started and sizes the window to it, as the helper does (browser.mjs launchOptions).
test("the check's launch passes its screen to launchOptions", () => {
  const all = readFileSync(join(root, "scripts", "native", "check.mjs"), "utf8");
  const src = all.slice(all.indexOf("export async function selfCheck("));
  const at = src.indexOf("launchOptions(config, {");
  assert.ok(at > 0, "check.mjs calls launchOptions(config, {...})");
  const call = src.slice(at, src.indexOf("\n", at));
  assert.match(call, /[{,]\s*screen\s*,/, "the window is sized to the virtual screen");
  assert.match(call, /env: \{ \.\.\.env, \.\.\.\(screen\?\.env \|\| \{\}\) \}/);
});

// The graphics step (spec server-mode E4; native/probe.mjs): after the checks above, on the same
// screen, a probe browser started as the check's was, hidden on macOS, with the same sandbox rule;
// its line names a software backend as such and never the GPU, and a probe that fails leaves the
// step unverified rather than failing the install.
test("self-check graphics step names a software backend as such", async () => {
  const { graphicsStep } = await import("../scripts/native/probe.mjs");
  const software = { backend: { kind: "software", renderer: "llvmpipe (LLVM 15.0.6 128 bits)" }, webgl: { available: true }, webgl2: { available: true }, webgpu: { available: false } };
  assert.equal(graphicsStep(software), "graphics: software, WebGL 2, WebGPU unavailable");
  const src = readFileSync(join(root, "scripts", "native", "check.mjs"), "utf8");
  const run = src.slice(src.indexOf("const result = await withTimeout(work"));
  assert.match(run, /probeOptions\(launchOptions\(config, \{ shell, screen, env: \{ \.\.\.env, \.\.\.\(screen\?\.env \|\| \{\}\) \}/, "launched as the check's, on its screen, hidden on macOS");
  assert.match(run, /\{ server: serverMode\(config, env\) \}/, "the same sandbox rule");
  assert.match(run, /display: screen \? "xvfb" : "native"/);
  assert.ok(run.indexOf("graphicsCheck(") < run.indexOf("await screen?.stop()"), "the probe runs before the check's screen stops");
});

// graphicsCheck itself, with the real probeLaunch over a stand-in browser.
const { graphicsCheck, GRAPHICS_TIMEOUT_MS, GRAPHICS_STOP_MS } = await import("../scripts/native/check.mjs");
const { GRAPHICS } = await import("../scripts/native/graphics.mjs");

// A stand-in probe browser: a launch sets the helper's state as a real one does; its tab's page
// load never answers until the browser is closed (hang), or is refused at once (refuse).
function probeBrowser({ hang = false, refuse = false } = {}) {
  const seen = { starts: 0, closed: 0, open: 0 };
  const launch = async () => {
    seen.starts++;
    seen.open++;
    Object.assign(GRAPHICS, { kind: "probe", status: "probe" });
    let shut = () => {};
    const closed = new Promise((_, no) => { shut = () => no(new Error("Target closed")); });
    closed.catch(() => {});
    const tab = {
      goto: async () => { if (refuse) throw new Error("net::ERR_CONNECTION_REFUSED"); if (hang) await closed; },
      evaluate: async () => null,
    };
    return { pages: () => [tab], browser: () => null, close: async () => { seen.closed++; seen.open--; shut(); } };
  };
  return { launch, seen };
}

test("graphics step bounds: fits the launch path, under four minutes past the check in the worst case", () => {
  assert.ok(GRAPHICS_TIMEOUT_MS <= 120_000, `${GRAPHICS_TIMEOUT_MS}`);
  assert.ok(GRAPHICS_TIMEOUT_MS + GRAPHICS_STOP_MS < 240_000, `${GRAPHICS_TIMEOUT_MS + GRAPHICS_STOP_MS}`);
});

test("graphics step past its time: the probe is stopped, its browser closed and its state put back before the line, nothing after", async () => {
  const scratch = mkdtempSync(join(home, "probe-scratch-"));
  const live = { requested: GRAPHICS.requested, kind: "live", status: "live" };
  Object.assign(GRAPHICS, live);
  const sandbox = { on: true, reason: "live" };
  const { launch, seen } = probeBrowser({ hang: true });
  const measured = [], logged = [];
  const line = await graphicsCheck({ launch, build: "150.0.0.1", platform: "linux", sandbox, scratch, log: (l) => logged.push(l), onMeasured: (m) => measured.push(m), timeoutMs: 300, stepMs: 60_000, launchMs: 5000, stopMs: 5000 });
  assert.equal(line, "graphics: unverified (not measured: it took longer than 0.3 s)");
  assert.deepEqual(measured, [], "no measurement kept");
  assert.equal(seen.starts, 1, "no second start after the stop");
  assert.equal(seen.open, 0, "the probe browser is closed when the step answers");
  assert.equal(GRAPHICS.kind, "live", "the state put back before the step answered");
  assert.deepEqual(readdirSync(scratch), [], "its folder removed");
  // The live browser starts now and sets its own state: nothing of the probe's comes back later.
  Object.assign(GRAPHICS, { kind: "next", status: "next" });
  Object.assign(sandbox, { on: false, reason: "next" });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(GRAPHICS.kind, "next");
  assert.deepEqual(sandbox, { on: false, reason: "next" });
  assert.ok(logged.some((l) => /graphics not measured: it took longer/.test(l)));
});

test("graphics step whose probe fails: an unverified line naming why, no measurement, the browser closed", async () => {
  const scratch = mkdtempSync(join(home, "probe-scratch-"));
  const { launch, seen } = probeBrowser({ refuse: true });
  const measured = [];
  const line = await graphicsCheck({ launch, build: "150.0.0.1", platform: "linux", sandbox: { on: true }, scratch, onMeasured: (m) => measured.push(m), timeoutMs: 5000, stepMs: 1000, launchMs: 1000 });
  assert.equal(line, "graphics: unverified (not measured: net::ERR_CONNECTION_REFUSED)");
  assert.deepEqual(measured, []);
  assert.equal(seen.open, 0);
  assert.deepEqual(readdirSync(scratch), []);
});

test("graphics step off macOS and Linux: a clean line, no probe started", async () => {
  let asked = 0;
  const probe = async () => { asked++; throw new Error("never"); };
  assert.equal(await graphicsCheck({ platform: "win32", probe, scratch: home }), "graphics: not measured on Windows");
  assert.equal(await graphicsCheck({ platform: "freebsd", probe, scratch: home }), "graphics: not measured on freebsd");
  assert.equal(asked, 0);
});
