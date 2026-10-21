// A launch's graphics (spec server-mode section 3.2 steps 4 and 7, step 44; daemon/browser/graphics.mjs):
// the measurement kept for this build and screen or, the first start per runtime, one probe browser
// of its own ("measuring graphics once for this browser version", not retried in the same helper
// run after it failed); the static compatibility errors (E7's screen, E9's backend, requirement and
// legacy identity) refusing the start by name; after the start the browser's own read, a GPU over
// software refused, a measurement of another runtime dropped so the next start measures again,
// requireValidatedProfiles held to the runtime key; the verdict filed with the profile; the
// status part (no renderer for a joiner's agent) and diagnostics' kind and status. Then the same
// filing through sessions/profiles.mjs (a launch's verdict and an install self-check's) and
// cli.mjs validate's measurement. Measurements are built from spike E-S1's fixtures.
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGraphics, MEASURING_GRAPHICS, MEASURING_BUSY, MEASURING_WAIT_MS } from "../scripts/daemon/browser/graphics.mjs";
import { throughMeasurement } from "../scripts/daemon/browser/launch.mjs";
import { GRAPHICS_TIMEOUT_MS, GRAPHICS_STOP_MS } from "../scripts/native/check.mjs";
import { GRAPHICS, GPU_LESS_IDENTITY, LINUX_IDENTITY, runtimeKey, graphicsStatusPart, SOFTWARE_SWITCH } from "../scripts/native/graphics.mjs";
import { parseSystemInfo } from "../scripts/native/backend.mjs";
import { measuredRecord } from "../scripts/native/validate.mjs";
import { createProfiles } from "../scripts/daemon/sessions/profiles.mjs";
import { createProfileStore } from "../scripts/profiles/store.mjs";
import { createSession, assignProfile } from "../scripts/sessions.mjs";
import { runProfilesCli } from "../scripts/profiles/cli.mjs";
import { createDiagnostics, graphicsSummary } from "../scripts/daemon/diagnostics.mjs";

const dir = mkdtempSync(join(tmpdir(), "pb-launch-graphics-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const BUILD = "150.0.7871.114";
const PACK = "4451781446317d6ebf675afa0d75258d826fb1f5ddf06f292a20bfc24e65f793";
const XVFB = { geometry: { width: 1366, height: 768, depth: 24 } };
const T0 = Date.parse("2026-10-21T10:00:00Z");
const LLVMPIPE = parseSystemInfo(fixture("systeminfo-linux-xvfb-llvmpipe").systemInfo);
const METAL = parseSystemInfo(fixture("systeminfo-macos-metal").systemInfo);
const keyFor = (backend, { platform = "linux", arch = "x64", display = "xvfb", switches = [] } = {}) => runtimeKey({ build: BUILD, pack: PACK, platform, arch, display, backend, switches });

// The probe's record of a fixture, as native/probe.mjs files it: this runtime's key, the
// SystemInfo read as its backend, the page's parts.
function measurement(probeName, backend, { display = "xvfb" } = {}) {
  const f = fixture(probeName);
  const key = keyFor(backend, { platform: f.platform, arch: f.arch, display });
  const [width, height, colorDepth] = f.probe.navigator.screen;
  return measuredRecord({
    at: "2026-10-21T09:00:00Z", runtimeKey: key, pack: PACK,
    runtime: { platform: f.platform, arch: f.arch, display, emulated: false, sandbox: { on: true, page: f.platform === "linux" ? f.sandbox.page.concat("Seccomp-BPF sandbox\tYes") : "not on macOS" } },
    backend, webgl: { ...f.probe.webgl, sameOrigins: true }, webgl2: f.probe.webgl2, webgpu: f.probe.webgpu,
    canvas: { stable: true, repeat: true, noise: false }, fonts: { checked: 8, missing: [], controlFound: [] }, media: { "video/mp4": true },
    screen: { width, height, availWidth: width, availHeight: height, colorDepth, devicePixelRatio: f.probe.navigator.dpr },
    locale: { timezone: "UTC", languages: ["en-US"] },
    navigator: { userAgent: f.probe.navigator.userAgent.replace(/Chrome\/\d+/, "Chrome/150"), platform: f.probe.navigator.platform, hardwareConcurrency: 8, deviceMemory: 8 },
  });
}
const LINUX_MEASURED = measurement("probe-linux-llvmpipe-real", LLVMPIPE);
// Under the Windows identity (the engine's Windows persona over llvmpipe): the fixture's page.
const WINDOWS_MEASURED = measuredRecord({ ...measurement("probe-linux-llvmpipe-windows", LLVMPIPE), shown: GPU_LESS_IDENTITY.name });
const request = (change = {}) => ({ graphics: { backend: "auto", require: null }, screen: null, window: null, locale: { timezone: null, languages: null }, ...change });
const chosenWith = (change = {}) => ({ id: "p-0123456789abcdef", name: "berlin", results: [], measured: null, ...change, request: request(change.request) });

// One part with stand-ins: the probe, the read, the filing.
function part({ platform = "linux", arch = "x64", probe = null, live = LLVMPIPE, config = {} } = {}) {
  const st = {}, lines = [], filed = [], statuses = [];
  let probes = 0, told = 0, probingSeen = null;
  const probeGraphics = async (o) => {
    probes++;
    probingSeen = st.probing;
    if (!probe) throw new Error("no probe here");
    const m = await probe(o);
    if (m) o.onMeasured(m);
    return m ? "graphics: software, WebGL 2, WebGPU unavailable" : "graphics: unverified (not measured: it took too long)";
  };
  const api = { profiles: { fileValidation: (entry, opts) => { filed.push({ entry, opts }); return entry.graphics ? entry.status : "unverified"; } }, onProbing: () => { told++; } };
  const g = createGraphics(st, { config, log: (l) => lines.push(l), status: (s) => statuses.push(s), hud: { badge: () => "badge" }, probeGraphics, readBackendOf: async () => (typeof live === "function" ? live() : live), platform, arch, scratch: join(dir, "scratch") }, api);
  return { g, st, lines, filed, statuses, probes: () => probes, told: () => told, probingSeen: () => probingSeen };
}
const NATIVE = { native: true, build: BUILD, pack: PACK, screen: XVFB, session: "shop", probeLaunch: () => {} };

test("a measurement kept for this runtime: no probe; the read's runtime key matches, the verdict is filed, the status part and diagnostics", async () => {
  GRAPHICS.switches = [];
  const p = part();
  const chosen = chosenWith({ measured: LINUX_MEASURED });
  const plan = await p.g.before({ ...NATIVE, chosen });
  assert.equal(p.probes(), 0, "a kept measurement of this build, pack and screen isn't measured again");
  assert.equal(plan.source, "stored");
  const r = await p.g.after({}, plan, { chosen, switches: ["--lang=en-US"], session: "shop" });
  assert.deepEqual(r, { ok: true });
  const { entry, opts } = p.filed[0];
  assert.equal(entry.runtimeKey, keyFor(LLVMPIPE), "the live read's key is the measurement's");
  assert.ok(entry.graphics, "kept with its measurement");
  assert.equal(entry.status, "validated", "every error check matched on the real llvmpipe strings");
  assert.deepEqual(opts, { build: BUILD, replaceMeasured: false });
  assert.equal(entry.items.find((i) => i.rule === "backend.stable").status, "matched");
  assert.equal(GRAPHICS.kind, "software");
  assert.equal(GRAPHICS.status, entry.status);
  assert.deepEqual(p.g.statusParts(), [`Graphics: software (${LLVMPIPE.renderer.slice(0, 80)}), requested auto, ${entry.status} on ${BUILD}`]);
  const remote = p.g.statusParts({ remote: true })[0];
  assert.equal(remote, `Graphics: software, requested auto, ${entry.status} on ${BUILD}`, "a joiner's agent gets the kind and status only");
  assert.ok(!remote.includes("llvmpipe"));
  assert.deepEqual(p.g.summary(), { kind: "software", status: entry.status });
  p.g.release();
  assert.deepEqual([p.g.statusParts(), p.g.summary()], [[], null], "nothing to say once the browser closed");
});

test("the first start per runtime measures once in a probe browser of its own; a failed probe isn't retried in this helper run", async () => {
  let seen = null;
  const p = part({ probe: async (o) => { seen = o; return LINUX_MEASURED; } });
  const launch = () => {};
  const plan = await p.g.before({ ...NATIVE, chosen: chosenWith(), probeLaunch: launch });
  assert.equal(p.probes(), 1);
  assert.equal(plan.source, "probe");
  assert.equal(plan.measured, LINUX_MEASURED);
  assert.ok(p.lines.includes(MEASURING_GRAPHICS), "logged: measuring graphics once for this browser version");
  assert.equal(MEASURING_GRAPHICS, "launch: measuring graphics once for this browser version");
  assert.equal(seen.launch, launch, "the launch's own start for the probe");
  assert.deepEqual([seen.build, seen.pack, seen.display, seen.platform], [BUILD, PACK, "xvfb", "linux"]);
  assert.deepEqual(p.statuses.map((s) => (typeof s === "string" ? s : s.kind)), ["claude", "badge"], "the live view says so, then the badge comes back");
  assert.equal(p.told(), 1, "the calls waiting on the start are told to retry");
  assert.equal(p.probingSeen(), true, "st.probing while the probe runs");
  assert.equal(p.st.probing, false, "and not after");
  assert.match(MEASURING_BUSY, /^PairBrowse is measuring this browser's graphics once \(a minute or two\)\. Tell the user, then retry/);
  // A probe that answers nothing: the start goes on unverified, and the same runtime isn't probed
  // again until the helper restarts (another session's profile is).
  const q = part({ probe: async () => null });
  const first = await q.g.before({ ...NATIVE, chosen: chosenWith() });
  assert.equal(first.measured, null);
  await q.g.before({ ...NATIVE, chosen: chosenWith() });
  assert.equal(q.probes(), 1);
  await q.g.before({ ...NATIVE, chosen: chosenWith({ id: "p-fedcba9876543210" }) });
  assert.equal(q.probes(), 2);
  // A kept measurement of another screen (a desktop's, now on Xvfb) is measured again.
  const r = part({ probe: async () => LINUX_MEASURED });
  await r.g.before({ ...NATIVE, chosen: chosenWith({ measured: measurement("probe-linux-llvmpipe-real", LLVMPIPE, { display: "native" }) }) });
  assert.equal(r.probes(), 1);
  // The open build: nothing measured, nothing refused here (its mapping refuses graphics fields).
  const o = part({ probe: async () => LINUX_MEASURED });
  const open = await o.g.before({ native: false, chosen: chosenWith(), screen: XVFB });
  assert.equal(o.probes(), 0);
  assert.equal((await o.g.after({}, open, {})).ok, true);
  assert.equal(o.filed.length, 0, "no validation on the open build");
  assert.deepEqual(o.g.statusParts(), [`Graphics: software (${LLVMPIPE.renderer.slice(0, 80)}), requested auto, unverified on PairBrowse as an extension`]);
});

test("static errors refuse the start, all named (E7, E9): a GPU over measured software, could not confirm, a screen vs the virtual screen, a requirement unmet", async () => {
  const p = part({ probe: async () => LINUX_MEASURED });
  await assert.rejects(p.g.before({ ...NATIVE, chosen: chosenWith({ measured: LINUX_MEASURED, request: { graphics: { backend: "gpu", require: null } } }) }),
    { message: `Session "shop" doesn't start: Profile berlin asks for a GPU (graphics.backend: gpu) but this computer renders in software (${LLVMPIPE.renderer}). Nothing was started.` });
  // Nothing measured (the probe failed): a GPU or a requirement can't be confirmed.
  const q = part({ probe: async () => null });
  await assert.rejects(q.g.before({ ...NATIVE, chosen: chosenWith({ request: { graphics: { backend: "gpu", require: null } } }) }), /could not confirm which renderer this browser uses/);
  await assert.rejects(q.g.before({ ...NATIVE, chosen: chosenWith({ request: { graphics: { backend: "auto", require: { webgl: 2, webgpu: false, platforms: [] } } } }) }), /sets graphics requirements, and PairBrowse could not confirm/);
  // E7: a profile's screen other than the virtual screen names both; with a requirement unmet too, both in one refusal.
  const both = await p.g.before({ ...NATIVE, chosen: chosenWith({ measured: LINUX_MEASURED, request: { screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, devicePixelRatio: 1 },
    graphics: { backend: "auto", require: { webgl: null, webgpu: true, platforms: [] } } } }) }).catch((e) => e.message);
  assert.match(both, /Profile berlin sets a 1920x1080 screen but the virtual screen is 1366x768 \(virtualScreen\)\./);
  assert.match(both, /Profile berlin requires WebGPU but no adapter is available here \(requestAdapter returned null\)\./);
  assert.match(both, /Nothing was started\.$/);
  // Met: the same screen as the virtual one, WebGL2 there.
  const ok = await p.g.before({ ...NATIVE, chosen: chosenWith({ measured: LINUX_MEASURED, request: { screen: { width: 1366, height: 768, availWidth: 1366, availHeight: 768, colorDepth: 24, devicePixelRatio: 1 },
    graphics: { backend: "auto", require: { webgl: 2, webgpu: false, platforms: ["linux"] } } } }) });
  assert.equal(ok.source, "stored");
  // macOS: a legacy config.json GPU identity the measured Metal GPU can't back (U6), named.
  const macMeasured = measurement("probe-macos-metal", METAL, { display: "native" });
  const mac = part({ platform: "darwin", arch: "arm64", live: METAL, config: { pairbrowse: { gpuVendor: "NVIDIA Corporation" } } });
  await assert.rejects(mac.g.before({ ...NATIVE, screen: null, chosen: chosenWith({ measured: macMeasured }) }), /config\.json sets a GPU identity \(gpuVendor\) that this computer's hardware renderer cannot back\./);
});

test("after the start: a GPU over a software read, a backend other than measured, another runtime, requireValidatedProfiles", async () => {
  const macMeasured = measurement("probe-macos-metal", METAL, { display: "native" });
  const gpu = { request: { graphics: { backend: "gpu", require: null } } };
  // Measured hardware, but this start reads software: closed, named.
  const a = part({ platform: "darwin", arch: "arm64", live: { ...LLVMPIPE } });
  const planA = await a.g.before({ ...NATIVE, screen: null, chosen: chosenWith({ measured: macMeasured, ...gpu }) });
  const r = await a.g.after({}, planA, { chosen: chosenWith({ measured: macMeasured, ...gpu }), session: "shop" });
  assert.equal(r.ok, false);
  assert.match(r.refusal, /^Session "shop" doesn't start: Profile berlin asks for a GPU \(graphics\.backend: gpu\) but this computer renders in software/);
  assert.match(r.refusal, /The browser was closed before any tab loaded\.$/);
  // An unread backend with a GPU asked for: could not confirm.
  const b = part({ platform: "darwin", arch: "arm64", live: { kind: "unverified", vendor: null, device: null, renderer: null, driver: null, source: "systeminfo", reason: "x" } });
  const planB = await b.g.before({ ...NATIVE, screen: null, chosen: chosenWith({ measured: macMeasured, ...gpu }) });
  assert.match((await b.g.after({}, planB, { chosen: chosenWith(gpu) })).refusal, /could not confirm which renderer/);
  // The same GPU and driver (one runtime key) but another renderer than measured: backend.stable.
  const c = part({ platform: "darwin", arch: "arm64", live: { ...METAL, renderer: "Some Other Renderer" } });
  const planC = await c.g.before({ ...NATIVE, screen: null, chosen: chosenWith({ measured: macMeasured }) });
  const rc = await c.g.after({}, planC, { chosen: chosenWith() });
  assert.equal(rc.ok, false);
  assert.match(rc.refusal, /Profile berlin: measured hardware .* and this launch runs hardware \(Some Other Renderer\)\./);
  // Another driver (another runtime key): the measurement counts for nothing, is dropped with this
  // start's entry (replaceMeasured), and the next start measures again; the start goes on.
  const d = part({ live: { ...LLVMPIPE, driver: "23.0.0" } });
  const planD = await d.g.before({ ...NATIVE, chosen: chosenWith({ measured: LINUX_MEASURED }) });
  assert.deepEqual(await d.g.after({}, planD, { chosen: chosenWith() }), { ok: true });
  assert.equal(d.filed[0].entry.graphics, undefined);
  assert.equal(d.filed[0].entry.status, "unverified");
  assert.deepEqual(d.filed[0].opts, { build: BUILD, replaceMeasured: true });
  assert.ok(d.lines.some((l) => /graphics changed since they were measured .* measured again at the next start/.test(l)));
  assert.equal(GRAPHICS.status, "unverified");
  // requireValidatedProfiles: the entry for this runtime must be validated, else closed.
  const e = part({ live: { ...LLVMPIPE, driver: "23.0.0" }, config: { requireValidatedProfiles: true } });
  const planE = await e.g.before({ ...NATIVE, chosen: chosenWith({ measured: LINUX_MEASURED }) });
  assert.match((await e.g.after({}, planE, { chosen: chosenWith(), session: "shop" })).refusal, /Browser profile "berlin" is unverified on build 150\.0\.7871\.114 for this computer's graphics, and requireValidatedProfiles is on in config\.json\./);
});

test("a backend read that failed never drops a kept measurement; a probe that isn't kept isn't repeated in this helper run", async () => {
  const UNREAD = { kind: "unverified", vendor: null, device: null, renderer: null, driver: null, source: "systeminfo", reason: "the read took too long" };
  // A stored measurement and a read that timed out: kept (no replaceMeasured), nothing said about a change.
  const a = part({ live: UNREAD });
  const planA = await a.g.before({ ...NATIVE, chosen: chosenWith({ measured: LINUX_MEASURED }) });
  assert.equal((await a.g.after({}, planA, { chosen: chosenWith() })).ok, true);
  assert.deepEqual(a.filed[0].opts, { build: BUILD, replaceMeasured: false }, "an unverified read proves nothing changed");
  assert.ok(!a.lines.some((l) => /graphics changed/.test(l)));
  // A stored measurement of another driver: dropped once; the next start probes; that probe's key
  // doesn't match the browser either: not filed, and no probe again until the helper restarts.
  const other = { ...LLVMPIPE, driver: "23.0.0" };
  const b = part({ live: other, probe: async () => LINUX_MEASURED });
  const planB = await b.g.before({ ...NATIVE, chosen: chosenWith({ measured: LINUX_MEASURED }) });
  await b.g.after({}, planB, { chosen: chosenWith() });
  assert.deepEqual(b.filed[0].opts, { build: BUILD, replaceMeasured: true });
  const planB2 = await b.g.before({ ...NATIVE, chosen: chosenWith() });
  assert.equal(b.probes(), 1, "the dropped measurement is measured again at the next start");
  assert.equal(planB2.source, "probe");
  await b.g.after({}, planB2, { chosen: chosenWith() });
  assert.equal(b.filed[1].entry.graphics, undefined, "the probe's key isn't the browser's: not kept");
  assert.ok(b.lines.some((l) => /the measurement just made doesn't match this browser .* measured again when the helper next starts/.test(l)));
  const planB3 = await b.g.before({ ...NATIVE, chosen: chosenWith() });
  assert.equal(b.probes(), 1, "not probed again at every start");
  assert.equal(planB3.measured, null);
  assert.ok(b.lines.some((l) => /graphics unverified for this start: its measurement wasn't kept for this browser/.test(l)));
  await b.g.before({ ...NATIVE, chosen: chosenWith({ id: "p-fedcba9876543210" }) });
  assert.equal(b.probes(), 2, "another profile's runtime still measures");
  // A probe whose browser's read then fails: not kept either, and not repeated.
  let reads = 0;
  const c = part({ live: () => (reads++ ? LLVMPIPE : UNREAD), probe: async () => LINUX_MEASURED });
  const planC = await c.g.before({ ...NATIVE, chosen: chosenWith() });
  await c.g.after({}, planC, { chosen: chosenWith() });
  assert.deepEqual(c.filed[0].opts, { build: BUILD, replaceMeasured: false });
  await c.g.before({ ...NATIVE, chosen: chosenWith() });
  assert.equal(c.probes(), 1);
});

// Decision 10: on a host without a GPU the launch shows the engine's identity (GRAPHICS.shown, set
// by the native launch from the measurement before() hands it), the verdict for a measurement
// made under it is "consistent", requireValidatedProfiles takes that, and the status part, log
// and diagnostics say "shown as <identity>" (the engine's, never this computer's GPU).
test("a host without a GPU: the identity shown reaches the status part, the log and diagnostics; consistent counts as validated", async () => {
  const p = part({ config: { requireValidatedProfiles: true } });
  const chosen = chosenWith({ measured: WINDOWS_MEASURED });
  const plan = await p.g.before({ ...NATIVE, chosen });
  assert.equal(plan.measured.shown, GPU_LESS_IDENTITY.name);
  assert.equal(plan.measured.backend.kind, "software", "the backend handed to the launch's engine config (measuredBackend) is the host's");
  Object.assign(GRAPHICS, { shown: GPU_LESS_IDENTITY.name }); // as the native launch sets it from measuredBackend
  try {
    const r = await p.g.after({}, plan, { chosen, switches: [], session: "shop" });
    assert.deepEqual(r, { ok: true }, "consistent passes requireValidatedProfiles");
    assert.equal(p.filed[0].entry.status, "consistent", JSON.stringify(p.filed[0].entry.items.filter((i) => i.status === "mismatch" || i.status === "unverified")));
    assert.equal(GRAPHICS.status, "consistent");
    assert.deepEqual(p.g.statusParts(), [`Graphics: software (${LLVMPIPE.renderer.slice(0, 80)}), shown as Windows 11 with NVIDIA GeForce RTX 3060, requested auto, consistent on ${BUILD}`]);
    assert.equal(p.g.statusParts({ remote: true })[0], `Graphics: software, shown as Windows 11 with NVIDIA GeForce RTX 3060, requested auto, consistent on ${BUILD}`);
    assert.deepEqual(p.g.summary(), { kind: "software", status: "consistent", shown: "Windows 11 with NVIDIA GeForce RTX 3060" });
    assert.ok(p.lines.some((l) => l === `launch: graphics: software, shown as Windows 11 with NVIDIA GeForce RTX 3060, consistent on ${BUILD}`), p.lines.join("\n"));
    // An older build's Linux identity (the Intel UHD 770 under the engine's Linux persona): the same, named as it is.
    const older = part({ config: { requireValidatedProfiles: true } });
    const olderMeasured = measuredRecord({ ...LINUX_MEASURED, shown: LINUX_IDENTITY.name, webgl: { ...LINUX_MEASURED.webgl, unmaskedVendor: "Google Inc. (Intel)", unmaskedRenderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 770 (RPL-S), OpenGL 4.6 (Core Profile) Mesa 23.2.1)" },
      webgl2: { ...LINUX_MEASURED.webgl2, unmaskedVendor: "Google Inc. (Intel)", unmaskedRenderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 770 (RPL-S), OpenGL 4.6 (Core Profile) Mesa 23.2.1)" } });
    const olderChosen = chosenWith({ measured: olderMeasured });
    const olderPlan = await older.g.before({ ...NATIVE, chosen: olderChosen });
    GRAPHICS.shown = LINUX_IDENTITY.name;
    assert.deepEqual(await older.g.after({}, olderPlan, { chosen: olderChosen, switches: [], session: "shop" }), { ok: true });
    assert.deepEqual(older.g.summary(), { kind: "software", status: "consistent", shown: "Intel UHD Graphics 770" });
    // The same launch without the identity shown (the real strings measured): validated, no "shown as".
    GRAPHICS.shown = null;
    const real = part();
    const planReal = await real.g.before({ ...NATIVE, chosen: chosenWith({ measured: LINUX_MEASURED }) });
    await real.g.after({}, planReal, { chosen: chosenWith({ measured: LINUX_MEASURED }), switches: [], session: "shop" });
    assert.deepEqual(real.g.summary(), { kind: "software", status: "validated" });
    assert.ok(!real.g.statusParts()[0].includes("shown as"));
  } finally { GRAPHICS.shown = null; }
});

test("the status part and diagnostics: kind and status only in a report, never the renderer or IDs (row E-3)", async () => {
  assert.equal(graphicsStatusPart({ kind: "hardware", renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro)", requested: "gpu", status: "failed" }, { build: BUILD }),
    `Graphics: hardware (ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro)), requested gpu, failed on ${BUILD}`);
  assert.equal(graphicsStatusPart({ kind: "odd", renderer: "x", requested: "metal", status: "maybe" }), "Graphics: unverified, requested auto, unverified on PairBrowse as an extension");
  assert.deepEqual(graphicsSummary({ kind: "hardware", status: "validated", renderer: "Apple M4 Pro", vendor: 4203, device: 1 }), { kind: "hardware", status: "validated" });
  assert.equal(graphicsSummary(null), null);
  const d = createDiagnostics({ version: "1", logFile: join(dir, "none.log"), home: dir, browser: async () => ({ engine: "pairbrowse", version: BUILD, build: BUILD }),
    graphics: () => ({ kind: "hardware", status: "failed", renderer: "Apple M4 Pro", vendor: 4203, device: 1 }) });
  const read = await d.read();
  assert.deepEqual(read.browser.graphics, { kind: "hardware", status: "failed" });
  const text = d.reportText(read);
  assert.match(text, /^Graphics: hardware, failed$/m);
  assert.ok(!/M4|4203/.test(JSON.stringify(read) + text), "no GPU model or ID");
  // A host without a GPU: the identity shown is the engine's, so a report names it (decision 10).
  assert.deepEqual(graphicsSummary({ kind: "software", status: "consistent", renderer: "llvmpipe (LLVM 15)", shown: GPU_LESS_IDENTITY.name }), { kind: "software", status: "consistent", shown: "Windows 11 with NVIDIA GeForce RTX 3060" });
  assert.deepEqual(graphicsSummary({ kind: "software", status: "consistent", shown: LINUX_IDENTITY.name }), { kind: "software", status: "consistent", shown: "Intel UHD Graphics 770" }, "an older build's identity");
  assert.deepEqual(graphicsSummary({ kind: "software", status: "validated", shown: "Zq GPU 9000" }), { kind: "software", status: "validated" }, "an identity PairBrowse doesn't know isn't repeated");
  const gpuLess = createDiagnostics({ version: "1", logFile: join(dir, "none.log"), home: dir, browser: async () => ({ engine: "pairbrowse", version: BUILD, build: BUILD }),
    graphics: () => ({ kind: "software", status: "consistent", renderer: "llvmpipe (LLVM 15)", shown: GPU_LESS_IDENTITY.name }) });
  const readGpuLess = await gpuLess.read();
  const textGpuLess = gpuLess.reportText(readGpuLess);
  assert.match(textGpuLess, /^Graphics: software rendering, shown as Windows 11 with NVIDIA GeForce RTX 3060, consistent$/m);
  assert.ok(!/llvmpipe/.test(JSON.stringify(readGpuLess) + textGpuLess), "never the renderer");
  const none = createDiagnostics({ version: "1", logFile: join(dir, "none.log"), home: dir });
  assert.match(none.reportText(await none.read()), /^Graphics: not read$/m);
});

// sessions/profiles.mjs: the forLaunch answer carries the request and the kept measurement; a
// launch's verdict and an install self-check's filed with the profile, its status following.
test("forLaunch hands the graphics steps the request and the measurement kept for this pack; verdicts filed with the profile", () => {
  const store = createProfileStore({ dir: join(dir, "store-a"), now: () => T0 });
  const lines = [];
  const st = {};
  const profiles = createProfiles(st, { config: {}, log: (l) => lines.push(l), profileStore: store, now: () => T0, platform: "linux" });
  const berlin = store.create({ name: "berlin", locale: { languages: ["de-DE"], timezone: "Europe/Berlin", source: "set" }, graphics: { backend: "gpu", require: null } });
  createSession("lg-one");
  assignProfile("lg-one", "berlin", { store });
  const chosen = profiles.forLaunch("lg-one", { browserKind: "pairbrowse", build: BUILD, pack: PACK });
  assert.deepEqual(chosen.request, { graphics: { backend: "gpu", require: null }, screen: null, window: null, locale: { timezone: "Europe/Berlin", languages: ["de-DE"] } });
  assert.equal(chosen.measured, null, "nothing measured yet");
  assert.ok(chosen.results.some((i) => i.field === "graphics.backend" && i.status === "applied"), "a GPU request now maps (checked at launch)");
  // A verdict with its measurement replaces the launch's entry; the status follows.
  const entry = { status: "failed", at: "2026-10-21T10:00:00.000Z", pack: PACK, runtimeKey: LINUX_MEASURED.runtimeKey, graphics: LINUX_MEASURED,
    items: [{ field: "webgl.strings", rule: "gpu.software-as-hardware", class: "M", status: "mismatch", requested: null, measured: "x", severity: "error", reason: "pages read a hardware GPU" }] };
  assert.equal(profiles.fileValidation(entry, { build: BUILD }), "failed");
  assert.equal(store.get(berlin.id).validation[BUILD].runtimeKey, LINUX_MEASURED.runtimeKey);
  assert.equal(store.get(berlin.id).revision, 1, "evidence, no new revision");
  assert.match(profiles.statusParts()[0], /^Profile: berlin \(rev 1, failed on 150\.0\.7871\.114\)$/);
  assert.deepEqual(profiles.coherence().map((i) => i.id), ["gpu.software-as-hardware"]);
  // The next launch reads it back as the measurement kept for this pack (not for another pack).
  assert.deepEqual(profiles.forLaunch("lg-one", { browserKind: "pairbrowse", build: BUILD, pack: PACK }).measured, LINUX_MEASURED);
  assert.equal(profiles.forLaunch("lg-one", { browserKind: "pairbrowse", build: BUILD, pack: "0".repeat(64) }).measured, null);
  profiles.forLaunch("lg-one", { browserKind: "pairbrowse", build: BUILD, pack: PACK });
  // A launch's own entry (forLaunch's recordLaunch) leaves a measured one alone; one of another
  // runtime (replaceMeasured) replaces it, so the next start measures again.
  assert.equal(store.get(berlin.id).validation[BUILD].status, "failed");
  const plain = { status: "unverified", at: "2026-10-21T10:01:00.000Z", pack: PACK, items: [] };
  profiles.fileValidation(plain, { build: BUILD });
  assert.equal(store.get(berlin.id).validation[BUILD].status, "failed", "kept without replaceMeasured");
  assert.equal(profiles.fileValidation(plain, { build: BUILD, replaceMeasured: true }), "unverified");
  assert.equal(store.get(berlin.id).validation[BUILD].graphics, undefined);
  assert.equal(profiles.forLaunch("lg-one", { browserKind: "pairbrowse", build: BUILD, pack: PACK }).measured, null);
  // An install self-check's measurement goes to the config-backed default.
  assert.equal(profiles.fileSelfCheck(LINUX_MEASURED, { build: BUILD, pack: PACK, virtualScreen: { width: 1366, height: 768 } }), true);
  const def = store.use("default", { configSettings: profiles.configSettings(true) });
  assert.equal(def.validation[BUILD].runtimeKey, LINUX_MEASURED.runtimeKey);
  assert.ok(["validated", "failed", "unverified"].includes(def.validation[BUILD].status));
  assert.ok(lines.some((l) => /the install check's graphics kept with browser profile "default"/.test(l)));
  assert.equal(profiles.fileSelfCheck(null, { build: BUILD }), false);
});

// The install self-check's probe starts with the default's mapped switches (its graphics backend
// among them), and its measurement is filed with browserArgs and those, as the launch passes them.
test("an install self-check measures with the default profile's switches, and is filed with them", () => {
  const store = createProfileStore({ dir: join(dir, "store-self"), now: () => T0 });
  const profiles = createProfiles({}, { config: { pairbrowse: { graphics: "software" }, browserArgs: ["--lang=en-US"] }, log: () => {}, profileStore: store, now: () => T0, platform: "linux" });
  const args = profiles.selfCheckArgs();
  assert.ok(args.includes(SOFTWARE_SWITCH), `the software backend's switch: ${args.join(" ")}`);
  assert.equal(profiles.fileSelfCheck(LINUX_MEASURED, { build: BUILD, pack: PACK, virtualScreen: { width: 1366, height: 768 } }), true);
  const src = readFileSync(new URL("../scripts/daemon/sessions/profiles.mjs", import.meta.url), "utf8");
  assert.match(src.slice(src.indexOf("function fileSelfCheck(")), /switches: \[\.\.\.userArgs, \.\.\.mapped\.switches\]/);
  const check = readFileSync(new URL("../scripts/native/install.mjs", import.meta.url), "utf8");
  assert.match(check, /check\(d\.exec, \{ config: using, log, \.\.\.\(onGraphics \? \{ onGraphics \} : \{\}\), \.\.\.\(profileArgs \? \{ profileArgs \} : \{\}\) \}\)/);
});

test("cli.mjs validate measures each profile in a probe browser of its own and keeps the verdict", async () => {
  const store = createProfileStore({ dir: join(dir, "store-cli"), now: () => T0 });
  store.create({ name: "linuxbox" });
  let out = "", err = "", asked = null;
  const measure = async (exec, o) => { asked = { exec, ...o }; return { measured: LINUX_MEASURED, line: "graphics: software, WebGL 2, WebGPU unavailable", virtualScreen: { width: 1366, height: 768 } }; };
  const run = (m) => runProfilesCli(["validate", "linuxbox"], { out: { write: (s) => { out += s; } }, err: { write: (s) => { err += s; } }, store, config: { browser: "pairbrowse" }, native: true,
    build: { build: BUILD, pack: PACK, exec: "/opt/pairbrowse/pairbrowse" }, running: () => false, now: () => T0, platform: "linux", measure: m });
  assert.equal(await run(measure), 0, err);
  assert.equal(asked.exec, "/opt/pairbrowse/pairbrowse");
  assert.equal(asked.engineLayer.graphics, "auto");
  assert.equal(asked.engineLayer.geoip, false, "a probe never looks up a region");
  assert.match(out, /^linuxbox: applies on build 150\.0\.7871\.114; measuring its graphics\.\nlinuxbox: validated on build 150\.0\.7871\.114 \(graphics: software, WebGL 2, WebGPU unavailable\)/);
  const kept = store.get("linuxbox").validation[BUILD];
  assert.equal(kept.runtimeKey, LINUX_MEASURED.runtimeKey, "the measurement kept as evidence");
  assert.equal(store.get("linuxbox").revision, 1);
  // A measurement that couldn't be made: exit 1, said, the profile stays unverified.
  err = "";
  const store2 = createProfileStore({ dir: join(dir, "store-cli-2"), now: () => T0 });
  store2.create({ name: "linuxbox" });
  const code = await runProfilesCli(["validate", "linuxbox"], { out: { write: () => {} }, err: { write: (s) => { err += s; } }, store: store2, config: { browser: "pairbrowse" }, native: true,
    build: { build: BUILD, pack: PACK, exec: "/x" }, running: () => false, now: () => T0, platform: "linux", measure: async () => ({ measured: null, line: "graphics: unverified (not measured: it took longer than 120 s)" }) });
  assert.equal(code, 1);
  assert.match(err, /linuxbox: graphics: unverified \(not measured: it took longer than 120 s\); it stays unverified\./);
  assert.equal(store2.get("linuxbox").validation[BUILD].status, "unverified");
});

test("launch.mjs: step 4 before the browser starts, step 7 after the network check and before any tab; a self-check's measurement filed", () => {
  const src = readFileSync(new URL("../scripts/daemon/browser/launch.mjs", import.meta.url), "utf8");
  const launch = src.slice(src.indexOf("  async function launch() {"), src.indexOf("  function getContext("));
  const at = (s) => { const i = launch.indexOf(s); assert.ok(i > 0, s); return i; };
  assert.ok(at("api.profiles.forLaunch(") < at("network.forLaunch(") && at("network.forLaunch(") < at("graphics.before("), "steps 2, 3, 4 in order: a network refusal never waits for a probe");
  assert.ok(at("try {") < at("network.forLaunch(") && at("graphics.before(") < at("finally { net?.drop();"), "the auth file is dropped whatever stops the launch, the graphics step included");
  assert.ok(at("graphics.before(") < at("prepareProfile(profile()") && at("graphics.before(") < at("writeHelperKeyFile(") && at("graphics.before(") < at("launchEngine(browserType()"),
    "step 4: before any preference, key file or the start");
  assert.match(launch, /probeLaunch: native \? probeLauncher\(\{ chromium: browserType\(\), engine: \{ \.\.\.next, browserProfile: \{ \.\.\.chosen\.engine, geoip: false \} \}, config, shell: st\.shell, screen, env: process\.env, executablePath: next\.executablePath, profileArgs: chosen\.switches, server: api\.isServer\(\), log \}\) : null/,
    "the probe starts as this launch would (the profile's engine layer and switches, the screen, the sandbox rule), never with geoip");
  const ctxFn = src.slice(src.indexOf("  function getContext("), src.indexOf("  // The browser, once saved tabs are back."));
  assert.match(ctxFn, /const busy = \(measured = st\.probing\) => new Error\(measured \? MEASURING_BUSY : /, "a call waiting on a probe hears so");
  assert.match(ctxFn, /if \(waitMeasuring && !st\.installing\) return throughMeasurement\(st\.contextPromise, \{ st, waiters: installWaiters, ms: deps\.measuringWaitMs \?\? MEASURING_WAIT_MS, onMeasuring, busy \}\);\n\s+if \(st\.installing \|\| st\.probing\) return Promise\.reject\(busy\(\)\);/,
    "an agent's session switch waits through a measurement (bounded); every other call hears it at once");
  assert.match(src, /createGraphics\(st, deps, \{ \.\.\.api, onProbing: tellWaiters \}\)/, "a probe that starts tells the calls already waiting");
  assert.ok(at("network.checkAtLaunch(") < at("graphics.after(") && at("graphics.after(") < at("net.started()") && at("graphics.after(") < at("api.restore("), "step 7: after step 6, before any tab");
  const refused = launch.slice(at("if (!drawn.ok) {"), at('step("graphics read")'));
  assert.match(refused, /await within\(5000, ctx\.close\(\)\.catch\(\(\) => \{\}\)\);\n\s+dropHelperKey\(keyFile, captureKeyFile\);\n\s+throw new Error\(drawn\.refusal\);/, "a refusal closes the browser, bounded");
  assert.ok(at("graphics.after(") < at('ctx.on("close"'), "before the close handler: no crash for the guard");
  assert.match(src, /ensureNativeBuild\(installLog, \{ asset, config, onGraphics: \(m\) => \{ checked = m; \}, profileArgs: api\.profiles\.selfCheckArgs\?\.\(\) \?\? \[\] \}\)/, "the self-check's probe starts with the default's switches");
  assert.match(src, /api\.profiles\.fileSelfCheck\(checked, \{ build, pack: NATIVE\.engine\.sha256,/);
  assert.match(src, /api\.profiles\.release\(\); graphics\.release\(\);/, "the status part ends with the browser");
});

test("an agent's session switch waits through a measurement, bounded, and hears an install at once", async () => {
  // The bound: the probe's worst case and a minute for the start after it, under the 10-minute turn cap.
  assert.equal(MEASURING_WAIT_MS, GRAPHICS_TIMEOUT_MS + GRAPHICS_STOP_MS + 60_000);
  assert.ok(MEASURING_WAIT_MS < 10 * 60_000);
  const busy = () => new Error("busy");
  // A measurement under way: waited for, onMeasuring once, the start's answer, the waiter gone.
  const st = { probing: true, installing: false };
  const waiters = new Set();
  let told = 0, resolve;
  const started = new Promise((r) => { resolve = r; });
  const waiting = throughMeasurement(started, { st, waiters, ms: 5000, onMeasuring: () => told++, busy });
  assert.equal(waiters.size, 1);
  for (const w of waiters) w(); // the probe's start tells the waiters again: still once
  setTimeout(() => { st.probing = false; resolve("ctx"); }, 20);
  assert.equal(await waiting, "ctx");
  assert.deepEqual([told, waiters.size], [1, 0]);
  // A measurement that starts while it waits is noted too.
  const st2 = { probing: false, installing: false };
  const w2 = new Set();
  let told2 = 0, resolve2;
  const p2 = throughMeasurement(new Promise((r) => { resolve2 = r; }), { st: st2, waiters: w2, ms: 5000, onMeasuring: () => told2++, busy });
  assert.equal(told2, 0);
  st2.probing = true;
  for (const w of w2) w();
  resolve2("ctx2");
  assert.equal(await p2, "ctx2");
  assert.equal(told2, 1);
  // Past the bound: the measurement's retry message (busy(true)), the waiter gone.
  const w3 = new Set();
  const said = (measured) => new Error(measured ? "measuring" : "installing");
  await assert.rejects(throughMeasurement(new Promise(() => {}), { st: { probing: true, installing: false }, waiters: w3, ms: 20, busy: said }), /^Error: measuring$/);
  assert.equal(w3.size, 0);
  // No measurement: no limit, as every start is waited for (never the install message for a slow start).
  let resolve5;
  const p5 = throughMeasurement(new Promise((r) => { resolve5 = r; }), { st: { probing: false, installing: false }, waiters: new Set(), ms: 20, busy: said });
  let early = null;
  p5.then((v) => { early = v; }, (e) => { early = e; });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(early, null, "still waiting past ms with no measurement");
  resolve5("ctx5");
  assert.equal(await p5, "ctx5");
  // A measurement that starts late: the bound runs from its start, not from the call.
  const st6 = { probing: false, installing: false };
  const w6 = new Set();
  let resolve6;
  const p6 = throughMeasurement(new Promise((r) => { resolve6 = r; }), { st: st6, waiters: w6, ms: 60, busy: said });
  await new Promise((r) => setTimeout(r, 50));
  st6.probing = true;
  for (const w of w6) w();
  setTimeout(() => resolve6("ctx6"), 30); // 80 ms after the call, 30 ms into the measurement
  assert.equal(await p6, "ctx6");
  // An install that begins meanwhile: busy at once.
  const st4 = { probing: false, installing: false };
  const w4 = new Set();
  const p4 = throughMeasurement(new Promise(() => {}), { st: st4, waiters: w4, ms: 60_000, busy });
  st4.installing = true;
  for (const w of w4) w();
  await assert.rejects(p4, /^Error: busy$/);
  // A start that fails: its own error.
  await assert.rejects(throughMeasurement(Promise.reject(new Error("refused")), { st: { probing: true, installing: false }, waiters: new Set(), ms: 5000, busy }), /refused/);
});
