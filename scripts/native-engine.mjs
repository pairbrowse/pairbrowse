// Launches the native PairBrowse browser with the engine pack (native-pack.mjs): its fingerprint,
// persona and launch switches, and humanized input. Settings come from "pairbrowse" in config.json.
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { NATIVE } from "./native-pack.mjs";

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

// This Mac's real fingerprint, read by the engine pack's collector in a throwaway browser that
// sees the real GPU (the browser itself always runs seeded). null when nothing came back.
export async function captureMacHost(chromium, executablePath, pack, directory) {
  let browser, server, captureDirectory;
  try {
    // The collector comes with the engine pack, checked against its pin when the pack is loaded.
    if (typeof pack.collector !== "string") throw new Error("the engine pack has no host collector");
    captureDirectory = mkdtempSync(join(directory, ".mac-host-capture-"));
    browser = await chromium.launchPersistentContext(captureDirectory, { headless: false, viewport: null, executablePath,
      ignoreDefaultArgs: pack.DEFAULT_IGNORED_ARGS, args: ["--disable-extensions", "--disable-gpu-fingerprint"] });
    const page = browser.pages?.()[0] ?? await browser.newPage();
    if (page.goto) {
      server = createServer((_, response) => response.end("<!doctype html><title>PairBrowse host capture</title>"));
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "domcontentloaded" });
    }
    const captured = await page.evaluate((source) => { (0, eval)(source); return globalThis.collectFingerprint(); }, pack.collector);
    if (!captured || typeof captured !== "object") return null;
    // The engine's profile import uses these two compact forms; the collector reports the long ones.
    if (captured.media_devices && !captured.mediaDevices) captured.mediaDevices = captured.media_devices;
    if (captured.webgpu?.info && !captured.webgpu.vendor) captured.webgpu = { ...captured.webgpu.info, limits: captured.webgpu.limits };
    return captured;
  } catch (error) {
    throw new Error(`PairBrowse macOS host capture failed: ${error.message}`, { cause: error });
  } finally {
    try { await browser?.close?.(); } catch {}
    try { if (server) await new Promise((resolve) => server.close(() => resolve())); } catch {}
    if (captureDirectory) rmSync(captureDirectory, { recursive: true, force: true });
  }
}

// The three layers of settings, lowest first: the persona saved in the profile, a saved profile
// chosen by name, and config.json. Every layer is checked for options this engine can't honour.
function readSettings(config, pack, personaPath) {
  const { profile: selection, profileSelect = {}, humanize = false, showCursor = false, geoip = false, ...overrides } = config.pairbrowse ?? {};
  const saved = selection && !["auto", "local"].includes(selection) ? pack.resolveProfileOptions(selection) : {};
  const persisted = existsSync(personaPath) ? pack.Profile.load(personaPath).options : {};
  for (const key of UNSUPPORTED) {
    if ([persisted, saved, overrides].some((layer) => layer[key] !== undefined)) throw new Error(`PairBrowse native does not support pairbrowse.${key} on this engine.`);
  }
  return { selection, profileSelect, humanize, showCursor, geoip, overrides, saved, persisted };
}

// The fingerprint to launch with: the layered settings, then a persona (picked, or this Mac's own
// captured once), the seed, and the region (geoip, else this computer's time zone and language).
async function resolveFingerprint(chromium, options, pack, directory, settings, version) {
  const { selection, profileSelect, geoip, overrides, saved, persisted } = settings;
  const { fingerprint, rest } = pack.splitFingerprintOptions({ ...persisted, ...saved, ...overrides });
  if (fingerprint.fingerprint === "off") throw new Error(`Fingerprint passthrough needs a newer PairBrowse engine; Chromium ${CHROMIUM_MAJOR} treats off as a seed.`);
  fingerprint.platform ??= PLATFORM;
  fingerprint.brandVersion ??= version;
  const picksPersona = selection === "auto" || selection === "local";
  let source = null;
  if (picksPersona) {
    const host = await pack.measureHost((probe) => chromium.launch({ ...probe, executablePath: options.executablePath, ignoreDefaultArgs: pack.DEFAULT_IGNORED_ARGS }),
      options.executablePath, Number(CHROMIUM_MAJOR));
    const resolved = selection === "local" ? pack.resolveLocal(host, profileSelect) : await pack.resolveAuto(host, profileSelect);
    fingerprint.fingerprintProfile = resolved.profile;
    source = resolved.source;
  }
  let hostCapture = false;
  if (fingerprint.fingerprintProfile === undefined) {
    fingerprint.fingerprint ??= createHash("sha256").update(directory).digest("hex");
    if (process.platform === "darwin") {
      fingerprint.fingerprintProfile = await captureMacHost(chromium, options.executablePath, pack, directory);
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
  return { fingerprint, rest, source };
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
  const { fingerprint, rest, source } = await resolveFingerprint(chromium, options, pack, directory, settings, metadata.version);
  if (source) log(`PairBrowse persona selected from ${source}.`);
  savePersona(pack, personaPath, fingerprint);

  const { portableProfile, encryptionKey, extensions, disablePrivacySandbox = true, ...personaRest } = rest;
  const { agent, rest: launchOptions } = pack.splitAgentOptions(personaRest);
  const merged = { ...launchOptions, ...options };
  const givenArgs = merged.args ?? [];
  pack.emitCoherenceWarnings?.({ ...fingerprint, proxy: merged.proxy, geoip: settings.geoip, headless: merged.headless, userAgent: merged.userAgent, _userArgs: givenArgs },
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
  const context = await chromium.launchPersistentContext(directory, {
    ...merged, proxy, ...(env ? { env } : {}),
    viewport: merged.viewport ?? null,
    args: gated.args,
    ignoreDefaultArgs: [...new Set([...pack.DEFAULT_IGNORED_ARGS, ...(merged.ignoreDefaultArgs ?? []), "--enable-automation"])],
  });
  try {
    pack.installHumanizeOnContext(context, { humanize: settings.humanize, showCursor: settings.showCursor, seed: fingerprint.fingerprint });
    return context;
  } catch (error) {
    try { await context.close?.(); } catch {}
    throw error;
  }
}
