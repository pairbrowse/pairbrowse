// Requested against measured (spec server-mode Phase E, E5, E6, E8): what a profile asked for and
// what the launch derived, checked against what the runtime measured, as the profile's
// validation[build] entry (Phase D's shape, D10).
//
// Value classes (E5): requested (the profile or config.json), measured (the browser process's
// SystemInfo read, E3, and the probe's page, E4), derived (the build or seed: the user agent's
// major, cores, memory, media capabilities), unverified (no measurement). measuredRecord keeps a
// measurement in one fixed, bounded shape, the one stored as validation[build].graphics (E8:
// requests stay in the profile's graphics, measurements here, and neither bumps the revision).
//
// validate({ requested, derived, measured, live }) runs RULES in order, one item per rule that
// applies (field, rule, class, status, requested, measured, severity, reason; the class from the
// property matrix, native/properties.mjs). Status (E6):
// - "validated" only with a measurement of this build's engine pack and runtime key, every
//   error-severity rule matched;
// - "consistent": the same, under the identity a host without a GPU shows (decision 10; the
//   measurement's shown names it, native/graphics.mjs GPU_LESS_IDENTITY): WebGL's strings and the
//   WebGPU adapter are checked for consistency with that identity and with each other, never for
//   equality with the host's software renderer;
// - "failed" when an error-severity rule found a mismatch: a value that disagrees, or a part the
//   page didn't answer although the launch passed a switch for it (a switch without a matching
//   page result counts as failed);
// - "unverified" otherwise: no measurement, one of another pack or runtime key, or an
//   error-severity rule that couldn't tell.
// Warning and info rules are reported and never change the status.
//
// Host GPU strings stay in the profile's 0600 file (reasons may name the renderer); nothing here
// writes or logs. Pure; Node's standard library only.
import { classOf, runtimeOf } from "./properties.mjs";
import { GPU_LESS_IDENTITY, PASSING_STATUSES, shownIdentity } from "./graphics.mjs";
import { rendererFamily, softwareRenderer as softwareName, gpuVsPlatform, gpuSoftwareAsHardware, screenBelievable, platformOf } from "../rules/coherence.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const BUILD = /^\d{1,4}(?:\.\d{1,6}){3}$/;
// The engine's sandbox status page (Linux): the namespace layer, and seccomp-BPF where the kernel
// isn't emulated (spec step 39).
const PAGE_LAYERS = [["the namespace layer", /^Layer 1 Sandbox\tNamespace$/], ["PID namespaces", /^PID namespaces\tYes$/],
  ["network namespaces", /^Network namespaces\tYes$/]];
const SECCOMP = ["seccomp-BPF", /^Seccomp-BPF sandbox\tYes$/];

const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
// Characters JSON writes in at most two (no control character but tab and line breaks, no lone
// surrogate), so a cut string's size as JSON is at most twice its length.
const printable = (s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "");
const text = (v, max = 200) => (typeof v === "string" ? printable(v).slice(0, max) : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v) => (typeof v === "boolean" ? v : null);
const oneOf = (v, list) => (list.includes(v) ? v : null);
const short = (v, max = 120) => (typeof v === "string" && v.length > max ? `${v.slice(0, max - 3)}...` : v);

// --- The measured record (E8) -------------------------------------------------------------------

function glPart(raw) {
  if (!plainObject(raw)) return null;
  return {
    available: bool(raw.available), reason: text(raw.reason, 160),
    unmaskedVendor: text(raw.unmaskedVendor, 80), unmaskedRenderer: text(raw.unmaskedRenderer, 160), version: text(raw.version, 100),
    maxTextureSize: num(raw.maxTextureSize), maxRenderbufferSize: num(raw.maxRenderbufferSize),
    extensions: num(raw.extensions), sameOrigins: bool(raw.sameOrigins),
  };
}
function outcome(raw) {
  if (raw === true || raw === "ok") return { ok: true, error: null };
  if (typeof raw === "string") return { ok: false, error: text(raw, 160) };
  if (plainObject(raw) && typeof raw.ok === "boolean") return { ok: raw.ok, error: raw.ok ? null : text(raw.error, 160) };
  return null;
}
function webgpuPart(raw) {
  if (!plainObject(raw)) return null;
  const limits = {};
  if (plainObject(raw.limits)) for (const [k, v] of Object.entries(raw.limits).slice(0, 48)) if (/^[A-Za-z0-9]{1,40}$/.test(k) && Number.isSafeInteger(v) && v >= 0) limits[k] = v;
  return {
    available: bool(raw.available), reason: text(raw.reason, 160),
    vendor: text(raw.vendor, 80), architecture: text(raw.architecture, 80), isFallbackAdapter: bool(raw.isFallbackAdapter),
    // Feature names are lowercase words joined by hyphens ("texture-compression-bc").
    features: Array.isArray(raw.features) ? raw.features.filter((f) => typeof f === "string" && /^[a-z0-9-]{1,48}$/.test(f)).slice(0, 40) : [],
    limits, requestDevice: outcome(raw.requestDevice ?? raw.deviceWithReportedLimits),
    // The compute round trip answers its numbers ("2,4,6,8") or an error.
    compute: outcome(typeof raw.compute === "string" && /^[\d,]+$/.test(raw.compute) ? true : raw.compute),
  };
}
// An object of short primitive answers (media: codec and capability answers), at most 16 keys.
function answers(raw) {
  if (!plainObject(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw).slice(0, 16)) {
    if (!/^[\w.;=", /+-]{1,64}$/.test(k)) continue;
    if (typeof v === "boolean" || num(v) !== null || v === null) out[k] = v;
    else if (typeof v === "string") out[k] = text(v, 16);
  }
  return out;
}
const names = (v, max = 16, len = 48) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, max).map((x) => text(x, len)) : []);
function sandboxPart(raw) {
  if (!plainObject(raw)) return { on: null, page: null };
  const page = Array.isArray(raw.page) ? raw.page.filter((l) => typeof l === "string").slice(0, 16).map((l) => text(l, 80))
    : oneOf(raw.page, ["not on macOS", "timeout", "not shown"]);
  return { on: bool(raw.on), page };
}

// A measurement in the one shape stored as validation[build].graphics (bounded: strings cut, at
// most 40 WebGPU features, 48 limits, 16 sandbox page lines and media answers, 12 font names per
// list, nothing outside the shape; at its largest it stays within the schema's 20000 characters
// as JSON), or null when it isn't one (no time, runtime key, or runtime). raw: the probe's record (native/probe.mjs, step 42) with the
// browser process's read as backend (native/backend.mjs readBackend's answer).
export function measuredRecord(raw) {
  if (!plainObject(raw) || typeof raw.at !== "string" || !ISO_TIME.test(raw.at) || typeof raw.runtimeKey !== "string" || !SHA256.test(raw.runtimeKey)) return null;
  const rt = raw.runtime;
  if (!plainObject(rt)) return null;
  const platform = oneOf(rt.platform, ["macos", "linux"]), arch = oneOf(rt.arch, ["arm64", "x64"]), display = oneOf(rt.display, ["native", "xvfb"]);
  if (!platform || !arch || !display) return null;
  const b = raw.backend;
  const scr = raw.screen, loc = raw.locale, nav = raw.navigator, canvas = raw.canvas, fonts = raw.fonts;
  return {
    at: raw.at, runtimeKey: raw.runtimeKey, pack: typeof raw.pack === "string" && SHA256.test(raw.pack) ? raw.pack : null,
    runtime: { platform, arch, display, emulated: rt.emulated === true, sandbox: sandboxPart(rt.sandbox) },
    // The identity the launch showed pages (decision 10), or null: the runtime's own graphics.
    shown: text(raw.shown, 80),
    backend: plainObject(b) ? { kind: oneOf(b.kind, ["hardware", "software", "unverified"]) || "unverified", vendor: num(b.vendor) ?? text(b.vendor, 80),
      device: num(b.device) ?? text(b.device, 80), renderer: text(b.renderer, 160), driver: text(b.driver, 80), source: "systeminfo" } : null,
    webgl: glPart(raw.webgl), webgl2: glPart(raw.webgl2), webgpu: webgpuPart(raw.webgpu),
    canvas: plainObject(canvas) ? { stable: bool(canvas.stable), repeat: bool(canvas.repeat), noise: bool(canvas.noise) } : null,
    fonts: plainObject(fonts) ? { checked: num(fonts.checked), missing: names(fonts.missing, 12), controlFound: names(fonts.controlFound, 12) } : null,
    media: answers(raw.media),
    screen: plainObject(scr) ? { width: num(scr.width), height: num(scr.height), availWidth: num(scr.availWidth), availHeight: num(scr.availHeight),
      colorDepth: num(scr.colorDepth), devicePixelRatio: num(scr.devicePixelRatio) } : null,
    locale: plainObject(loc) ? { timezone: text(loc.timezone, 64), languages: names(loc.languages, 10, 35) } : null,
    navigator: plainObject(nav) ? { userAgent: text(nav.userAgent, 300), platform: text(nav.platform, 60),
      hardwareConcurrency: num(nav.hardwareConcurrency), deviceMemory: num(nav.deviceMemory) } : null,
  };
}

// --- Rules --------------------------------------------------------------------------------------

// Renderer families and software names: rules/coherence.mjs (rendererFamily), shared with the
// coherence rules below.
const backendFamily = (b) => (b.kind === "software" ? "software" : rendererFamily(b.renderer) || (b.kind === "hardware" ? null : "software"));
// The identity a measurement was made under (decision 10): GPU_LESS_IDENTITY when the record names
// it; { unknown: true, name } for a name PairBrowse doesn't know (never checked as consistent); null
// for the runtime's own graphics.
const identityOf = (m) => (typeof m?.shown === "string" && m.shown ? (shownIdentity(m) ? GPU_LESS_IDENTITY : { unknown: true, name: m.shown }) : null);
// Whether the WebGL renderer pages read is the identity's: its family and its name.
const rendererIsIdentity = (identity, renderer) => !identity.unknown && rendererFamily(renderer) === identity.family && identity.renderer.test(String(renderer || ""));
// Whether an available WebGPU adapter is the identity's: vendor and architecture, not a fallback.
const adapterIsIdentity = (identity, g) => !identity.unknown && g.vendor === identity.webgpu.vendor && g.architecture === identity.webgpu.architecture && g.isFallbackAdapter !== true;
const gl = (m) => (m.webgl?.available ? m.webgl : m.webgl2?.available ? m.webgl2 : null);
const pow2 = (n) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

const matched = (reason, requested = null, measured = null) => ({ status: "matched", reason, requested, measured });
const mismatch = (reason, requested = null, measured = null) => ({ status: "mismatch", reason, requested, measured });
const unverified = (reason, requested = null) => ({ status: "unverified", reason, requested, measured: null });
const derivedValue = (reason, measured) => ({ status: "derived", reason, requested: null, measured });

// A part the measurement doesn't hold: unverified, or a mismatch when the launch passed a switch
// for it (E6: a switch without a matching page result counts as failed).
function absent(ctx, rule, what, requested = null) {
  if (!ctx.measured) return unverified("not measured on this runtime yet", requested);
  const sw = rule.switches ? ctx.switches.find((s) => rule.switches.test(s)) : null;
  if (sw) return mismatch(`the launch passed ${sw.split("=")[0]}, and the page answered nothing for ${what}`, requested);
  return unverified(`the page answered nothing for ${what}`, requested);
}

// Each rule: { id, severity, field, switches? (the launch switches a page result must answer),
// check(ctx, rule) } answering null (doesn't apply), one result or several ({ status, reason,
// requested, measured, field? }). ctx: { requested, derived, measured, live, switches, platform }.
export const RULES = Object.freeze([
  { id: "backend.requested", severity: "error", field: "graphics.backend", switches: /^--(?:disable-gpu|use-angle|use-gl)\b/,
    check(ctx, rule) {
      const want = ctx.requested.graphics?.backend || "auto";
      if (want === "software" && ctx.platform === "macos") return mismatch("graphics.backend: software is not available on macOS with this build.", want);
      const b = ctx.measured?.backend;
      if (!b) return absent(ctx, rule, "the backend", want);
      if (b.kind === "unverified") return unverified("the browser process didn't say which renderer it uses", want);
      const got = `${b.kind}${b.renderer ? ` (${short(b.renderer)})` : ""}`;
      if (want === "gpu" && b.kind !== "hardware") return mismatch(`the profile asks for a GPU (graphics.backend: gpu) but this computer renders in software${b.renderer ? ` (${short(b.renderer)})` : ""}`, want, b.kind);
      if (want === "software" && b.kind !== "software") return mismatch(`the profile asks for software rendering but the browser renders on hardware${b.renderer ? ` (${short(b.renderer)})` : ""}`, want, b.kind);
      return matched(want === "auto" ? `this computer's: ${got}` : got, want, b.kind);
    } },
  { id: "backend.stable", severity: "error", field: "graphics.backend",
    check(ctx) {
      const b = ctx.measured?.backend, live = ctx.live;
      if (!b || !plainObject(live)) return null;
      if (live.kind === "unverified" || !live.kind) return unverified("this launch's browser didn't say which renderer it uses");
      if (live.kind !== b.kind || (live.renderer || null) !== (b.renderer || null)) return mismatch(`measured ${b.kind}${b.renderer ? ` (${short(b.renderer)})` : ""}, and this launch runs ${live.kind}${live.renderer ? ` (${short(live.renderer)})` : ""}`, null, live.kind);
      return matched("this launch runs the measured backend", null, live.kind);
    } },
  { id: "require.webgl", severity: "error", field: "graphics.require",
    check(ctx, rule) {
      const want = ctx.requested.graphics?.require?.webgl;
      if (!want) return null;
      const part = want === 2 ? ctx.measured?.webgl2 : ctx.measured?.webgl;
      if (!part) return absent(ctx, rule, `WebGL${want === 2 ? "2" : ""}`, want);
      return part.available ? matched(`WebGL${want === 2 ? "2" : ""} is available`, want, true)
        : mismatch(`the profile requires WebGL${want === 2 ? "2" : ""} but this browser has none here${part.reason ? ` (${short(part.reason)})` : ""}`, want, false);
    } },
  { id: "require.webgpu", severity: "error", field: "graphics.require",
    check(ctx, rule) {
      if (ctx.requested.graphics?.require?.webgpu !== true) return null;
      const g = ctx.measured?.webgpu;
      if (!g) return absent(ctx, rule, "WebGPU", true);
      return g.available ? matched("a WebGPU adapter is available", true, true)
        : mismatch(`the profile requires WebGPU but no adapter is available here (${short(g.reason) || "no reason given"})`, true, false);
    } },
  { id: "require.platforms", severity: "error", field: "graphics.require",
    check(ctx) {
      const list = ctx.requested.graphics?.require?.platforms;
      if (!Array.isArray(list) || !list.length) return null;
      return list.includes(ctx.platform) ? matched(`runs on ${ctx.platform}`, list, ctx.platform)
        : mismatch(`the profile runs only on ${list.join(" or ")}, and this is ${ctx.platform}`, list, ctx.platform);
    } },
  { id: "webgl.strings-vs-backend", severity: "error", field: "webgl.strings", switches: /^--(?:use-angle|use-gl)\b/,
    check(ctx, rule) {
      if (!ctx.measured?.webgl || !ctx.measured.webgl2) return absent(ctx, rule, "WebGL's strings");
      const part = gl(ctx.measured), b = ctx.measured.backend;
      if (!part) return null;
      if (!b || b.kind === "unverified") return unverified("the browser process didn't say which renderer it uses");
      const page = rendererFamily(part.unmaskedRenderer), proc = backendFamily(b);
      const shown = short(part.unmaskedRenderer);
      // Under the identity a host without a GPU shows (decision 10): pages read that identity, over
      // software rendering only; checked against the identity, not against the host.
      const identity = identityOf(ctx.measured);
      if (identity) {
        if (identity.unknown) return mismatch(`the launch shows an identity PairBrowse doesn't know (${short(identity.name)})`, identity.name, shown);
        if (proc !== "software") return mismatch(`the launch shows ${identity.name} over a ${proc} backend; an identity is shown over software rendering only`, identity.name, shown);
        return rendererIsIdentity(identity, part.unmaskedRenderer) ? matched(`pages read the identity shown over software rendering (${identity.name})`, identity.name, shown)
          : mismatch(`pages read ${shown} while the launch shows ${identity.name}`, identity.name, shown);
      }
      if ((page === "software") !== (proc === "software")) {
        return mismatch(proc === "software" ? `pages read a hardware renderer (${shown}) while the browser renders in software` : `pages read a software renderer (${shown}) while the browser renders on hardware`, null, shown);
      }
      if (page && proc && page !== proc) return mismatch(`pages read ${page} (${shown}) while the browser renders on ${proc}`, null, shown);
      return matched("pages read the backend's own renderer", null, shown);
    } },
  { id: "webgl.limits-vs-backend", severity: "error", field: "webgl.limits",
    check(ctx) {
      const one = ctx.measured?.webgl, two = ctx.measured?.webgl2;
      if (!one?.available) return null;
      const sizes = [one.maxTextureSize, one.maxRenderbufferSize, ...(two?.available ? [two.maxTextureSize, two.maxRenderbufferSize] : [])];
      if (!sizes.every(pow2)) return mismatch("WebGL's texture or renderbuffer limit isn't a power of two, which no backend reports", null, sizes);
      if (two?.available && (two.maxTextureSize !== one.maxTextureSize || two.maxRenderbufferSize !== one.maxRenderbufferSize)) {
        return mismatch("WebGL and WebGL2 report different limits over one backend", null, sizes);
      }
      return matched("WebGL and WebGL2 report one backend's limits", null, one.maxTextureSize);
    } },
  { id: "webgl.context", severity: "error", field: "webgl.strings",
    check(ctx, rule) {
      if (!ctx.measured) return unverified("not measured on this runtime yet");
      const part = ctx.measured.webgl;
      if (!part) return absent(ctx, rule, "WebGL");
      const off = ctx.switches.some((s) => /^--disable-gpu$/.test(s));
      if (part.available) return matched("a WebGL context was made", null, true);
      return off ? matched("no WebGL with --disable-gpu, as asked", null, false) : mismatch(`no WebGL context was made${part.reason ? ` (${short(part.reason)})` : ""}`, null, false);
    } },
  { id: "webgpu.vendor", severity: "error", field: "webgpu.vendor",
    check(ctx) {
      const g = ctx.measured?.webgpu, b = ctx.measured?.backend;
      if (!g?.available || !b || b.kind === "unverified") return null;
      const named = `${g.vendor || "?"}/${g.architecture || "?"}`;
      const identity = identityOf(ctx.measured);
      if (identity) {
        // Under the identity (decision 10; patch 961 makes WebGPU follow it): the adapter is the
        // identity's vendor and architecture, never a fallback adapter.
        if (identity.unknown) return mismatch(`the launch shows an identity PairBrowse doesn't know (${short(identity.name)})`, identity.name, named);
        const want = `${identity.webgpu.vendor}/${identity.webgpu.architecture}`;
        return adapterIsIdentity(identity, g) ? matched(`the adapter follows the identity shown (${want})`, want, named)
          : mismatch(`the WebGPU adapter says ${named}${g.isFallbackAdapter === true ? " (a fallback adapter)" : ""} while the launch shows ${identity.name} (${want})`, want, named);
      }
      const soft = g.isFallbackAdapter === true || softwareName(g.architecture) || softwareName(g.vendor);
      if (backendFamily(b) === "software") return soft ? matched(`a software adapter (${named})`, null, named) : mismatch(`the WebGPU adapter says ${named} while the browser renders in software`, null, named);
      if (soft) return mismatch(`the WebGPU adapter is a software one (${named}) while the browser renders on hardware`, null, named);
      const family = rendererFamily(g.vendor), proc = backendFamily(b);
      if (family && proc && family !== proc) return mismatch(`the WebGPU adapter says ${named} while the browser renders on ${proc}`, null, named);
      return matched(`the adapter is the backend's (${named})`, null, named);
    } },
  { id: "webgpu.device", severity: "error", field: "webgpu.limits", switches: /^--enable-unsafe-webgpu$/,
    check(ctx, rule) {
      const g = ctx.measured?.webgpu;
      if (!g?.available) return null;
      if (!g.requestDevice) return absent(ctx, rule, "requestDevice with the reported limits");
      return g.requestDevice.ok ? matched("requestDevice with the reported limits works", null, true)
        : mismatch(`requestDevice with the adapter's reported limits fails (${short(g.requestDevice.error?.split("\n")[0]) || "no reason given"}): pages read limits the adapter can't give`, null, false);
    } },
  { id: "canvas.stable", severity: "error", field: "webgl.pixels",
    check(ctx, rule) {
      const v = ctx.measured?.canvas?.stable;
      if (typeof v !== "boolean") return absent(ctx, rule, "the canvas scenes");
      return v ? matched("the same scene drew the same pixels twice in one page", null, true) : mismatch("one scene drew different pixels twice in one page", null, false);
    } },
  { id: "canvas.repeat", severity: "error", field: "webgl.pixels",
    check(ctx, rule) {
      const v = ctx.measured?.canvas?.repeat;
      if (typeof v !== "boolean") return absent(ctx, rule, "the canvas scenes across launches");
      return v ? matched("the scenes drew the same pixels across two launches", null, true) : mismatch("the scenes drew different pixels across two launches", null, false);
    } },
  { id: "screen.display", severity: "error", field: "screen",
    check(ctx, rule) {
      const want = ctx.requested.screen || (ctx.measured?.runtime.display === "xvfb" ? ctx.derived.virtualScreen : null);
      if (!plainObject(want)) return null;
      const got = ctx.measured?.screen;
      const size = (s) => `${s.width}x${s.height}`;
      if (!got) return absent(ctx, rule, "the screen", size(want));
      const keys = ctx.requested.screen ? ["width", "height", "availWidth", "availHeight", "colorDepth", "devicePixelRatio"] : ["width", "height"];
      const off = keys.filter((k) => want[k] !== undefined && want[k] !== null && got[k] !== want[k]);
      const whose = ctx.requested.screen ? "the profile sets" : "the virtual screen is";
      return off.length ? mismatch(`${whose} a ${size(want)} screen but pages read ${size(got)} (${off.join(", ")})`, size(want), size(got)) : matched(`pages read ${size(got)}`, size(want), size(got));
    } },
  { id: "locale", severity: "error", field: "locale.timezone", switches: /^--lang=/,
    check(ctx, rule) {
      const { timezone = null, languages = null } = ctx.requested.locale || {};
      const out = [];
      const got = ctx.measured?.locale;
      if (timezone) {
        if (!got) out.push({ ...absent(ctx, rule, "the time zone", timezone), field: "locale.timezone" });
        else out.push({ ...(got.timezone === timezone ? matched("pages read the profile's time zone", timezone, got.timezone) : mismatch(`pages read ${got.timezone || "no time zone"}, not the profile's`, timezone, got.timezone)), field: "locale.timezone" });
      }
      if (Array.isArray(languages) && languages.length) {
        if (!got) out.push({ ...absent(ctx, rule, "the languages", languages[0]), field: "locale.languages" });
        else out.push({ ...(got.languages[0] === languages[0] ? matched("pages read the profile's first language", languages[0], got.languages[0]) : mismatch(`pages read ${got.languages[0] || "no language"} first, not the profile's`, languages[0], got.languages[0] || null)), field: "locale.languages" });
      }
      return out.length ? out : null;
    } },
  { id: "ua.build", severity: "error", field: "ua.version",
    check(ctx, rule) {
      const major = typeof ctx.derived.build === "string" && BUILD.test(ctx.derived.build) ? ctx.derived.build.split(".")[0] : null;
      if (!major) return null;
      const ua = ctx.measured?.navigator?.userAgent;
      if (!ua) return absent(ctx, rule, "the user agent", major);
      return ua.includes(`/${major}.`) ? matched(`the user agent names engine ${major}`, major, major) : mismatch(`the user agent doesn't name this build's engine ${major}`, major, null);
    } },
  { id: "sandbox.on", severity: "error", field: "sandbox",
    check(ctx) {
      if (!ctx.measured) return unverified("not measured on this runtime yet", true);
      const { on, page } = ctx.measured.runtime.sandbox;
      if (on === false) return mismatch("the browser ran without its sandbox", true, false);
      if (on !== true) return unverified("the launch didn't say whether the sandbox was on", true);
      if (ctx.platform === "macos") return matched("on (the macOS build has no sandbox page)", true, true);
      if (!Array.isArray(page)) return unverified(page === "timeout" ? "the sandbox page timed out" : "the sandbox page wasn't shown", true);
      const lines = page.map((l) => l.trim());
      const required = ctx.measured.runtime.emulated ? PAGE_LAYERS : [...PAGE_LAYERS, SECCOMP];
      const missing = required.filter(([, re]) => !lines.some((l) => re.test(l))).map(([what]) => what);
      return missing.length ? mismatch(`the sandbox page shows ${missing.join(", ")} missing`, true, false)
        : matched(`on, with ${required.map(([what]) => what).join(", ")}${ctx.measured.runtime.emulated ? " (seccomp-BPF not required under emulation)" : ""}`, true, true);
    } },
  { id: "bridge.absent", severity: "error", field: "canvas.bridge",
    check(ctx) {
      const sw = ctx.switches.find((s) => /^--canvas-bridge/.test(s));
      return sw ? mismatch(`the launch passed ${sw.split("=")[0]}`, null, true) : matched("no canvas bridge switch reached the launch", null, false);
    } },
  { id: "webgl.same-origins", severity: "warning", field: "webgl.pixels",
    check(ctx) {
      const v = ctx.measured?.webgl?.sameOrigins;
      if (typeof v !== "boolean") return null;
      return v ? matched("the same WebGL results on 127.0.0.1 and localhost", null, true) : mismatch("WebGL differs between 127.0.0.1 and localhost", null, false);
    } },
  { id: "webgpu.features-vs-limits", severity: "warning", field: "webgpu.adapter",
    check(ctx) {
      const g = ctx.measured?.webgpu;
      if (!g?.available) return null;
      const l = g.limits;
      const broken = [];
      const atMost = (a, b) => { if (num(l[a]) !== null && num(l[b]) !== null && l[a] > l[b]) broken.push(`${a} over ${b}`); };
      atMost("maxComputeWorkgroupSizeX", "maxComputeInvocationsPerWorkgroup");
      atMost("maxComputeWorkgroupSizeY", "maxComputeInvocationsPerWorkgroup");
      atMost("maxBindGroups", "maxBindGroupsPlusVertexBuffers");
      atMost("maxStorageBuffersInFragmentStage", "maxStorageBuffersPerShaderStage");
      atMost("maxStorageBuffersInVertexStage", "maxStorageBuffersPerShaderStage");
      atMost("maxStorageTexturesInFragmentStage", "maxStorageTexturesPerShaderStage");
      atMost("maxUniformBufferBindingSize", "maxBufferSize");
      if (!Object.keys(l).length) broken.push("no limits reported");
      return broken.length ? mismatch(`the adapter's limits don't fit together (${broken.slice(0, 3).join(", ")})`, null, g.features.length) : matched(`${g.features.length} features and limits that fit together`, null, g.features.length);
    } },
  { id: "fonts.available", severity: "warning", field: "fonts",
    check(ctx, rule) {
      const f = ctx.measured?.fonts;
      if (!f) return absent(ctx, rule, "the fonts");
      if (f.controlFound.length) return mismatch(`the page says fonts that aren't installed are there (${f.controlFound.slice(0, 3).join(", ")})`, null, f.controlFound.length);
      return f.missing.length ? mismatch(`${f.missing.length} of the persona's fonts don't resolve (${f.missing.slice(0, 3).join(", ")})`, null, f.missing.length)
        : matched("every persona font resolves", null, f.checked);
    } },
  { id: "media.capabilities", severity: "info", field: "media.capabilities",
    check(ctx, rule) {
      const m = ctx.measured?.media;
      if (!m) return absent(ctx, rule, "media capabilities");
      return derivedValue("from the persona (derived, never measured hardware)", Object.keys(m).length);
    } },
  { id: "memory", severity: "info", field: "memory",
    check(ctx) {
      const n = ctx.measured?.navigator;
      if (!n) return null;
      return derivedValue("from the persona (derived, never measured hardware)", { deviceMemory: n.deviceMemory, hardwareConcurrency: n.hardwareConcurrency });
    } },
]);
export const RULE_IDS = Object.freeze(RULES.map((r) => r.id));

// The E13 coherence rules (rules/coherence.mjs) as validation items, after RULES: on the
// measurement, gpu.vs-platform (WebGL's renderer against the system navigator.platform names) and
// gpu.software-as-hardware (a hardware renderer or adapter over a software backend); on the
// request, screen.believable (the profile's screen and window, warnings only). Each answers a
// matched item where it could tell and found nothing, else one mismatch per problem; a rule that
// can't tell gives no item. Errors here fail the entry as RULES' errors do (E6).
export const COHERENCE = Object.freeze([
  { id: "gpu.vs-platform", severity: "error", field: "platform",
    check(ctx) {
      const m = ctx.measured, page = m ? gl(m) : null;
      const platform = m?.navigator?.platform || m?.runtime.platform;
      if (!page?.unmaskedRenderer || !platformOf(platform)) return null;
      // Pages read the GPU the browser really renders on (an Apple GPU under Linux through Mesa's
      // asahi driver, a Linux guest on Apple Silicon whose virgl renderer names Apple): nothing
      // PairBrowse made up, so nothing for it to fix.
      const family = rendererFamily(page.unmaskedRenderer);
      if (m.backend?.kind === "hardware" && family && family !== "software" && rendererFamily(m.backend.renderer) === family) {
        return matched(`pages read the ${family} GPU the browser renders on`, platform, short(page.unmaskedRenderer));
      }
      const found = gpuVsPlatform({ platform, renderer: page.unmaskedRenderer });
      return found.length ? found.map((c) => mismatch(c.text, platform, short(page.unmaskedRenderer))) : matched(`a ${rendererFamily(page.unmaskedRenderer) || "named"} renderer fits ${platform}`, platform, short(page.unmaskedRenderer));
    } },
  { id: "gpu.software-as-hardware", severity: "error", field: "webgl.strings",
    check(ctx) {
      const m = ctx.measured, b = m?.backend;
      if (!b || b.kind !== "software") return null;
      const page = gl(m), g = m.webgpu?.available ? m.webgpu : null;
      if (!page?.unmaskedRenderer && !g) return null;
      // Under the identity a host without a GPU shows (decision 10) a hardware identity over
      // software rendering is the design: what is checked is that WebGL and WebGPU show one and the
      // same identity, the engine's.
      const identity = identityOf(m);
      if (identity) {
        const read = short(page?.unmaskedRenderer || g?.vendor || null);
        if (identity.unknown) return mismatch(`the launch shows an identity PairBrowse doesn't know (${short(identity.name)})`, identity.name, read);
        const off = [];
        if (page?.unmaskedRenderer && !rendererIsIdentity(identity, page.unmaskedRenderer)) off.push(`WebGL reads ${short(page.unmaskedRenderer)}`);
        if (g && !adapterIsIdentity(identity, g)) off.push(`the WebGPU adapter says ${g.vendor || "?"}/${g.architecture || "?"}${g.isFallbackAdapter === true ? " (a fallback adapter)" : ""}`);
        return off.length ? off.map((text) => mismatch(`${text} while the launch shows ${identity.name} over software rendering`, identity.name, read))
          : matched(`pages read one identity over software rendering (${identity.name}), WebGL${g ? " and WebGPU" : ""} agreeing`, identity.name, read);
      }
      const found = gpuSoftwareAsHardware({ backend: b, renderer: page?.unmaskedRenderer || null, adapter: g });
      return found.length ? found.map((c) => mismatch(c.text, null, short(page?.unmaskedRenderer || g?.vendor || null))) : matched("pages read software rendering, as the browser does", null, short(page?.unmaskedRenderer || g?.vendor || null));
    } },
  { id: "screen.believable", severity: "warning", field: "screen",
    check(ctx) {
      const s = ctx.requested.screen;
      if (!plainObject(s)) return null;
      const win = plainObject(ctx.requested.window) ? ctx.requested.window : null;
      const found = screenBelievable(s, { window: win });
      const size = `${s.width}x${s.height}`;
      return found.length ? found.map((c) => ({ ...mismatch(c.text, size), field: c.field })) : matched(`a ${size} screen${win ? ` and a ${win.width}x${win.height} window` : ""} real systems have`, size);
    } },
]);

// --- The entry ----------------------------------------------------------------------------------

const ITEMS_MAX = 500;
const FAILING = new Set(["mismatch", "unsupported", "not-applied"]);

// requested: what the launch applied, { graphics: { backend, require }, screen, window, locale: {
// timezone, languages }, switches (the launch's final switch list), results (profiles/map.mjs
// toLaunch's items, kept first) }. derived: { build, pack, runtimeKey (this runtime's, native/
// graphics.mjs runtimeKey), platform ("darwin", "linux"), virtualScreen ({ width, height } on
// Xvfb) }. measured: the probe's record (or null: none yet). live: this launch's own backend read
// (E3), for backend.stable. at: the entry's time (default: the measurement's). Returns
// validation[build]: { status, at, pack, runtimeKey?, graphics?, items }; graphics and runtimeKey
// only with a measurement of this pack and runtime key. Never throws.
export function validate({ requested = {}, derived = {}, measured = null, live = null, at = null } = {}) {
  const req = plainObject(requested) ? requested : {};
  const der = plainObject(derived) ? derived : {};
  const pack = typeof der.pack === "string" && SHA256.test(der.pack) ? der.pack : null;
  let m = measuredRecord(measured);
  let stale = null;
  if (m && (m.runtimeKey !== der.runtimeKey || m.pack !== pack)) {
    stale = m.runtimeKey !== der.runtimeKey ? "it was measured on another runtime (graphics, driver or display changed)" : "it was measured with another engine pack";
    m = null;
  }
  const platform = m?.runtime.platform || (der.platform === "darwin" ? "macos" : der.platform === "linux" ? "linux" : null);
  const runtime = runtimeOf({ platform, backend: m?.backend?.kind });
  const ctx = { requested: req, derived: der, measured: m, live: plainObject(live) ? live : null, platform,
    switches: Array.isArray(req.switches) ? req.switches.filter((s) => typeof s === "string") : [] };

  const items = [];
  for (const rule of [...RULES, ...COHERENCE]) {
    let got;
    try { got = rule.check(ctx, rule); } catch { got = unverified("this check couldn't read the measurement"); }
    for (const r of got === null || got === undefined ? [] : Array.isArray(got) ? got : [got]) {
      const field = r.field || rule.field;
      const reason = stale && r.status === "unverified" && !m ? `not measured on this runtime: ${stale}` : r.reason;
      items.push({ field, rule: rule.id, class: classOf(field, runtime) || "M", status: r.status, requested: r.requested ?? null,
        measured: r.measured ?? null, severity: rule.severity, reason: short(reason, 300) ?? null });
    }
  }
  const mapped = Array.isArray(req.results) ? req.results.filter(plainObject) : [];
  const all = [...mapped, ...items].slice(0, ITEMS_MAX);
  const errors = all.filter((i) => i.severity === "error");
  // No engine pack to tie it to (an open build, or a pack not known): the measurement is kept as
  // evidence and the entry stays unverified (E6 names the pack).
  // Every error check passed under the identity a host without a GPU shows: "consistent", the
  // identity checked for consistency, never the host's own graphics (decision 10).
  const status = !m || !pack ? "unverified" : errors.some((i) => FAILING.has(i.status)) ? "failed"
    : errors.some((i) => i.status === "unverified") ? "unverified" : m.shown ? "consistent" : "validated";
  const when = typeof at === "string" && ISO_TIME.test(at) ? at : m?.at || new Date(0).toISOString();
  const entry = { status, at: when, pack, items: all };
  if (m) Object.assign(entry, { runtimeKey: m.runtimeKey, graphics: m });
  return entry;
}

// The status a stored entry gives a launch on this pack and runtime key (E6): its own when it is
// measured evidence of them, else "unverified" (a measurement of another engine pack or runtime
// counts for nothing here, and neither does one without a pack or a launch without one). A runtime
// key left undefined isn't compared (the launch's is known only once the browser answers, section
// 3.2 step 7).
export function entryStatus(entry, { pack, runtimeKey } = {}) {
  if (!plainObject(entry) || entry.status === "unverified") return "unverified";
  if (!plainObject(entry.graphics) || typeof entry.runtimeKey !== "string") return "unverified";
  if (typeof pack !== "string" || !SHA256.test(pack) || entry.pack !== pack) return "unverified";
  if (runtimeKey !== undefined && entry.runtimeKey !== runtimeKey) return "unverified";
  return PASSING_STATUSES.includes(entry.status) || entry.status === "failed" ? entry.status : "unverified";
}
