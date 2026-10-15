// Launches the native PairBrowse browser with the engine pack (native-pack.mjs): its fingerprint,
// persona and launch switches (humanized input: native/humanize.mjs). Settings come from "pairbrowse"
// in config.json. Its path is fixed: the Pro repo's engine test reads the pack calls made here.
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { NATIVE } from "./native-pack.mjs";
import { paths } from "./paths.mjs";
import { within, writeJsonAtomic } from "./util.mjs";
import { TYPING_PACE, clampPace } from "./native/humanize.mjs";

// Humanized typing and form fills live in native/humanize.mjs; re-exported for older importers.
export * from "./native/humanize.mjs";

const CHROMIUM_MAJOR = NATIVE.version.split(".")[0];
// Options this engine can't honour: refused, never silently ignored.
const UNSUPPORTED = ["version", "autoUpdate", "pro", "licenseThroughProxy", "shaderDialect", "widevine", "socks5Udp", "transparentProxy",
  "allowThirdPartyCookies", "fingerprintSchema", "personaSchema", "realGpuHost"];
const GEOIP_FIELDS = ["timezone", "acceptLanguage", "webrtcIp", "location"];
const PLATFORM = { darwin: "macos", linux: "linux", win32: "windows" }[process.platform];

// The build manifest of a native PairBrowse browser: in the app's Resources on macOS
// (PairBrowse.app/Contents/MacOS/pairbrowse), next to chrome / chrome.exe on Linux and Windows.
export function nativeManifest(executablePath) {
  const mac = /\.app$/.test(dirname(dirname(dirname(executablePath))));
  const contents = dirname(dirname(executablePath));
  const metadata = JSON.parse(readFileSync(mac ? join(contents, "Resources", "PairBrowse-build.json") : join(dirname(executablePath), "PairBrowse-build.json"), "utf8"));
  if (metadata.product !== "PairBrowse" || metadata.version?.split(".")[0] !== CHROMIUM_MAJOR || !/^\d+\.\d+\.\d+\.\d+$/.test(metadata.version)) {
    throw new Error(`PairBrowse native requires a Chromium ${CHROMIUM_MAJOR} PairBrowse build.`);
  }
  if (mac && !existsSync(join(contents, "Frameworks", "Chromium Framework.framework"))) {
    throw new Error("PairBrowse app is incomplete: Chromium Framework is missing.");
  }
  if (!mac && !["linux", "windows"].includes(metadata.platform)) throw new Error("PairBrowse build manifest names no platform.");
  return metadata;
}

// The build manifest's `chrome` field: the protocol level of the browser's own pages (1 =
// chrome://pairbrowse and chrome://pairbrowse.top-chrome pages reading --pairbrowse-helper).
// Absent in today's builds: then the side panel extension takes their place.
export const chromePages = (manifest) => Number.isInteger(manifest?.chrome) && manifest.chrome >= 1;
// The build manifest's `capture` field: the browser's own capture page (a tab's picture and sound
// for joiners, recordings; liveview/capture.mjs) is there. Absent: a shared browser sends pictures
// through the join channel and recording is refused (daemon/capture.mjs).
export const capturePages = (manifest) => Number.isInteger(manifest?.capture) && manifest.capture >= 1;
// `capture` 2 and up: the capture page reads its own key from the file --pairbrowse-capture-key-file
// names and sends it (ck) on its stream and its replies; the helper then requires it.
export const captureKeyed = (manifest) => Number.isInteger(manifest?.capture) && manifest.capture >= 2;

// A command's output, trimmed, or "" when it fails or takes over 10 s. Never execFileSync here:
// the helper serves its live view and every other caller while these run.
const output = (file, args) => new Promise((resolve) => {
  execFile(file, args, { encoding: "utf8", timeout: 10_000 }, (error, stdout) => resolve(error ? "" : String(stdout).trim()));
});

// The primary display as Chromium reports it, so the hidden capture sees the real screen, not
// headless's 800x600. Chromium on macOS reports 30-bit color on EDR (XDR) displays.
async function macScreen() {
  const script = 'ObjC.import("AppKit"); const s = $.NSScreen.screens.objectAtIndex(0); const f = s.frame, v = s.visibleFrame;'
    + ' JSON.stringify({ width: f.size.width, height: f.size.height, top: f.size.height - v.origin.y - v.size.height, bottom: v.origin.y,'
    + ' scale: s.backingScaleFactor, edr: s.maximumPotentialExtendedDynamicRangeColorComponentValue })';
  try {
    const screen = JSON.parse(await output("osascript", ["-l", "JavaScript", "-e", script]));
    return screen.width > 0 && screen.scale > 0 ? screen : null;
  } catch { return null; }
}

// --screen-info takes physical pixels; work area insets are the menu bar (top) and the Dock (bottom).
export function screenInfoArg(screen) {
  const px = (value) => Math.round(value * screen.scale);
  return `--screen-info={0,0 ${px(screen.width)}x${px(screen.height)} colorDepth=${screen.edr > 1 ? 30 : 24} devicePixelRatio=${screen.scale}`
    + ` workAreaTop=${px(screen.top)} workAreaBottom=${px(screen.bottom)}}`;
}

// A software renderer means the capture missed the real GPU: never keep that as this Mac's profile.
const SOFTWARE_GL = /swiftshader|llvmpipe|software|basic render/i;
function webglRenderer(captured) {
  const text = JSON.stringify(captured?.webgl ?? {});
  return text.match(/"UNMASKED_RENDERER_WEBGL":"([^"]*)"/)?.[1] ?? captured?.webgl?.renderer ?? null;
}

// This Mac's real fingerprint, read by the engine pack's collector in a throwaway browser that
// sees the real GPU (the browser itself always runs seeded). It runs headless, so no window or
// Dock icon appears: headless on macOS still renders WebGL and WebGPU with Metal on the real GPU,
// and the real screen is passed in. null when nothing came back.
// Each step is bounded (CAPTURE_STEP_MS): a capture that hangs fails the launch with its reason
// instead of holding it forever.
const CAPTURE_STEP_MS = 90_000;
export async function captureMacHost(chromium, executablePath, pack, directory, screen, stepMs = CAPTURE_STEP_MS) {
  let browser, server, captureDirectory;
  if (screen === undefined) screen = await macScreen();
  const step = async (what, promise) => {
    const done = await within(stepMs, promise.then((value) => ({ value })));
    if (!done) throw new Error(`${what} took over ${stepMs / 1000} s`);
    return done.value;
  };
  try {
    // The collector comes with the engine pack, checked against its pin when the pack is loaded.
    if (typeof pack.collector !== "string") throw new Error("the engine pack has no host collector");
    captureDirectory = mkdtempSync(join(directory, ".mac-host-capture-"));
    const launching = Promise.resolve(chromium.launchPersistentContext(captureDirectory, { headless: true, viewport: null, executablePath, chromiumSandbox: true,
      ignoreDefaultArgs: pack.DEFAULT_IGNORED_ARGS,
      args: ["--disable-extensions", "--disable-gpu-fingerprint", "--window-size=1200,960", ...(screen ? [screenInfoArg(screen)] : [])] }));
    // A launch that comes back after its time is up is closed all the same.
    let gaveUp = false;
    launching.then((late) => { if (gaveUp) Promise.resolve(late?.close?.()).catch(() => {}); }, () => {});
    try { browser = await step("the hidden browser's start", launching); } catch (error) { gaveUp = true; throw error; }
    const page = browser.pages?.()[0] ?? await step("the capture tab", Promise.resolve(browser.newPage()));
    if (page.goto) {
      server = createServer((_, response) => response.end("<!doctype html><title>PairBrowse host capture</title>"));
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      await step("the capture page", page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "domcontentloaded" }));
    }
    // The engine pack's collector (SHA-256 checked before load), run in this throwaway local page.
    // eslint-disable-next-line no-eval
    const captured = await step("the collector", page.evaluate((source) => { (0, eval)(source); return globalThis.collectFingerprint(); }, pack.collector));
    if (!captured || typeof captured !== "object") return null;
    const renderer = webglRenderer(captured);
    if (renderer && SOFTWARE_GL.test(renderer)) throw new Error(`the capture got a software WebGL renderer (${renderer}), not this Mac's GPU`);
    // Headless keeps 8 bits per component whatever --screen-info says; a 30-bit screen has 10.
    if (screen?.edr > 1 && captured.css && typeof captured.css.color === "number") captured.css.color = 10;
    // The engine's profile import uses these two compact forms; the collector reports the long ones.
    if (captured.media_devices && !captured.mediaDevices) captured.mediaDevices = captured.media_devices;
    if (captured.webgpu?.info && !captured.webgpu.vendor) captured.webgpu = { ...captured.webgpu.info, limits: captured.webgpu.limits };
    return captured;
  } catch (error) {
    throw new Error(`PairBrowse macOS host capture failed: ${error.message}`, { cause: error });
  } finally {
    try { await within(10_000, Promise.resolve(browser?.close?.())); } catch {}
    try { if (server) await new Promise((resolve) => server.close(() => resolve())); } catch {}
    if (captureDirectory) rmSync(captureDirectory, { recursive: true, force: true });
  }
}

// What the captured profile depends on: the browser build and this Mac's model and GPUs. A new
// build or other hardware (a migrated home folder, an eGPU) captures again.
// Read once per helper run (ioreg takes a few hundred ms; every launch asks).
let hardwareRead = null;
export function macHardware() {
  hardwareRead ??= (async () => {
    const [model, io] = await Promise.all([output("/usr/sbin/sysctl", ["-n", "hw.model"]), output("/usr/sbin/ioreg", ["-rd1", "-c", "IOAccelerator"])]);
    const gpus = io.split("\n").filter((line) => /"(model|IOClass)" =/.test(line)).map((line) => line.trim()).join(";");
    if (!model) hardwareRead = null; // a failed read is asked again next time
    return `${model}|${gpus}`;
  })();
  return hardwareRead;
}

// Logged (launchNative's log) as this Mac's capture starts: the helper's status says what the
// first launch waits for (daemon/context.mjs).
export const MEASURING = "launch: measuring this Mac once (the first start of this browser version)";

export function hostCachePath() {
  return paths.hostProfile;
}

// The capture runs once per Mac: every new profile (sessions, clean sessions, tests) reuses it.
// Kept private (0600) in the PairBrowse home; a stale or unreadable cache just captures again.
// onCapture(): called when the cache misses, before the capture (it takes up to a minute: the
// helper says so, daemon/context.mjs). Two launches at once share one capture.
let capturing = null; // { key, promise }
export async function macHostProfile(chromium, executablePath, pack, directory, version, hardware = macHardware, onCapture = () => {}) {
  const file = hostCachePath();
  const key = createHash("sha256").update(JSON.stringify({ version, hardware: await hardware() })).digest("hex");
  try {
    const cached = JSON.parse(readFileSync(file, "utf8"));
    if (cached.key === key && cached.profile && typeof cached.profile === "object") return cached.profile;
  } catch {}
  if (capturing?.key === `${file}\n${key}`) return capturing.promise;
  try { onCapture(); } catch {}
  const promise = captureAndKeep(chromium, executablePath, pack, directory, file, key, version);
  capturing = { key: `${file}\n${key}`, promise };
  try { return await promise; } finally { if (capturing?.promise === promise) capturing = null; }
}

async function captureAndKeep(chromium, executablePath, pack, directory, file, key, version) {
  const profile = await captureMacHost(chromium, executablePath, pack, directory);
  if (!profile) return null;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeJsonAtomic(file, { key, version, profile }, { mode: 0o600 });
  } catch {}
  return profile;
}

// The three layers of settings, lowest first: the persona saved in the profile, a saved profile
// chosen by name, and config.json. Every layer is checked for options this engine can't honour.
function readSettings(config, pack, personaPath) {
  // motion: how humanized mouse moves are shaped: "combined" (the profile's own speed, tremor and
  // habits, in PairBrowse's hand-like shape: one reach that lands close, then homes in without
  // stopping), "quick" (the same shape, a short hop between fields in about half the time, a long
  // reach as before) or "classic" (the engine's own). Every click still lands exactly on its point.
  // An engine pack without "combined" uses its own. formMove is PairBrowse's own (fillSettings), not the engine's.
  const { profile: selection, profileSelect = {}, humanize = true, showCursor = false, geoip = false, typingPace = TYPING_PACE, motion: motionSetting = "combined", formMove, ...overrides } = config.pairbrowse ?? {};
  void formMove;
  const motion = ["classic", "quick"].includes(motionSetting) ? motionSetting : "combined";
  const saved = selection && !["auto", "local"].includes(selection) ? pack.resolveProfileOptions(selection) : {};
  const persisted = existsSync(personaPath) ? pack.Profile.load(personaPath).options : {};
  for (const key of UNSUPPORTED) {
    if ([persisted, saved, overrides].some((layer) => layer[key] !== undefined)) throw new Error(`PairBrowse native does not support pairbrowse.${key} on this engine.`);
  }
  return { selection, profileSelect, humanize, showCursor, geoip, typingPace: clampPace(typingPace), motion, overrides, saved, persisted };
}

// The fingerprint to launch with: the layered settings, then a persona (picked, or this Mac's own
// captured once per Mac), the seed, and the region (geoip, else this computer's time zone and language).
async function resolveFingerprint(chromium, options, pack, directory, settings, version, log = () => {}) {
  const { selection, profileSelect, geoip, overrides, saved, persisted } = settings;
  const { fingerprint, rest } = pack.splitFingerprintOptions({ ...persisted, ...saved, ...overrides });
  if (fingerprint.fingerprint === "off") throw new Error(`Fingerprint passthrough needs a newer PairBrowse engine; Chromium ${CHROMIUM_MAJOR} treats off as a seed.`);
  fingerprint.platform ??= PLATFORM;
  fingerprint.brandVersion ??= version;
  const picksPersona = selection === "auto" || selection === "local";
  let source = null;
  const steps = [];
  if (picksPersona) {
    const measureAt = Date.now();
    const host = await pack.measureHost((probe) => chromium.launch({ ...probe, executablePath: options.executablePath, chromiumSandbox: options.chromiumSandbox, ignoreDefaultArgs: pack.DEFAULT_IGNORED_ARGS }),
      options.executablePath, Number(CHROMIUM_MAJOR));
    const resolved = selection === "local" ? pack.resolveLocal(host, profileSelect) : await pack.resolveAuto(host, profileSelect);
    fingerprint.fingerprintProfile = resolved.profile;
    source = resolved.source;
    steps.push(`measure ${Date.now() - measureAt} ms`);
  }
  let hostCapture = false;
  if (fingerprint.fingerprintProfile === undefined) {
    fingerprint.fingerprint ??= createHash("sha256").update(directory).digest("hex");
    if (process.platform === "darwin") {
      const hostAt = Date.now();
      fingerprint.fingerprintProfile = await macHostProfile(chromium, options.executablePath, pack, directory, version, macHardware, () => log(MEASURING));
      steps.push(`host capture ${Date.now() - hostAt} ms`);
      if (!fingerprint.fingerprintProfile) throw new Error("PairBrowse macOS host capture failed; provide an explicit fingerprintProfile.");
      hostCapture = true;
    }
  }
  if (fingerprint.fingerprintProfile !== undefined) {
    // A seed carried over from before must not farble a newly chosen profile.
    const newProfile = picksPersona || saved.fingerprintProfile !== undefined || overrides.fingerprintProfile !== undefined;
    const keptSeed = persisted.fingerprint !== undefined && !newProfile;
    if (!hostCapture && !keptSeed && overrides.fingerprint === undefined && saved.fingerprint === undefined) delete fingerprint.fingerprint;
  }
  if (geoip) {
    for (const key of GEOIP_FIELDS) if (overrides[key] === undefined && saved[key] === undefined) delete fingerprint[key];
    await pack.applyGeoip(fingerprint, options.proxy ?? rest.proxy, false);
  }
  fingerprint.timezone ??= Intl.DateTimeFormat().resolvedOptions().timeZone;
  fingerprint.acceptLanguage ??= Intl.DateTimeFormat().resolvedOptions().locale;
  return { fingerprint, rest, source, steps };
}

// Only the fingerprint is kept with the profile: never proxy credentials, agent keys or bridge auth.
function savePersona(pack, personaPath, fingerprint) {
  const persona = { ...fingerprint };
  if (persona.canvasBridge?.auth) {
    const { auth, ...bridge } = persona.canvasBridge;
    persona.canvasBridge = bridge;
  }
  new pack.Profile("pairbrowse", persona).save(personaPath);
}

// Extensions passed as --load-extension / --disable-extensions-except go through the engine's own
// extension switches; every other argument passes as it is.
function splitExtensionArgs(args, extensions) {
  const paths = new Set(extensions ?? []);
  const rest = args.filter((arg) => {
    if (!/^--(?:load-extension|disable-extensions-except)=/.test(arg)) return true;
    for (const path of arg.slice(arg.indexOf("=") + 1).split(",")) paths.add(path);
    return false;
  });
  return { extensionPaths: [...paths], userArgs: rest };
}

export async function launchNative(chromium, config, directory, options, pack, log = () => {}) {
  const metadata = nativeManifest(options.executablePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const personaPath = join(directory, "pairbrowse-persona.json");
  const settings = readSettings(config, pack, personaPath);
  const fingerprintAt = Date.now();
  const { fingerprint, rest, source, steps } = await resolveFingerprint(chromium, options, pack, directory, settings, metadata.version, log);
  // Each launch step's time (plans/555 item 4): what a slow first launch spent where.
  log(`launch: fingerprint ${Date.now() - fingerprintAt} ms${steps.length ? ` (${steps.join(", ")})` : ""}`);
  if (source) log(`PairBrowse persona selected from ${source}.`);
  savePersona(pack, personaPath, fingerprint);

  const { portableProfile, encryptionKey, extensions, disablePrivacySandbox = true, ...personaRest } = rest;
  const { agent, rest: launchOptions } = pack.splitAgentOptions(personaRest);
  const merged = { ...launchOptions, ...options };
  // The browser's WebRTC IP handling is PairBrowse's: web pages never get this computer's local
  // or public addresses outside a proxy (the engine's default deny below). A policy in the
  // config's chromeArgs that would loosen it is dropped here, whatever it says; the browser's own
  // capture page keeps its direct connections through the build's own exemption, not a switch.
  const WEBRTC_POLICY = /^--(?:force-)?webrtc-ip-handling-policy(?:=|$)/;
  const dropped = (merged.args ?? []).filter((a) => WEBRTC_POLICY.test(String(a)));
  if (dropped.length) log("launch: a WebRTC IP handling switch in chromeArgs was dropped: PairBrowse keeps WebRTC from showing this computer's addresses");
  const givenArgs = (merged.args ?? []).filter((a) => !WEBRTC_POLICY.test(String(a)));
  pack.emitCoherenceWarnings?.({ ...fingerprint, proxy: merged.proxy, geoip: settings.geoip, headless: merged.headless, userAgent: merged.userAgent, _userArgs: givenArgs.filter((a) => !/^--pairbrowse-helper(-key-file)?=/.test(String(a))) },
    false, process.platform, CHROMIUM_MAJOR);
  const { args: proxyArgs, proxy } = pack.resolveProxy(merged.proxy, pack.engineSupportsSwitch(options.executablePath, "proxy-auth"));
  const { extensionPaths, userArgs } = splitExtensionArgs(givenArgs, extensions);
  const args = pack.mergeFeatureFlags([
    ...pack.fingerprintArgs({ ...fingerprint }), ...pack.agentArgs(agent),
    ...(disablePrivacySandbox ? pack.privacySandboxArgs() : []),
    ...pack.portableArgs(portableProfile, encryptionKey),
    ...pack.extensionArgs(extensionPaths), ...proxyArgs,
    ...pack.webrtcDefaultDenyArgs(givenArgs, fingerprint.webrtcIp),
    ...pack.gpuBlocklistArgs(merged.headless === false, process.platform, givenArgs),
    ...userArgs,
  ]);
  const gated = pack.gateEngineSwitches(options.executablePath, args, false);
  // Linux: the build's bundled fonts (FONTCONFIG_FILE) and the UI language from --lang (LANGUAGE).
  const env = pack.fontLaunchEnv?.(options.executablePath, merged.env, gated.args);
  const contextAt = Date.now();
  const context = await chromium.launchPersistentContext(directory, {
    ...merged, proxy, ...(env ? { env } : {}),
    viewport: merged.viewport ?? null,
    args: gated.args,
    ignoreDefaultArgs: [...new Set([...pack.DEFAULT_IGNORED_ARGS, ...(merged.ignoreDefaultArgs ?? []), "--enable-automation"])],
  });
  log(`launch: launchPersistentContext ${Date.now() - contextAt} ms`);
  try {
    pack.installHumanizeOnContext(context, { humanize: settings.humanize, showCursor: settings.showCursor, typingPace: settings.typingPace, motion: settings.motion, seed: fingerprint.fingerprint });
    return context;
  } catch (error) {
    try { await context.close?.(); } catch {}
    throw error;
  }
}
