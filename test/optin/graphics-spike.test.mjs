// Spike E-S1 (server-mode spec step 39): what the native build's graphics really are, measured, on
// each runtime. Linux: the pinned Linux build installed the way the helper installs it, in the A13
// container (test/optin/server/container.mjs, its first user), on the helper's own virtual
// screen with the sandbox required. macOS: the native build on this Mac, headless. For every
// candidate set of graphics switches and both persona modes (today's, and the E2 Linux plan:
// disableGpuFingerprint, noise off) it reads SystemInfo.getInfo through the driver and probes a
// local page (test/optin/server/graphics-measure.mjs).
//
// Linux needs PAIRBROWSE_TEST_DOCKER=1 and PAIRBROWSE_TEST_RUNTIME; macOS needs
// PAIRBROWSE_TEST_RUNTIME, PAIRBROWSE_TEST_EXECUTABLE (the native build) and PAIRBROWSE_TEST_ENGINE.
// PAIRBROWSE_TEST_FIXTURES=<folder> (test/fixtures) writes the fixtures the Phase E unit tests read
// (FIXTURES in server/scrub.mjs), scrubbed of paths and the command line.
import "../helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE } from "../../scripts/native-pack.mjs";
import { downloadPinned } from "../../scripts/util.mjs";
import { dockerReady, startContainer } from "./server/container.mjs";
import { FIXTURES } from "./server/scrub.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const linuxSkip = !runtime || process.env.PAIRBROWSE_TEST_DOCKER !== "1";
const macExecutable = process.env.PAIRBROWSE_TEST_EXECUTABLE;
const macEngine = process.env.PAIRBROWSE_TEST_ENGINE;
const macSkip = process.platform !== "darwin" || !runtime || !macExecutable || !macEngine;
const fixtures = process.env.PAIRBROWSE_TEST_FIXTURES;
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const measureScript = join(repo, "test", "optin", "server", "graphics-measure.mjs");
// Downloads kept between runs (the pinned archive is about 150 MB), fetched and checked against
// its pin here, then copied into the container's home, where the install checks it again.
const cache = join(tmpdir(), "pairbrowse-test-downloads");

const temp = [];
after(() => { for (const d of temp) rmSync(d, { recursive: true, force: true }); });
function outDir() {
  const d = mkdtempSync(join(tmpdir(), "pb-graphics-"));
  chmodSync(d, 0o777); // the container's user writes here
  temp.push(d);
  return d;
}
const results = (dir) => Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => [f.slice(0, -5), JSON.parse(readFileSync(join(dir, f), "utf8"))]));

function writeFixtures(all) {
  if (!fixtures) return;
  mkdirSync(fixtures, { recursive: true });
  for (const [file, from, part] of FIXTURES) {
    const r = all[from];
    if (!r) continue;
    const { platform, arch, candidate, mode, args, version, sandbox } = r;
    const kept = { source: "spike E-S1 (test/optin/graphics-spike.test.mjs)", platform, arch, candidate, mode, args, version, sandbox, [part]: r[part] };
    writeFileSync(join(fixtures, file), JSON.stringify(kept, null, 2) + "\n");
  }
}

const renderer = (r) => r.systemInfo?.gpu?.auxAttributes?.glRenderer || "";
// Whether the probed page stopped answering (graphics-measure.mjs then skips the sandbox page).
const hung = (r) => Object.values(r.probe || {}).some((p) => p?.unanswered === true);
const SOFTWARE = /llvmpipe|SwiftShader|lavapipe/i;

// What holds for every launch: the build pinned, the sandbox on (and no --no-sandbox on its
// command line), SystemInfo answered through the driver with its GPU devices.
function common(name, r) {
  assert.equal(r.error, undefined, `${name}: ${r.error}`);
  assert.equal(r.version, NATIVE.version, name);
  assert.equal(r.sandbox?.on, true, `${name}: the sandbox is on`);
  assert.equal(r.sandbox?.noSandboxSwitch, false, `${name}: no --no-sandbox`);
  assert.ok(Array.isArray(r.systemInfo?.gpu?.devices), `${name}: SystemInfo answered`);
  if (r.platform === "linux" && !hung(r)) {
    // The engine's own status page, read for every launch whose page still answers (a missing or
    // timed-out page fails): the namespace layer always. Seccomp-BPF only where the kernel runs
    // the browser's own instructions: under x64 emulation (an Apple Silicon Mac) the emulator
    // refuses every seccomp filter, Docker's default profile or ours alike.
    assert.ok(Array.isArray(r.sandbox?.page), `${name}: the sandbox page was read (${JSON.stringify(r.sandbox?.page)})`);
    assert.ok(r.sandbox.page.includes("Layer 1 Sandbox\tNamespace"), `${name}: namespace sandbox`);
    if (process.arch === "x64") assert.ok(r.sandbox.page.includes("Seccomp-BPF sandbox\tYes"), `${name}: seccomp-BPF sandbox`);
  }
  // A defined WebGPU result: an adapter, or the reason there is none.
  const gpu = r.probe?.webgpu;
  assert.ok(gpu && (gpu.available === true || typeof gpu.reason === "string" || gpu.unanswered), `${name}: WebGPU result`);
}

test("Linux container: SystemInfo through the driver, the software renderer named, real strings under the E2 plan, sandbox on", { skip: linuxSkip, timeout: 3_600_000 }, async () => {
  assert.ok(dockerReady(), "Docker answers");
  const out = outDir();
  const pinned = NATIVE.linux.file;
  await downloadPinned(`${NATIVE.baseUrl}/${pinned}`, join(cache, pinned), NATIVE.linux.sha256);
  const c = startContainer({ name: "pb-graphics-spike", repo, log: console.log, mounts: [
    { from: runtime, to: "/runtime" }, { from: cache, to: "/cache" }, { from: out, to: "/out", readOnly: false },
  ] });
  try {
    // A copy (the install removes its download once installed).
    const copied = await c.exec(["bash", "-c", `mkdir -p /home/pb/h/downloads && cp /cache/${pinned} /home/pb/h/downloads/`]);
    assert.equal(copied.code, 0, copied.out);
    const r = await c.node("/repo/test/optin/server/graphics-measure.mjs", [], { env: { PAIRBROWSE_HOME: "/home/pb/h", PB_RUNTIME: "/runtime", PB_INSTALL: "1", PB_OUT: "/out" }, ms: 3_000_000 });
    console.log(r.out);
    assert.equal(r.code, 0, r.out);
  } finally { c.stop(); }
  const all = results(out);
  for (const [name, r] of Object.entries(all)) common(name, r);
  // The default path: Mesa's llvmpipe under Xvfb, measured as software.
  assert.match(renderer(all["linux-auto-real"]), /llvmpipe/i);
  assert.match(renderer(all["linux-swiftshader-real"]), /SwiftShader/i);
  // The default path's page answers, so its sandbox page was read in both persona modes.
  for (const name of ["linux-auto-real", "linux-auto-persona"]) {
    assert.ok(all[name] && !hung(all[name]), `${name}: the page answered`);
    assert.ok(Array.isArray(all[name].sandbox?.page), `${name}: the sandbox page was read`);
  }
  assert.match(renderer(all["linux-mesa-vulkan-real"]), /llvmpipe/i);
  // --use-angle=vulkan over lavapipe is rejected (spec E2): SystemInfo answers, the page never does.
  for (const name of ["linux-mesa-vulkan-real", "linux-mesa-vulkan-persona"]) {
    assert.match(all[name]?.systemInfo?.gpu?.auxAttributes?.glImplementationParts || "", /angle=vulkan/, `${name}: ANGLE on Vulkan`);
    for (const part of ["webgl", "webgl2"]) assert.equal(all[name].probe?.[part]?.unanswered, true, `${name}: ${part} unanswered`);
  }
  // Under the E2 plan the page's WebGL strings are the measured renderer's.
  for (const name of ["linux-auto-real", "linux-swiftshader-real", "linux-mesa-gl-real"]) {
    const page = all[name].probe?.webgl?.unmaskedRenderer || "";
    assert.match(page, SOFTWARE, `${name}: the page sees the software renderer (${page})`);
    assert.equal(page.match(SOFTWARE)[0].toLowerCase(), renderer(all[name]).match(SOFTWARE)[0].toLowerCase(), `${name}: page and SystemInfo agree`);
  }
  assert.equal(all["linux-disable-gpu-real"].probe?.webgl?.available, false, "--disable-gpu: no WebGL");
  writeFixtures(all);
});

test("macOS native: SystemInfo through the driver names the Metal hardware, sandbox on", { skip: macSkip, timeout: 1_200_000 }, async () => {
  const out = outDir();
  const home = mkdtempSync(join(tmpdir(), "pbg-"));
  temp.push(home);
  const env = { ...process.env, PAIRBROWSE_HOME: home, PB_RUNTIME: runtime, PB_ENGINE: macEngine, PB_EXECUTABLE: macExecutable, PB_OUT: out };
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [measureScript], { env, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    p.stdout.on("data", (d) => (text += d)); p.stderr.on("data", (d) => (text += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), 1_100_000);
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, out: text }); });
  });
  console.log(r.out);
  assert.equal(r.code, 0, r.out);
  const all = results(out);
  for (const [name, r] of Object.entries(all)) common(name, r);
  const metal = all["macos-auto-persona"];
  assert.match(renderer(metal), /Metal/i, "ANGLE on Metal");
  assert.doesNotMatch(renderer(metal), SOFTWARE);
  // macOS has no sandbox status page; only the launch's own sandbox choice (SANDBOX.on) is read.
  for (const [name, r] of Object.entries(all)) assert.equal(r.sandbox.page, "not on macOS", name);
  writeFixtures(all);
});
