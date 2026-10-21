// Launches the native PairBrowse browser with the engine pack (native-pack.mjs): its fingerprint,
// persona and launch switches (humanized input: native/humanize.mjs). Settings come from "pairbrowse"
// in config.json. Its path is fixed: the Pro repo's engine test reads the pack calls made here.
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { NATIVE } from "./native-pack.mjs";
import { paths } from "./paths.mjs";
import { within, writeJsonAtomic, sha256, readJson } from "./util.mjs";
import { TYPING_PACE, clampPace } from "./native/humanize.mjs";
import { inputPaceOf } from "./native/pace.mjs";
import { installPacedHumanize } from "./native/paced-motion.mjs";
import { switchName, withoutNoSandbox } from "./browser-args.mjs";
import { PAIRBROWSE_ENGINE_KEYS } from "./config-schema.mjs";
import { normalizeWebgpu, graphicsPlan, backendSwitches, GRAPHICS, SCREEN_KEYS, IDENTITY_KEYS, LEGACY_GPU_KEYS, GPU_POOL_SWITCH, identityNamed } from "./native/graphics.mjs";
import { wheelNotch } from "./wheel.mjs";
import { browserFontEnv, fontStandInsOf } from "./native/fontconf.mjs";
import { boundedStep, launchWithin, localSite } from "./native/probe.mjs";
import { STRICT_WEBRTC } from "./net/config.mjs";
import { ENGINE_KEYS as PROFILE_ENGINE_KEYS, PICKS_THIS_COMPUTER, THIS_COMPUTER_NOTE } from "./profiles/map.mjs";
import { PERSONA_FILE, LEGACY_PERSONA } from "./sessions.mjs";

// Humanized typing and form fills live in native/humanize.mjs; re-exported for older importers.
export * from "./native/humanize.mjs";

const ENGINE_MAJOR = NATIVE.version.split(".")[0];
// Options this engine can't honour: refused, never silently ignored.
const UNSUPPORTED = ["version", "autoUpdate", "pro", "licenseThroughProxy", "shaderDialect", "widevine", "socks5Udp", "transparentProxy",
  "allowThirdPartyCookies", "fingerprintSchema", "personaSchema", "realGpuHost"];
// The canvas bridge (an engine option that sent what pages draw to a program at an address) is
// gone: refused in a saved profile and in config.json, dropped from the persona kept with a profile
// (one log line), never saved again, and any --canvas-bridge-* switch is stripped from the launch,
// whatever added it. The sandbox is untouched by all of this.
export const canvasBridgeRefusal = (where) => `${where} sets canvasBridge: refused, PairBrowse never sends what pages draw to another program (the canvas bridge is gone).`;
export const CANVAS_BRIDGE_DROPPED = "launch: canvasBridge in the persona kept with this profile dropped (the canvas bridge is gone)";
export const isCanvasBridgeSwitch = (arg) => typeof arg === "string" && /^canvas-bridge-/.test(switchName(arg) ?? "");
// A proxy in a saved profile or in the persona kept with a session (spec C10, the refusal D7 shares):
// the launch stops, never drops it, since dropping it would turn a proxied session into a direct one.
// A session's proxy is operator config (config.json network.proxies, net/config.mjs), its
// credentials only in secrets.env.
export const personaProxyRefusal = (where) => `${where} sets proxy: refused, a session's proxy is set in config.json's network.proxies (docs/configuration.md), never in a persona; move it there.`;
// A proxy's username and password reach the browser only through its auth file (spec C1, the
// manifest's proxyAuthFile), never the driver's proxy option (the driver answers any site's 401 with
// them) or a switch (ps, crash dumps). So a proxy given to a launch carries no user, password or
// user info in its address; one that does stops the launch, before the engine pack sees it.
export const PROXY_CREDENTIALS_REFUSAL = "A proxy's username and password reach the browser only through its proxy auth file, never the launch options or the command line: refused.";
const userInfo = (server) => typeof server === "string" && server.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0].includes("@");
export const proxyCredentials = (proxy) => proxy != null && (typeof proxy === "object" ? !!(proxy.username || proxy.password) || userInfo(proxy.server) : userInfo(proxy));
// What geoip derives from the exit address (spec C9): recomputed at each launch, never kept in the
// persona (savePersona), so a session's region follows its proxy and its file never holds an address.
const GEOIP_FIELDS = ["timezone", "acceptLanguage", "webrtcIp", "location"];
// An IPv4 or IPv6 address (one with "::" or all eight groups, an IPv4 tail too) in a sentence the
// engine pack wrote; a time such as 12:30:45 is not one.
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 = /(?<![\w:.])[0-9a-f:.]*:[0-9a-f:.]*:[0-9a-f:.]*(?![\w:.])/gi;
const isIpv6 = (run) => run.includes("::") || run.split(":").length === 8;
const maskIpv6 = (run) => { const end = run.match(/\.*$/)[0]; const ip = run.slice(0, run.length - end.length); return isIpv6(ip) ? `an address${end}` : run; };
export const withoutAddresses = (text) => String(text).replace(IPV6, maskIpv6).replace(IPV4, "an address");
// The region from the exit address (geoip), quietly (spec C9): the engine pack asks for the exit
// address, and its fallback region service, through the session's proxy, and with quiet true writes
// nothing to stderr, so no line of daemon.log names the address (without a proxy it is this
// computer's own). A failure stops the launch with the pack's sentence, its address taken out for
// the same reason. (The pack's region database, fetched once, is not yet pinned or proxied: spec
// E11, step 48.)
async function applyGeoipQuietly(pack, fingerprint, proxy) {
  try {
    await pack.applyGeoip(fingerprint, proxy, true);
  } catch (error) {
    throw new Error(withoutAddresses(error?.message ?? error));
  }
}
// A server's clock is usually UTC, a zone few everyday computers use and one pages compare with the
// region of the address they see (the ordinary-browser measurement, decision 11: BrowserScan took
// points for it on Linux). When nothing sets the session's time zone and this computer's is one of
// those, the launch says how to give it the exit's zone. The sentence, or null.
const CLOCK_ZONES = /^(?:UTC|UCT|GMT|Zulu|Universal|Greenwich|Etc\/.*)$/i;
export function clockZoneNote(timezone) {
  if (typeof timezone !== "string" || !CLOCK_ZONES.test(timezone)) return null;
  return `launch: time zone ${timezone} (this computer's clock): pages compare it with the region of the address they see; set the profile's locale.timezone, or TZ for the helper (docs/server.md), to the zone of your exit`;
}
const PLATFORM = { darwin: "macos", linux: "linux", win32: "windows" }[process.platform];
// D12 (F4, F7): what a launch works out each time when no setting gives it: the build's platform
// and brand version, and this computer's time zone and languages (else a device's own languages).
// Never kept in the persona, and one kept there by an older version is not read, so a build update
// never launches with the old build's version and a copied persona never brings its system along.
const DERIVED_FIELDS = ["platform", "brandVersion", "timezone", "acceptLanguage"];
// The languages a device profile given as a setting lists (navigator.languages), as Accept-Language.
const deviceLanguages = (profile) => {
  const list = profile && typeof profile === "object" ? profile.navigator?.languages : null;
  const plain = Array.isArray(list) ? list.filter((l) => typeof l === "string" && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(l)).slice(0, 10) : [];
  return plain.length ? plain.join(",") : undefined;
};

// The build manifest of a native PairBrowse browser: in the app's Resources on macOS
// (PairBrowse.app/Contents/MacOS/pairbrowse), next to chrome / chrome.exe on Linux and Windows.
export function nativeManifest(executablePath) {
  const mac = /\.app$/.test(dirname(dirname(dirname(executablePath))));
  const contents = dirname(dirname(executablePath));
  const metadata = JSON.parse(readFileSync(mac ? join(contents, "Resources", "PairBrowse-build.json") : join(dirname(executablePath), "PairBrowse-build.json"), "utf8"));
  // Any JSON may be there (null, a number for the version): refused with this sentence, never a TypeError.
  if (metadata?.product !== "PairBrowse" || typeof metadata.version !== "string" || metadata.version.split(".")[0] !== ENGINE_MAJOR || !/^\d+\.\d+\.\d+\.\d+$/.test(metadata.version)) {
    throw new Error(`PairBrowse native requires a PairBrowse build of engine version ${ENGINE_MAJOR}.`);
  }
  if (mac && !existsSync(join(contents, "Frameworks", "Chromium Framework.framework"))) {
    throw new Error("PairBrowse app is incomplete: its engine framework is missing.");
  }
  if (!mac && !["linux", "windows"].includes(metadata.platform)) throw new Error("PairBrowse build manifest names no platform.");
  return metadata;
}

// The build manifest's `chrome` field: the protocol level of the browser's own pages (1 =
// chrome://pairbrowse and chrome://pairbrowse.top-chrome pages reading --pairbrowse-helper).
// Absent in today's builds: then the side panel extension takes their place.
export const declaresOwnPages = (manifest) => Number.isInteger(manifest?.chrome) && manifest.chrome >= 1;
// The build manifest's `capture` field: the browser's own capture page (a tab's picture and sound
// for joiners, recordings; liveview/capture.mjs) is there. Absent: a shared browser sends pictures
// through the join channel and recording is refused (daemon/capture.mjs).
export const capturePages = (manifest) => Number.isInteger(manifest?.capture) && manifest.capture >= 1;
// `capture` 2 and up: the capture page reads its own key from the file --pairbrowse-capture-key-file
// names and sends it (ck) on its stream and its replies; the helper then requires it.
export const captureKeyed = (manifest) => Number.isInteger(manifest?.capture) && manifest.capture >= 2;
// The build manifest's `settingsSection` field (1 and up, 580): PairBrowse's settings are the
// engine settings' PairBrowse section (chrome://settings/pairbrowse, which frames
// chrome://pairbrowse/settings/). Absent (older builds): the settings page is the tab page
// chrome://pairbrowse/settings itself.
export const settingsSection = (manifest) => Number.isInteger(manifest?.settingsSection) && manifest.settingsSection >= 1;
// The build manifest's `quietTabs` field (1 and up, 585): a tab automation opens or brings forward
// is selected in its window without bringing the browser in front of the app you're in.
export const quietTabs = (manifest) => Number.isInteger(manifest?.quietTabs) && manifest.quietTabs >= 1;
// The build manifest's `adBlocker` field (1 and up, 591 reading the store's update answers and
// 593): the browser installs PairBrowse's default ad blocker from the store, enabled
// (browser/adblock.mjs). Absent (older builds): no entry is written, an old one is removed.
// The build manifest's `safeStorageKeyFile` field (1 and up, 594): the browser takes its Safe Storage
// password from the owner-only file --pairbrowse-safe-storage-key-file names, reading the Keychain
// only while that file is missing, so a new build signed without a Team ID doesn't ask again. On
// Linux the same file comes before the fixed key --password-store=basic gives.
export const safeStorageKeyFile = (manifest) => Number.isInteger(manifest?.safeStorageKeyFile) && manifest.safeStorageKeyFile >= 1;
// The build manifest's `proxyAuthFile` field (1 and up, 962): the browser reads a proxy's username
// and password once from the owner-only file --pairbrowse-proxy-auth-file names and answers only
// the auth challenges of the proxy --proxy-server names (same host and port), never a site's.
// Absent (every build so far, and always the open build): a proxy with credentials is refused at launch.
export const proxyAuthFile = (manifest) => Number.isInteger(manifest?.proxyAuthFile) && manifest.proxyAuthFile >= 1;
export const adBlocker = (manifest) => Number.isInteger(manifest?.adBlocker) && manifest.adBlocker >= 1;
// The build manifest's `adBlockerCrx` ({ path, version }): the ad blocker shipped with the build, a
// CRX under Contents/Resources on macOS, under the binary's directory on Linux (a relative path
// inside it, no ".."), or null.
export function adBlockerCrx(manifest) {
  const crx = manifest?.adBlockerCrx;
  if (!crx || typeof crx.path !== "string" || typeof crx.version !== "string") return null;
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.crx$/.test(crx.path) || crx.path.split("/").includes("..")) return null;
  if (!/^\d+(?:\.\d+){0,3}$/.test(crx.version)) return null;
  return { path: crx.path, version: crx.version };
}

// A command's output, trimmed, or "" when it fails or takes over 10 s. Never execFileSync here:
// the helper serves its live view and every other caller while these run.
const output = (file, args) => new Promise((resolve) => {
  execFile(file, args, { encoding: "utf8", timeout: 10_000 }, (error, stdout) => resolve(error ? "" : String(stdout).trim()));
});

// The primary display as the engine reports it, so the hidden capture sees the real screen, not
// headless's 800x600. The engine on macOS reports 30-bit color on EDR (XDR) displays.
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
// Each step is bounded (CAPTURE_STEP_MS; the steps native/probe.mjs's graphics probe uses too): a
// capture that hangs fails the launch with its reason instead of holding it forever.
const CAPTURE_STEP_MS = 90_000;
export async function captureMacHost(chromium, executablePath, pack, directory, screen, stepMs = CAPTURE_STEP_MS) {
  let browser, site, captureDirectory;
  if (screen === undefined) screen = await macScreen();
  const step = boundedStep(stepMs);
  try {
    // The collector comes with the engine pack, checked against its pin when the pack is loaded.
    if (typeof pack.collector !== "string") throw new Error("the engine pack has no host collector");
    captureDirectory = mkdtempSync(join(directory, ".mac-host-capture-"));
    // A launch that comes back after its time is up is closed all the same (launchWithin).
    browser = await launchWithin(stepMs, "the hidden browser's start", () => chromium.launchPersistentContext(captureDirectory, { headless: true, viewport: null, executablePath, chromiumSandbox: true,
      ignoreDefaultArgs: pack.DEFAULT_IGNORED_ARGS,
      args: ["--disable-extensions", "--disable-gpu-fingerprint", "--window-size=1200,960", ...(screen ? [screenInfoArg(screen)] : [])] }));
    const page = browser.pages?.()[0] ?? await step("the capture tab", Promise.resolve(browser.newPage()));
    if (page.goto) {
      site = await localSite("PairBrowse host capture");
      await step("the capture page", page.goto(site.origin, { waitUntil: "domcontentloaded" }));
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
    return normalizeWebgpu(captured);
  } catch (error) {
    throw new Error(`PairBrowse macOS host capture failed: ${error.message}`, { cause: error });
  } finally {
    try { await within(10_000, Promise.resolve(browser?.close?.())); } catch {}
    try { if (site) await within(5000, site.close()); } catch {}
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
  const key = sha256(JSON.stringify({ version, hardware: await hardware() }));
  const cached = readJson(file);
  if (cached?.key === key && cached.profile && typeof cached.profile === "object") return hostFonts(normalizeWebgpu(cached.profile));
  if (capturing?.key === `${file}\n${key}`) return capturing.promise;
  try { onCapture(); } catch {}
  const promise = captureAndKeep(chromium, executablePath, pack, directory, file, key, version).then(hostFonts);
  capturing = { key: `${file}\n${key}`, promise };
  try { return await promise; } finally { if (capturing?.promise === promise) capturing = null; }
}

// This Mac's own profile shows pages this Mac's own font list: `fonts.host` (engine patch 963)
// marks a persona captured from the computer the browser runs on, so every family the computer
// has reaches a page, as an everyday browser on it shows them, instead of only the families the
// collector's width probe found among its mostly Windows list (14 of 70 on a Mac where an everyday
// browser shows 30; the ordinary-browser measurement's font gap). Only the host capture gets the
// mark: a profile a setting gives (another computer's, or another OS's) keeps its own list.
export function hostFonts(profile) {
  if (!profile || typeof profile !== "object") return profile;
  const fonts = profile.fonts && typeof profile.fonts === "object" && !Array.isArray(profile.fonts) ? profile.fonts : {};
  return { ...profile, fonts: { ...fonts, host: true } };
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

// A fingerprintProfile as any layer gives it (an object, a file's path or JSON text, as the engine
// pack reads them) with its WebGPU in the shape the engine reads (native/graphics.mjs
// normalizeWebgpu). A path or text whose WebGPU is already flat, or that isn't a profile, passes on
// as it was; one that needs flattening passes on as the flattened object, and the user's file is
// never written.
export function flatWebgpuProfile(value) {
  if (typeof value !== "string") return normalizeWebgpu(value);
  let profile;
  try { profile = JSON.parse(existsSync(value) ? readFileSync(value, "utf8") : value); } catch { return value; }
  const flat = normalizeWebgpu(profile);
  return flat === profile ? value : flat;
}
const withFlatWebgpu = (layer) => (layer?.fingerprintProfile === undefined ? layer : { ...layer, fingerprintProfile: flatWebgpuProfile(layer.fingerprintProfile) });

// The persona kept with a session belongs to one browser profile: it is saved under the profile's
// id (spec server-mode D13), and a launch on another profile is refused rather than starting with
// its seed and values (daemon/sessions/profiles.mjs; a reassignment removes it, sessions.mjs).
export const personaBindingRefusal = (name, id) => `The persona kept with this session (${PERSONA_FILE}) belongs to ${/^p-[0-9a-f]{16}$/.test(String(name)) ? `browser profile ${name}` : "no browser profile"}, not ${id}: refused, it is never saved over under another profile. The person reassigns the session to start it on another profile.`;

// The pack's humanized input sets for settings' inputPace (paced-motion.mjs): { fast, human? },
// each { motion, typingPace }. The everyday pace moves "combined" and types at pace 1 (the pack's
// own typing; PairBrowse's own takes the human rhythm, humanize.mjs). One set when both would be
// the same, or with "fast" or "human".
export function paceSets({ inputPace = "adaptive", motion = "fast", typingPace = TYPING_PACE } = {}) {
  const fast = { motion, typingPace }, human = { motion: "combined", typingPace: 1 };
  if (inputPace === "human") return { fast: human };
  if (inputPace === "fast" || (motion === human.motion && typingPace === human.typingPace)) return { fast };
  return { fast, human };
}

// The three layers of settings, lowest first: the persona saved in the profile, a saved profile
// chosen by name, and config.json. Every layer is checked for options this engine can't honour, and
// its fingerprintProfile's WebGPU flattened (flatWebgpuProfile).
// config.browserProfile: the session's browser profile's engine layer (daemon/sessions/profiles.mjs:
// { id, kind, engineKeys, geoip }), or none (the install self-check, tests). Its keys go over
// config.json's; a store profile (kind "store") takes none of config.json's own persona settings
// (languages, time zone, screen, seed, geoip, a picked or saved persona, fingerprintProfile): those
// are the config-backed default's. config.json's other engine keys (the legacy hardware ones,
// decision U6) still apply to every profile.
function readSettings(config, pack, personaPath) {
  // motion: how humanized mouse moves are shaped at the fast pace: "fast" (the default: PairBrowse's
  // hand-like shape, one reach that lands close, then homes in without stopping, at a quick hand's
  // pace: a hop between fields in about a third of the profile's time, a reach in under two
  // thirds, a short press), "quick" (the same shape, a hop in about half the time and a reach as a
  // hand's), "combined" (the same shape at the profile's own speed, tremor and habits) or
  // "classic" (the engine's own). Every click still lands exactly on its point. inputPace (the
  // adaptive pace, native/pace.mjs, spec step 51): "adaptive" (the default) moves "combined" and
  // types at an everyday typist's rhythm only where a verification widget or a sign-in, sign-up
  // or payment form scores the input (the ordinary-browser measurement of decision 11 read "fast"
  // moves as about 30% quicker than Fitts' law allows a hand), at motion and typingPace elsewhere;
  // "fast" always at those, "human" always at the everyday pace (native/paced-motion.mjs).
  // An engine pack without "combined" uses its own. formMove is PairBrowse's own (fillSettings), not the engine's.
  // graphicsNoise: noise over the identity shown on a host without a GPU (decisions 10 and 11, off
  // by default; native/graphics.mjs identityKeys: the engine's fingerprintNoise and canvasNoise);
  // on a host with a GPU the real pixels get no readback noise, whatever this says.
  const { profile: selection, profileSelect, graphics = "auto", graphicsNoise = false, humanize = true, showCursor = false, geoip = false, typingPace = TYPING_PACE, motion: motionSetting = "fast", formMove, inputPace, fontStandIns, ...given } = config.pairbrowse ?? {};
  // profileSelect only steered the engine pack's persona pick, which PairBrowse no longer asks
  // for (D9 below; config-schema.mjs PROFILE_SELECT keeps it closed, D8).
  // graphics: the default profile's backend, read by profiles/map.mjs into its switches (E2).
  // fontStandIns: the browser's font configuration on Linux (native/fontconf.mjs, read at launch).
  void formMove, profileSelect, inputPace, fontStandIns;
  // Only the engine's fingerprint options pass (config-schema.mjs PAIRBROWSE_ENGINE_KEYS): never an
  // unpacked extension, a proxy, launch options or switches from config.json, which would go
  // around the browserArgs screen. An option this engine can't honour still stops the launch below.
  const chosen = config.browserProfile ?? null;
  const store = chosen?.kind === "store";
  const fromConfig = Object.entries(given).filter(([k]) => PAIRBROWSE_ENGINE_KEYS.includes(k) && !(store && (PROFILE_ENGINE_KEYS.includes(k) || k === "fingerprintProfile")));
  const fromProfile = Object.entries(chosen?.engineKeys ?? {}).filter(([k]) => PROFILE_ENGINE_KEYS.includes(k));
  const overrides = withFlatWebgpu(Object.fromEntries([...fromConfig, ...fromProfile]));
  const ignored = Object.keys(given).filter((k) => !PAIRBROWSE_ENGINE_KEYS.includes(k) && !UNSUPPORTED.includes(k));
  const motion = ["classic", "combined", "quick"].includes(motionSetting) ? motionSetting : "fast";
  if (given.canvasBridge !== undefined) throw new Error(canvasBridgeRefusal("config.json's pairbrowse block"));
  // D9: "auto" and "local" are this computer (the macOS host capture, else the seed persona);
  // PairBrowse never has the engine pack pick another device's persona from a library or a service.
  const thisComputer = !store && PICKS_THIS_COMPUTER.includes(selection);
  const picked = store || thisComputer ? undefined : selection;
  // A copy: the layer is filtered below (D7), never the engine pack's own object.
  const saved = { ...withFlatWebgpu(picked ? pack.resolveProfileOptions(picked) : {}) };
  if (saved?.canvasBridge !== undefined) throw new Error(canvasBridgeRefusal("The saved profile (pairbrowse.profile)"));
  if (saved?.proxy !== undefined) throw new Error(personaProxyRefusal("The saved profile (pairbrowse.profile)"));
  const kept = existsSync(personaPath) ? pack.Profile.load(personaPath) : null;
  // The persona is the profile's: under its id, or (the config-backed default only) the name every
  // persona had before profiles, which this launch saves under the default's id.
  if (chosen && kept && kept.name !== chosen.id && !(kept.name === LEGACY_PERSONA && chosen.kind === "config")) throw new Error(personaBindingRefusal(kept.name, chosen.id));
  const persisted = { ...withFlatWebgpu(kept ? kept.options : {}) };
  if (persisted.proxy !== undefined) throw new Error(personaProxyRefusal("The persona kept with this session (pairbrowse-persona.json)"));
  const bridgeDropped = persisted.canvasBridge !== undefined;
  delete persisted.canvasBridge;
  for (const key of DERIVED_FIELDS) delete persisted[key];
  for (const key of UNSUPPORTED) {
    if ([persisted, saved, given].some((layer) => layer[key] !== undefined)) throw new Error(`PairBrowse native does not support pairbrowse.${key} on this engine.`);
  }
  // D7 (F1): from the saved profile and the persona kept with the session, as from config.json, only
  // the engine's fingerprint options pass; every other option (launch controls, switches, env,
  // extensions, agent and storage options) is named in one log line and dropped, never applied.
  const dropped = { saved: engineOnly(saved), persisted: engineOnly(persisted) };
  return { thisComputer, graphics: chosen?.graphics ?? graphics, graphicsNoise: graphicsNoise === true, humanize, showCursor, geoip: store ? !!chosen.geoip : chosen?.kind === "config" ? !!(geoip || chosen.geoip) : geoip, typingPace: clampPace(typingPace), motion, inputPace: inputPaceOf(config), overrides, saved, persisted, ignored, dropped, bridgeDropped, personaName: chosen?.id ?? LEGACY_PERSONA };
}

// Keeps only the engine's fingerprint options in a persona layer, in place: the names of the
// others, as a log may show them (a name that isn't a plain option name is only counted).
function engineOnly(layer) {
  const names = [];
  for (const key of Object.keys(layer)) {
    if (PAIRBROWSE_ENGINE_KEYS.includes(key)) continue;
    names.push(key);
    delete layer[key];
  }
  return names;
}
const LAYER_NAMES = { saved: "the saved profile (pairbrowse.profile)", persisted: `the persona kept with this session (${PERSONA_FILE})` };
export const droppedLine = (layer, names) => {
  const plain = names.filter((n) => /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(n));
  const other = names.length - plain.length;
  const listed = [...plain, ...(other ? [`${other} other${other > 1 ? "s" : ""}`] : [])].join(", ");
  return `launch: ${listed} in ${LAYER_NAMES[layer]} not used: only the engine's fingerprint options pass from a persona (see docs/configuration.md)`;
};

// The fingerprint to launch with: the layered settings, then a persona (this Mac's own, captured
// once per Mac, when no layer names one), the seed, and the region (geoip, else this computer's
// time zone and languages, or the languages of a device profile a setting gives). What it works
// out is derived (DERIVED_FIELDS), never the persona's.
async function resolveFingerprint(chromium, options, pack, directory, settings, version, log = () => {}) {
  const { geoip, overrides, saved, persisted } = settings;
  const { fingerprint, rest } = pack.splitFingerprintOptions({ ...persisted, ...saved, ...overrides });
  if (fingerprint.fingerprint === "off") throw new Error(`Fingerprint passthrough needs a newer PairBrowse engine; engine version ${ENGINE_MAJOR} treats off as a seed.`);
  fingerprint.platform ??= PLATFORM;
  fingerprint.brandVersion ??= version;
  // A device profile given as a setting (config.json, the browser profile or a saved persona),
  // never this Mac's capture or one kept from before: its languages are the browser's when no
  // setting names any (the engine pack's own reading, which this computer's Intl would replace).
  const givenDevice = overrides.fingerprintProfile ?? saved.fingerprintProfile;
  const steps = [];
  let hostCapture = false;
  if (fingerprint.fingerprintProfile === undefined) {
    fingerprint.fingerprint ??= sha256(directory);
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
    const newProfile = saved.fingerprintProfile !== undefined || overrides.fingerprintProfile !== undefined;
    const keptSeed = persisted.fingerprint !== undefined && !newProfile;
    if (!hostCapture && !keptSeed && overrides.fingerprint === undefined && saved.fingerprint === undefined) delete fingerprint.fingerprint;
  }
  // The legacy GPU identity (decision U6) only while config.json or a saved profile sets it: one
  // kept with the persona from an earlier launch is dropped (and so leaves the persona at its save).
  for (const key of LEGACY_GPU_KEYS) if (overrides[key] === undefined && saved[key] === undefined) delete fingerprint[key];
  if (geoip) {
    for (const key of GEOIP_FIELDS) if (overrides[key] === undefined && saved[key] === undefined) delete fingerprint[key];
    // The session's proxy is the launch's own (a persona's or saved profile's proxy is refused in
    // readSettings, config.json's never reaches the settings).
    await applyGeoipQuietly(pack, fingerprint, options.proxy);
  }
  fingerprint.timezone ??= Intl.DateTimeFormat().resolvedOptions().timeZone;
  fingerprint.acceptLanguage ??= deviceLanguages(givenDevice) ?? Intl.DateTimeFormat().resolvedOptions().locale;
  return { fingerprint, rest, steps };
}

// Only the fingerprint is kept with the profile: never proxy credentials, agent keys or a canvas
// bridge, never what the launch works out (DERIVED_FIELDS, D12; the graphics plan's keys, which
// launchNative adds after this, applyGraphicsPlan), and with geoip never what it
// derived (GEOIP_FIELDS, spec C9): those are measurements of this launch's exit address, not
// settings. One set in config.json, the browser profile or a saved profile is read from there
// again at each launch.
// name: the browser profile's id (D13), or "pairbrowse" for a launch without one.
function savePersona(pack, personaPath, fingerprint, geoip, name = LEGACY_PERSONA) {
  const persona = { ...fingerprint };
  delete persona.canvasBridge;
  for (const key of DERIVED_FIELDS) delete persona[key];
  if (geoip) for (const key of GEOIP_FIELDS) delete persona[key];
  new pack.Profile(name, persona).save(personaPath);
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

export const DRIVER_BLINK_SWITCH = "--disable-blink-features=AutomationControlled";
export const DRIVER_BACKGROUND_SWITCH = "--disable-background-networking";

// The graphics plan (spec server-mode E2, E7; native/graphics.mjs graphicsPlan) over the resolved
// fingerprint, in place, after the persona is saved (its keys are the runtime's, worked out at each
// launch, never kept). On macOS no noise over this Mac's own pixels (fingerprintNoise: false). On Linux with a GPU (measured: the backend read the launch has, { kind,
// renderer } or null before any): the real backend's WebGL strings, limits and extensions and
// WebGPU vendor and architecture (disableGpuFingerprint), no noise over real pixels
// (fingerprintNoise: false); on a host without one (a software read: decision 10) the engine's
// one graphics identity (GPU_LESS_IDENTITY on a build whose engine takes the pool switch, gpuPool;
// LINUX_IDENTITY on an older one) with noise as settings.graphicsNoise says, and the identity's
// own platform (the Windows persona) over the build's; either way on the helper's virtual screen
// (config.virtualDisplay: { width, height, depth }) that screen, unless config.json or the
// profile sets one. A layer's other value for these keys, and the legacy GPU identity (decision
// U6), aren't applied there, and the log says so. The legacy keys are named deprecated on every
// platform. Returns the plan (its identity: what pages are shown, or null; its identitySwitches:
// the engine switches the launch adds for it).
export function applyGraphicsPlan(fingerprint, settings, { platform = process.platform, display = null, measured = null, userArgs = [], gpuPool = false, log = () => {} } = {}) {
  const set = (k) => settings.overrides[k] !== undefined || settings.saved[k] !== undefined;
  const plan = graphicsPlan({ requested: "auto", platform, browserKind: "pairbrowse", measured, userArgs, display, screenSet: SCREEN_KEYS.slice(0, 2).some(set), graphicsNoise: settings.graphicsNoise === true, gpuPool });
  const legacy = LEGACY_GPU_KEYS.filter((k) => fingerprint[k] !== undefined);
  if (legacy.length) log(`launch: ${legacy.join(", ")} (another device's GPU) ${legacy.length > 1 ? "are" : "is"} deprecated and go${legacy.length > 1 ? "" : "es"} in the next release (decision U6): graphics come from this computer; remove ${legacy.length > 1 ? "them" : "it"} from config.json's pairbrowse block or the saved persona`);
  if (platform === "linux") {
    for (const k of legacy) delete fingerprint[k];
    if (legacy.length) log(`launch: ${legacy.join(", ")} not applied on Linux: pages see ${plan.identity ? "the engine's one identity over software rendering" : "this computer's real renderer"}`);
    const differs = (k) => fingerprint[k] !== undefined && fingerprint[k] !== plan.engineKeys[k];
    const other = Object.keys(plan.engineKeys).filter((k) => !SCREEN_KEYS.includes(k) && !IDENTITY_KEYS.includes(k) && differs(k));
    if (other.length) log(`launch: ${other.join(", ")} not applied on Linux: graphics there follow the measured backend (${plan.identity ? "the engine's identity over software rendering" : "the real backend's strings"})`);
    // The identity's platform over one a layer set (the build's own, derived each launch, is
    // replaced without a word: it is nobody's setting).
    const identityOther = IDENTITY_KEYS.filter((k) => plan.engineKeys[k] !== undefined && set(k) && differs(k));
    if (identityOther.length) log(`launch: ${identityOther.join(", ")} not applied on Linux: the identity shown over software rendering brings its own (${plan.identity})`);
    // A screen key set without screenWidth and screenHeight (a pixel ratio, a depth) gives way to the
    // virtual screen's, never silently.
    const screenOther = SCREEN_KEYS.filter((k) => plan.engineKeys[k] !== undefined && differs(k));
    if (screenOther.length) log(`launch: ${screenOther.join(", ")} not applied on Linux: the virtual screen's apply (set virtualScreen in config.json to choose a screen)`);
  }
  if (platform === "darwin") {
    const other = Object.keys(plan.engineKeys).filter((k) => fingerprint[k] !== undefined && fingerprint[k] !== plan.engineKeys[k]);
    if (other.length) log(`launch: ${other.join(", ")} not applied on macOS: this Mac's own GPU draws with no noise over its pixels`);
  }
  Object.assign(fingerprint, plan.engineKeys);
  const screen = SCREEN_KEYS.every((k) => plan.engineKeys[k] !== undefined) ? `, screen ${plan.engineKeys.screenWidth}x${plan.engineKeys.screenHeight} (the virtual screen)` : "";
  if (platform === "linux") {
    log(plan.identity
      ? `launch: graphics: software rendering, shown as ${plan.identity} (the engine's one graphics identity for a host without a GPU, decision 10; canvas noise ${plan.engineKeys.canvasNoise ? "on" : "off"})${screen}`
      : `launch: graphics: this computer's own renderer (real WebGL and WebGPU strings, no fingerprint noise)${screen}`);
  }
  return plan;
}

// Whether this build's engine takes the GPU pool switch (patch 967: the Windows identity's GPU),
// as the engine pack reads the build's switches; false for a pack or build that can't say.
export function engineHasGpuPool(pack, executablePath) {
  try { return pack?.engineSupportsSwitch?.(executablePath, GPU_POOL_SWITCH.slice(2).split("=")[0]) === true; } catch { return false; }
}

// A native launch's environment (undefined: the driver's own, this process's). Linux: the
// build's bundled fonts (FONTCONFIG_FILE) and the UI language from --lang (LANGUAGE), the pack's
// merge (fontLaunchEnv: this process's env, then those, then the caller's, which wins); once the
// server setup has run, PairBrowse's font configuration in the build's place: the computer's
// fonts, and the open stand-ins under the Windows names only while pairbrowse.fontStandIns is on
// (native/fontconf.mjs, spec step 52). Only FONTCONFIG_FILE goes over the caller's env, never
// this process's whole env, so a LANGUAGE the helper was started with never outranks --lang's.
// fonts: browserFontEnv's options (tests).
export function launchEnv(config, { given, pack, executablePath, args, log = () => {}, fonts = {} }) {
  const fontEnv = browserFontEnv(config, { log, ...fonts });
  if (fontEnv) log(`launch: fonts: this computer's font set, stand-ins for the Windows names ${fontStandInsOf(config) ? "on" : "off"} (pairbrowse.fontStandIns)`);
  const givenEnv = fontEnv ? { ...(given ?? {}), ...fontEnv } : given;
  if (pack.fontLaunchEnv) return pack.fontLaunchEnv(executablePath, givenEnv, args);
  return fontEnv ? { ...process.env, ...givenEnv } : given;
}

export async function launchNative(chromium, config, directory, options, pack, log = () => {}) {
  const metadata = nativeManifest(options.executablePath);
  // Before anything else runs (a first launch's host capture takes up to a minute).
  if (proxyCredentials(options.proxy)) throw new Error(PROXY_CREDENTIALS_REFUSAL);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const personaPath = join(directory, PERSONA_FILE);
  const settings = readSettings(config, pack, personaPath);
  if (settings.bridgeDropped) log(CANVAS_BRIDGE_DROPPED);
  if (settings.thisComputer) log(`launch: pairbrowse.profile "${config.pairbrowse.profile}": ${THIS_COMPUTER_NOTE}`);
  for (const [layer, names] of Object.entries(settings.dropped)) if (names.length) log(droppedLine(layer, names));
  if (settings.ignored.length) log(`launch: ${settings.ignored.map((k) => `pairbrowse.${k}`).join(", ")} in config.json not used (PairBrowse passes on only its own settings and the engine's fingerprint options; see docs/configuration.md)`);
  const fingerprintAt = Date.now();
  const { fingerprint, rest, steps } = await resolveFingerprint(chromium, options, pack, directory, settings, metadata.version, log);
  // Each launch step's time (plans/555 item 4): what a slow first launch spent where.
  log(`launch: fingerprint ${Date.now() - fingerprintAt} ms${steps.length ? ` (${steps.join(", ")})` : ""}`);
  savePersona(pack, personaPath, fingerprint, settings.geoip, settings.personaName);
  const zoneSet = settings.geoip || settings.overrides.timezone !== undefined || settings.saved.timezone !== undefined;
  const onServer = !!config.virtualDisplay || config.server?.keepAlive === true;
  const zoneNote = onServer && !zoneSet ? clockZoneNote(fingerprint.timezone) : null;
  if (zoneNote) log(zoneNote);
  // config.measuredBackend: the backend the launch measured or kept (daemon/browser/launch.mjs,
  // native/check.mjs probeLauncher), null before any measurement.
  const plan = applyGraphicsPlan(fingerprint, settings, { display: config.virtualDisplay ?? null, measured: config.measuredBackend ?? null, userArgs: options.args ?? [], gpuPool: engineHasGpuPool(pack, options.executablePath), log });

  const { portableProfile, encryptionKey, extensions, disablePrivacySandbox = true, ...personaRest } = rest;
  const { agent, rest: launchOptions } = pack.splitAgentOptions(personaRest);
  const merged = { ...launchOptions, ...options };
  // The browser's WebRTC IP handling is PairBrowse's: web pages never get this computer's local
  // or public addresses outside a proxy (the engine's default deny below). A policy in the
  // config's browserArgs that would loosen it is dropped here, whatever it says; the browser's own
  // capture page keeps its direct connections through the build's own exemption, not a switch.
  // Every spelling the engine reads ("-webrtc-ip-handling-policy=...", "/..." on Windows) counts.
  // A strict proxied session's own switch (net/config.mjs STRICT_WEBRTC, the same policy as the
  // default deny) is the one kept: the engine pack then adds none of its own.
  const webrtcPolicy = (a) => a !== STRICT_WEBRTC && ["webrtc-ip-handling-policy", "force-webrtc-ip-handling-policy"].includes(switchName(a));
  const dropped = (merged.args ?? []).filter(webrtcPolicy);
  if (dropped.length) log("launch: a WebRTC IP handling switch in browserArgs was dropped: PairBrowse keeps WebRTC from showing this computer's addresses");
  const givenArgs = (merged.args ?? []).filter((a) => !webrtcPolicy(a));
  pack.emitCoherenceWarnings?.({ ...fingerprint, proxy: merged.proxy, geoip: settings.geoip, headless: merged.headless, userAgent: merged.userAgent, _userArgs: givenArgs.filter((a) => !/^--pairbrowse-helper(-key-file)?=/.test(String(a))) },
    false, process.platform, ENGINE_MAJOR);
  if (proxyCredentials(merged.proxy)) throw new Error(PROXY_CREDENTIALS_REFUSAL); // whatever layer added it
  const { args: proxyArgs, proxy } = pack.resolveProxy(merged.proxy, pack.engineSupportsSwitch(options.executablePath, "proxy-auth"));
  // The only extension a launch loads is PairBrowse's own, which the helper adds in its own
  // --load-extension switch (browser.mjs shellArgs); one named anywhere else (a saved profile's
  // "extensions") is left out and logged, as browserArgs' --load-extension is.
  const own = splitExtensionArgs(givenArgs, []).extensionPaths;
  const strayExtensions = (Array.isArray(extensions) ? extensions : extensions ? [extensions] : []).filter((p) => !own.includes(p));
  if (strayExtensions.length) log(`launch: ${strayExtensions.length} extension${strayExtensions.length > 1 ? "s" : ""} besides PairBrowse's own dropped: the browser loads only its side panel`);
  const { extensionPaths, userArgs } = splitExtensionArgs(givenArgs, []);
  const args = pack.mergeFeatureFlags([
    ...pack.fingerprintArgs({ ...fingerprint }), ...pack.agentArgs(agent),
    ...(disablePrivacySandbox ? pack.privacySandboxArgs() : []),
    ...pack.portableArgs(portableProfile, encryptionKey),
    ...pack.extensionArgs(extensionPaths), ...proxyArgs,
    ...pack.webrtcDefaultDenyArgs(givenArgs, fingerprint.webrtcIp),
    ...pack.gpuBlocklistArgs(merged.headless === false, process.platform, givenArgs),
    // The identity's own engine switches (native/graphics.mjs: the GPU pool entry, WebGPU's
    // software adapter by name with the service on), the helper's, never from browserArgs.
    ...plan.identitySwitches,
    ...userArgs,
  ]);
  const gated = pack.gateEngineSwitches(options.executablePath, args, false);
  const bridgeArgs = gated.args.filter(isCanvasBridgeSwitch);
  if (bridgeArgs.length) log(`launch: ${bridgeArgs.map((a) => a.split("=")[0]).join(", ")} stripped (the canvas bridge is gone)`);
  const finalArgs = gated.args.filter((a) => !isCanvasBridgeSwitch(a));
  // This launch's graphics (status reads GRAPHICS); the backend in use is read once it runs.
  Object.assign(GRAPHICS, { requested: settings.graphics, switches: backendSwitches(finalArgs), engineKeys: Object.keys(plan.engineKeys), shown: plan.identity ?? null, kind: "unverified", renderer: null, status: "unverified" });
  const env = launchEnv(config, { given: merged.env, pack, executablePath: options.executablePath, args: finalArgs, log });
  const contextAt = Date.now();
  const context = await chromium.launchPersistentContext(directory, {
    ...merged, proxy, ...(env ? { env } : {}),
    viewport: merged.viewport ?? null,
    // The sandbox is the helper's choice alone (engine.mjs launchEngine): never off from a saved
    // persona's options or a switch from the pack while it's on.
    chromiumSandbox: options.chromiumSandbox !== false,
    args: options.chromiumSandbox === false ? finalArgs : withoutNoSandbox(finalArgs),
    // The driver's --disable-blink-features=AutomationControlled is left out too: the build keeps
    // navigator.webdriver false on its own, and the engine shows that switch in a warning bar above
    // every page ("unsupported command-line flag"). So is the driver's --disable-background-networking:
    // with it the browser never checks the Web Store for extension updates nor refreshes Safe
    // Browsing's lists, as an everyday browser does.
    ignoreDefaultArgs: [...new Set([...pack.DEFAULT_IGNORED_ARGS, ...(merged.ignoreDefaultArgs ?? []), "--enable-automation", DRIVER_BLINK_SWITCH, DRIVER_BACKGROUND_SWITCH])],
  });
  log(`launch: launchPersistentContext ${Date.now() - contextAt} ms`);
  try {
    // The pack's humanized input, once for one pace or twice for the adaptive one (paced-motion.mjs).
    // The wheel's notch follows the platform pages are told about (the identity's Windows, else
    // the build's), so a scroll is whole notches of that size (wheel.mjs; the pack's own wheel).
    installPacedHumanize(context, (scope, given) => pack.installHumanizeOnContext(scope, given), { humanize: settings.humanize, showCursor: settings.showCursor, seed: fingerprint.fingerprint, wheelNotch: wheelNotch(plan.identity ? identityNamed(plan.identity)?.platform ?? PLATFORM : PLATFORM) }, paceSets(settings), log);
    return context;
  } catch (error) {
    try { await context.close?.(); } catch {}
    throw error;
  }
}
