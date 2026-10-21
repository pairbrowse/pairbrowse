// The native build's graphics, pure (server-mode spec, Phase E, E2, E7, E8, E9, E10): which
// backend a launch asks for and how (graphicsPlan), what can't be met (compatErrors), the runtime a
// measurement belongs to (runtimeKey), the one WebGPU shape the engine reads (normalizeWebgpu), and
// the last launch's graphics (GRAPHICS, as engine.mjs SANDBOX is the sandbox's).
//
// Graphics are always the runtime's own (decision D-AP2): on macOS the host capture (this Mac's GPU);
// on Linux the engine reports the real backend's WebGL strings, limits and extensions and WebGPU
// vendor and architecture (disableGpuFingerprint), without noise over real pixels
// (fingerprintNoise: false), and on the helper's virtual screen the real screen. A request that
// can't be met is an error naming it, never a partial apply. Node's standard library only.
import { createHash } from "node:crypto";
import { switchName } from "../browser-args.mjs";

// A profile's graphics.backend, and the default profile's config.json pairbrowse.graphics.
export const GRAPHICS_BACKENDS = Object.freeze(["auto", "software", "gpu"]);
// The engine's own software path on Linux (ANGLE on SwiftShader Vulkan; spike E-S1, step 39). It
// works without --enable-unsafe-swiftshader, which only allows the automatic fallback.
export const SOFTWARE_SWITCH = "--use-angle=swiftshader";
// The engine keys of the Linux plan: the real backend's strings, no noise over its pixels.
export const LINUX_REAL = Object.freeze({ disableGpuFingerprint: true, fingerprintNoise: false });
// What the plan sets on Xvfb: the virtual screen as the screen pages read (E7).
export const SCREEN_KEYS = Object.freeze(["screenWidth", "screenHeight", "availWidth", "availHeight", "colorDepth", "devicePixelRatio"]);
// The legacy GPU keys in config.json (decision U6): another device's GPU, deprecated for one
// release. On Linux the plan reports the real renderer, so none of them is applied there; the
// identity (vendor, renderer) is checked against the measured backend elsewhere.
export const LEGACY_GPU_KEYS = Object.freeze(["gpuVendor", "gpuRenderer", "gpuStringSpoof"]);
const LEGACY_IDENTITY = ["gpuVendor", "gpuRenderer"];
// The switches that pick the graphics path, as the runtime key and the plan read them.
const BACKEND_SWITCH = /^(?:disable-gpu|disable-gpu-compositing|use-gl|use-angle|use-vulkan|enable-unsafe-swiftshader|enable-unsafe-webgpu|disable-software-rasterizer)$/;
const SOFTWARE_ONLY = /^(?:disable-gpu|use-angle=swiftshader|use-gl=swiftshader|use-angle=swiftshader-webgl|use-gl=angle-swiftshader)$/;
const PLATFORM_NAMES = { darwin: "macOS", linux: "Linux", win32: "Windows" };
const RUNTIME_PLATFORMS = { darwin: "macos", linux: "linux" };

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (v) => typeof v === "number" && Number.isFinite(v);

// The engine pack's collector reports WebGPU as { info: { vendor, architecture, device,
// description }, limits, ... }; the engine's profile import reads webgpu.vendor and its siblings at
// the top. A profile with the nested form is flattened (info's fields, then its limits), from
// whichever layer it comes. Anything else (already flat, no adapter, not an object) comes back as
// it was, the same object; a flattened profile is a new object, the given one is never changed.
export function normalizeWebgpu(profile) {
  const webgpu = profile?.webgpu;
  if (!isObject(profile) || !isObject(webgpu) || !isObject(webgpu.info) || webgpu.vendor) return profile;
  return { ...profile, webgpu: { ...webgpu.info, limits: webgpu.limits } };
}

// This helper's browser's graphics as last launched: requested (the backend asked for), plan (the
// switches and engine keys the plan added, by name), and kind, renderer and status once the
// browser process's read (native/backend.mjs readBackend) is filed by the launch.
export const GRAPHICS = { requested: "auto", switches: [], engineKeys: [], kind: "unverified", renderer: null, status: "unverified" };

// The graphics switches among launch switches, as "--name=value" in their own order.
export const backendSwitches = (args = []) => (Array.isArray(args) ? args : [])
  .filter((a) => typeof a === "string" && BACKEND_SWITCH.test(switchName(a, "linux") ?? ""));
// A switch that makes the browser render in software whatever the hardware.
const softwareOnly = (a) => SOFTWARE_ONLY.test(String(a).replace(/^--?/, "").toLowerCase());

// The device pixel ratio a launch forces (--force-device-scale-factor), else 1: Xvfb's own.
function forcedRatio(args) {
  const given = args.filter((a) => typeof a === "string" && switchName(a, "linux") === "force-device-scale-factor").map((a) => Number(a.slice(a.indexOf("=") + 1)));
  const last = given.at(-1);
  return finite(last) && last > 0 && last <= 5 ? last : 1;
}

// One launch's graphics: { switches, engineKeys, refusals }.
// requested: the backend asked for (a profile's graphics.backend, or config.json's
// pairbrowse.graphics for the default profile). platform: process.platform's name. browserKind:
// "pairbrowse" (the native build) or "pairbrowse-open". measured: the backend read, when one is in
// hand ({ kind, renderer }, native/backend.mjs; null before the launch). userArgs: the launch's
// other switches (browserArgs, screened). display: the helper's virtual screen ({ width, height,
// depth }, display.mjs screenGeometry) or null; screenSet: a profile or config.json sets the screen
// (then E7 checks it against the display, compatErrors, and the plan sets none). name: the
// profile's, for the sentences. A refusal is { field, message }, one sentence each; with any,
// switches and engine keys are empty: the launch stops, nothing applies partly.
export function graphicsPlan({ requested = "auto", platform = process.platform, browserKind = "pairbrowse", measured = null, userArgs = [], display = null, screenSet = false, name = "default" } = {}) {
  const refusals = [];
  const refuse = (field, message) => refusals.push({ field, message });
  const args = Array.isArray(userArgs) ? userArgs.filter((a) => typeof a === "string") : [];
  const none = () => ({ switches: [], engineKeys: {}, refusals });
  if (!GRAPHICS_BACKENDS.includes(requested)) {
    refuse("graphics.backend", `graphics.backend takes "auto", "software" or "gpu".`);
    return none();
  }
  if (browserKind !== "pairbrowse") {
    if (requested !== "auto") refuse("graphics.backend", `Profile ${name} asks for graphics.backend: ${requested}, which only the native PairBrowse build can do; PairBrowse as an extension reports this computer's own graphics.`);
    return none();
  }
  const switches = [], engineKeys = {};
  const where = PLATFORM_NAMES[platform] ?? platform;
  if (platform === "linux") {
    Object.assign(engineKeys, LINUX_REAL);
    if (display && !screenSet && finite(display.width) && finite(display.height)) {
      Object.assign(engineKeys, { screenWidth: display.width, screenHeight: display.height, availWidth: display.width, availHeight: display.height,
        colorDepth: finite(display.depth) ? display.depth : 24, devicePixelRatio: forcedRatio(args) });
    }
  }
  const backendArgs = backendSwitches(args);
  if (requested === "software") {
    if (platform !== "linux") refuse("graphics.backend", `graphics.backend: software is not available on ${where} with this build.`);
    const other = backendArgs.find((a) => /^--?use-(?:angle|gl)=/i.test(a) && !softwareOnly(a));
    if (other) refuse("graphics.backend", `Profile ${name} asks for software graphics (graphics.backend: software) but browserArgs picks another renderer (${other.split("=")[0]}).`);
    if (platform === "linux") switches.push(SOFTWARE_SWITCH);
  } else if (requested === "gpu") {
    const forced = args.find(softwareOnly);
    if (forced) refuse("graphics.backend", `Profile ${name} asks for a GPU (graphics.backend: gpu) but browserArgs forces software rendering (${forced.split("=")[0]}); remove it or ask for "auto".`);
    if (measured?.kind === "software") refuse("graphics.backend", `Profile ${name} asks for a GPU (graphics.backend: gpu) but this computer renders in software (${measured.renderer || "a software renderer"}).`);
    else if (measured && measured.kind !== "hardware") refuse("graphics.backend", `Profile ${name} asks for a GPU (graphics.backend: gpu), and PairBrowse could not confirm which renderer this browser uses.`);
  }
  return refusals.length ? none() : { switches, engineKeys, refusals };
}

// Every graphics request that can't be met (E9), as { field, message }, one sentence each: the
// plan's refusals; graphics.require unmet by the measurement (its platforms before any); a legacy
// config.json GPU identity (decision U6) the measured backend can't back; canvasBridge; a set
// screen that differs from the virtual screen (E7); any graphics field on the open build. Static
// checks run without a measurement; the measured ones only with one, and with graphics.backend
// gpu or a requirement set, an unverified backend is an error ("could not confirm").
// graphics: the profile's { backend, require }. legacy: config.json's pairbrowse block (its
// gpuVendor and gpuRenderer are read; on Linux they aren't applied, so never an error there). canvasBridge: a layer sets it. screen: the profile's screen ({ width,
// height } or null). measured: { backend: { kind, renderer }, webgl, webgl2, webgpu } or null.
export function compatErrors({ name = "default", graphics = null, platform = process.platform, browserKind = "pairbrowse", measured = null, userArgs = [], display = null, screen = null, legacy = null, canvasBridge = false } = {}) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  const { backend = "auto", require: req = null } = isObject(graphics) ? graphics : {};
  const backendRead = isObject(measured?.backend) ? measured.backend : null;
  const read = measured ? backendRead ?? { kind: "unverified", renderer: null } : null;
  const plan = graphicsPlan({ requested: backend, platform, browserKind, measured: read, userArgs, display, screenSet: !!screen, name });
  errors.push(...plan.refusals);
  if (canvasBridge) add("canvasBridge", `Profile ${name} sets canvasBridge: refused, PairBrowse never sends what pages draw to another program (the canvas bridge is gone).`);
  if (browserKind !== "pairbrowse") {
    if (isObject(req)) add("graphics.require", `Profile ${name} sets graphics.require, which only the native PairBrowse build checks.`);
    return errors;
  }
  if (platform === "linux" && display && isObject(screen) && (screen.width !== display.width || screen.height !== display.height)) {
    add("screen", `Profile ${name} sets a ${screen.width}x${screen.height} screen but the virtual screen is ${display.width}x${display.height} (virtualScreen).`);
  }
  if (isObject(req)) {
    const here = RUNTIME_PLATFORMS[platform] ?? platform;
    if (Array.isArray(req.platforms) && req.platforms.length && !req.platforms.includes(here)) add("graphics.require", `Profile ${name} requires ${req.platforms.join(" or ")}, and this computer runs ${PLATFORM_NAMES[platform] ?? platform}.`);
    if (measured) {
      if (read.kind !== "hardware" && read.kind !== "software") {
        add("graphics.require", `Profile ${name} sets graphics requirements, and PairBrowse could not confirm which renderer this browser uses.`);
      } else {
        if (req.webgl === 2 && measured.webgl2?.available !== true) add("graphics.require", `Profile ${name} requires WebGL2 but it is not available here (${measured.webgl2?.reason || "no WebGL2 context"}).`);
        if (req.webgl === 1 && measured.webgl?.available !== true) add("graphics.require", `Profile ${name} requires WebGL but it is not available here (${measured.webgl?.reason || "no WebGL context"}).`);
        if (req.webgpu === true && measured.webgpu?.available !== true) add("graphics.require", `Profile ${name} requires WebGPU but no adapter is available here (${measured.webgpu?.reason || "no adapter"}).`);
      }
    }
  }
  const legacyKeys = isObject(legacy) ? LEGACY_IDENTITY.filter((k) => legacy[k] !== undefined) : [];
  if (legacyKeys.length && platform !== "linux" && backendRead && legacyCantBack(legacy, backendRead)) {
    add(`pairbrowse.${legacyKeys[0]}`, `config.json sets a GPU identity (${legacyKeys.join(", ")}) that this computer's ${backendRead.kind} renderer cannot back.`);
  }
  return errors;
}

// A legacy GPU identity the measured backend can't back: any over a software or unverified backend,
// or one whose first word (its vendor) isn't in the measured renderer. (On Linux none is applied.)
function legacyCantBack(legacy, backend) {
  if (backend.kind !== "hardware") return true;
  const renderer = String(backend.renderer || "").toLowerCase();
  const vendor = String(legacy.gpuVendor || legacy.gpuRenderer || "").toLowerCase().match(/[a-z]+/)?.[0];
  return !!vendor && !renderer.includes(vendor);
}

// What a measurement belongs to (E8): SHA-256 over the engine build, the engine pack's SHA-256, the
// platform, arch, display kind ("native" or "xvfb"), the GPU's vendor and device IDs and driver
// version from SystemInfo, and the launch's backend switches (in order, as given). A change in any
// is another runtime, measured once again. null without a build, platform, arch or display kind.
export function runtimeKey({ build, pack = null, platform, arch, display, backend = null, switches = [] } = {}) {
  if (![build, platform, arch, display].every((v) => typeof v === "string" && v)) return null;
  const b = isObject(backend) ? backend : {};
  const gpu = { vendor: b.vendor ?? null, device: b.device ?? null, driver: b.driver ?? null };
  const key = { build, pack: typeof pack === "string" ? pack : null, platform, arch, display, gpu, switches: backendSwitches(switches) };
  return createHash("sha256").update(JSON.stringify(key)).digest("hex");
}

// pairbrowse_status's part for the running browser (spec Phase E design): "Graphics: <kind>
// (<renderer>), requested <backend>, <status> on <build>". g: GRAPHICS as the launch filed it.
// renderer: false leaves the renderer out (a joiner's agent, like a report, gets the kind and
// status only: row E-3). build: the native build's version; none on the open build.
export function graphicsStatusPart(g = GRAPHICS, { build = null, renderer = true } = {}) {
  const kind = ["hardware", "software"].includes(g?.kind) ? g.kind : "unverified";
  const name = renderer && kind !== "unverified" && typeof g?.renderer === "string" && g.renderer ? ` (${g.renderer.slice(0, 80)})` : "";
  const status = ["validated", "failed"].includes(g?.status) ? g.status : "unverified";
  return `Graphics: ${kind}${name}, requested ${GRAPHICS_BACKENDS.includes(g?.requested) ? g.requested : "auto"}, ${status} on ${build || "PairBrowse as an extension"}`;
}
