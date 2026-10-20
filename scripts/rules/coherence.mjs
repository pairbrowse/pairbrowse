// Cross-phase consistency rules (spec server-mode E13): what a browser says about itself that
// sites can see doesn't fit with something else they see. Each rule answers items
// { id, severity: "error" | "warning", text }, text one sentence for a person, naming codes, zones
// and renderer names only, never an address. A rule that can't tell says nothing. Who reads them:
// - the network check (daemon/network.mjs, C13) and Settings' Test: localeVsEgress, against the
//   exit's country;
// - a profile import (profiles/import.mjs, D16) and a launch's evidence (daemon/sessions/
//   profiles.mjs): screenBelievable, warnings only;
// - the validator (native/validate.mjs, E6): gpuVsPlatform and gpuSoftwareAsHardware over a
//   measurement, and screenBelievable over the profile's screen and window, as validation items;
// - a hand-off (daemon/yourturn.mjs, B14): every open item, listed apart from the site's own
//   verification as PairBrowse's to fix (setupLines).
// screen.display (the screen pages read against the one asked for) needs the launch's virtual
// screen, so it stays one of the validator's own rules (native/validate.mjs RULES).
//
// Pure; Node's standard library only.
import { countriesOf } from "./tzcountry.mjs";

// Every rule here, with its severity (the property matrix and the validator name them).
export const COHERENCE_RULES = Object.freeze({
  "gpu.vs-platform": "error", "gpu.software-as-hardware": "error", "screen.believable": "warning",
  "locale.timezone-vs-egress": "error", "locale.language-vs-egress": "warning",
});
export const COHERENCE_RULE_IDS = Object.freeze(Object.keys(COHERENCE_RULES));

const COUNTRY = /^[A-Z]{2}$/;
// A language tag's region ("en-US" -> "US", "zh-Hant-TW" -> "TW"), or null when it names none.
export const regionOf = (tag) => {
  const parts = String(tag || "").split(/[-_]/).slice(1);
  const r = parts.find((p) => /^[A-Za-z]{2}$/.test(p));
  return r ? r.toUpperCase() : null;
};

// The browser's time zone and languages against the country its traffic leaves from (the exit's
// `loc`). timezone: an IANA name; languages: tags, first preferred ("en-US", "de"); country: two
// capital letters. A rule that can't tell (no country, a zone of no country such as UTC, languages
// without a region) says nothing.
// - locale.timezone-vs-egress (error): the time zone isn't one used in the exit's country.
// - locale.language-vs-egress (warning): no language names the exit's country as its region.
// Their items also carry words, the short form a hand-off's report lists (setupLines).
export function localeVsEgress({ timezone = null, languages = [], country = null } = {}) {
  if (!COUNTRY.test(String(country || ""))) return [];
  const items = [];
  const zoneCountries = countriesOf(timezone);
  if (zoneCountries && !zoneCountries.includes(country)) {
    items.push({ id: "locale.timezone-vs-egress", severity: "error", words: `time zone ${timezone} vs egress ${country}`,
      text: `The browser's time zone ${timezone} is used in ${zoneCountries.join(", ")}, but this proxy's exit is in ${country}: sites can see the two don't match.` });
  }
  const regions = [...new Set((Array.isArray(languages) ? languages : [languages]).map(regionOf).filter(Boolean))];
  if (regions.length && !regions.includes(country)) {
    items.push({ id: "locale.language-vs-egress", severity: "warning", words: `languages for ${regions.join(", ")} vs egress ${country}`,
      text: `The browser's languages name ${regions.join(", ")}, but this proxy's exit is in ${country}; that is common for travellers, but sites may notice.` });
  }
  return items;
}

// Screens people really have: ultrawide 32:9 is about 3.56 to 1, so anything wider is made up.
const MAX_ASPECT = 3.6;
// A screen of a profile (its CSS pixels, as profiles/schema.mjs holds it) as sites would see it,
// with the profile's window ({ width, height }) when it sets one. Warnings only (an import reports
// them and never refuses on them, D11):
// - screen.believable: wider or taller than any real screen, an available area larger than the
//   screen or under half of it, a window larger than the screen, more device pixels than any
//   display (16384 a side), or a pixel ratio that isn't a multiple of 0.25 (operating systems
//   scale in those steps).
// Each item also says which setting it is about, field "window" or "screen" (validation items and
// an import's items file it there).
export function screenBelievable(screen, { window = null } = {}) {
  if (!screen || typeof screen !== "object") return [];
  const { width, height, availWidth, availHeight, devicePixelRatio: dpr } = screen;
  if (![width, height].every((n) => Number.isFinite(n) && n > 0)) return [];
  const say = (text, field = "screen") => ({ id: "screen.believable", severity: "warning", field, text });
  const items = [];
  const aspect = Math.max(width, height) / Math.min(width, height);
  if (aspect > MAX_ASPECT) items.push(say(`A ${width}x${height} screen is ${aspect.toFixed(1)} times as wide as it is tall; no real screen is, and sites can see its size.`));
  if ((Number.isFinite(availWidth) && availWidth > width) || (Number.isFinite(availHeight) && availHeight > height)) {
    items.push(say(`${availWidth}x${availHeight} of the ${width}x${height} screen is said to be available to windows, more than the screen itself.`));
  } else if ((Number.isFinite(availWidth) && availWidth < width / 2) || (Number.isFinite(availHeight) && availHeight < height / 2)) {
    items.push(say(`Only ${availWidth}x${availHeight} of the ${width}x${height} screen is available to windows; a real desktop leaves most of it free.`));
  }
  const w = window && typeof window === "object" ? window : null;
  if (w && [w.width, w.height].every((n) => Number.isFinite(n) && n > 0) && (w.width > width || w.height > height)) {
    items.push(say(`A ${w.width}x${w.height} window doesn't fit on a ${width}x${height} screen; sites can see both sizes.`, "window"));
  }
  if (Number.isFinite(dpr)) {
    if (Math.max(width, height) * dpr > 16384) items.push(say(`At a pixel ratio of ${dpr}, a ${width}x${height} screen has more device pixels than any display.`));
    if (Math.abs(dpr * 4 - Math.round(dpr * 4)) > 1e-9) items.push(say(`A pixel ratio of ${dpr} isn't one a system scales to (they step by 0.25).`));
  }
  return items;
}

// --- Graphics -----------------------------------------------------------------------------------

// A software renderer by its name (Mesa's llvmpipe, softpipe and lavapipe, the engine's SwiftShader).
const SOFTWARE = /llvmpipe|softpipe|lavapipe|swiftshader|software rasterizer|basic render driver/i;
// Hardware renderer families, by the names their strings carry.
const FAMILIES = [["apple", /\bapple\b|\bmetal\b/i], ["intel", /\bintel\b/i], ["nvidia", /nvidia|geforce|quadro/i],
  ["amd", /\bamd\b|\bati\b|radeon/i], ["qualcomm", /qualcomm|adreno/i], ["arm", /\bmali\b|\barm\b/i], ["broadcom", /broadcom|videocore/i]];
export const softwareRenderer = (s) => typeof s === "string" && SOFTWARE.test(s);
// A renderer string's family: "software", a hardware family's name, or null when it names none.
export function rendererFamily(s) {
  if (typeof s !== "string" || !s) return null;
  if (softwareRenderer(s)) return "software";
  return FAMILIES.find(([, re]) => re.test(s))?.[0] ?? null;
}
// The system a page sees from navigator.platform ("MacIntel", "Linux x86_64", "Win32"), or from a
// runtime's own name ("macos", "darwin", "linux"): "macos", "linux", "windows", or null.
export function platformOf(s) {
  const v = String(s || "");
  if (/^(?:iphone|ipad)/i.test(v) || /android/i.test(v)) return null; // a phone's or tablet's GPUs aren't a desktop's: not judged here
  if (/^(?:mac|darwin)/i.test(v)) return "macos";
  if (/^win/i.test(v)) return "windows";
  if (/linux|x11|cros/i.test(v)) return "linux";
  return null;
}
// The renderer families a system's real GPUs come from. A Mac has Apple's own, or Intel's and AMD's
// in older ones; Apple's GPUs are in no other system.
const FAMILIES_ON = { macos: ["apple", "intel", "amd"], linux: ["intel", "nvidia", "amd", "qualcomm", "arm", "broadcom"], windows: ["intel", "nvidia", "amd", "qualcomm", "arm"] };

// - gpu.vs-platform (error): the WebGL renderer pages read names a GPU the system they are told
//   about never has (an Apple GPU on Linux, an NVIDIA one on a Mac). platform: navigator.platform
//   as pages read it (or the runtime's name); renderer: WebGL's unmasked renderer.
export function gpuVsPlatform({ platform = null, renderer = null } = {}) {
  const system = platformOf(platform);
  const family = rendererFamily(renderer);
  if (!system || !family || family === "software" || FAMILIES_ON[system].includes(family)) return [];
  const names = { macos: "macOS", linux: "Linux", windows: "Windows" };
  return [{ id: "gpu.vs-platform", severity: "error",
    text: `Pages read a ${family} GPU (${String(renderer).slice(0, 120)}) on ${names[system]}, which has none: sites can see the two don't fit.` }];
}

// - gpu.software-as-hardware (error): the browser renders in software (backend: the browser
//   process's read, native/backend.mjs, kind "software") while pages read a hardware renderer in
//   WebGL or a hardware WebGPU adapter. renderer: WebGL's unmasked renderer; adapter: { vendor,
//   architecture, isFallbackAdapter } of an available WebGPU adapter, or null.
export function gpuSoftwareAsHardware({ backend = null, renderer = null, adapter = null } = {}) {
  if (backend?.kind !== "software") return [];
  const items = [];
  const page = rendererFamily(renderer);
  if (page && page !== "software") {
    items.push({ id: "gpu.software-as-hardware", severity: "error",
      text: `Pages read a hardware GPU (${String(renderer).slice(0, 120)}) while the browser renders in software: what they draw gives it away.` });
  }
  const a = adapter && typeof adapter === "object" ? adapter : null;
  if (a && a.isFallbackAdapter !== true && !softwareRenderer(a.vendor) && !softwareRenderer(a.architecture) && rendererFamily(a.vendor) && rendererFamily(a.vendor) !== "software") {
    items.push({ id: "gpu.software-as-hardware", severity: "error",
      text: `Pages read a ${String(a.vendor).slice(0, 40)} WebGPU adapter while the browser renders in software.` });
  }
  return items;
}

// --- The hand-off report (B14) ------------------------------------------------------------------

// Short words for an item in a status line ("time zone Europe/Berlin vs egress US"), the item's
// own sentence where there are none. item: { id, text, words? }.
export const itemWords = (item) => String(item?.words || item?.text || item?.id || "").slice(0, 200).replace(/[.\s]+$/, "");
// The two lists a hand-off's status result carries (B14), or "" when there is nothing open:
// "Site verification (yours to do): CAPTCHA on <host>" when the step is the site's own check, and
// "PairBrowse setup problems (PairBrowse's to fix): ..." for the open coherence and network items.
// The person is never asked to work around a setup problem: it is PairBrowse's (a profile, a
// proxy, a graphics setting), and it never makes a hand-off by itself.
export function setupLines({ verification = null, items = [] } = {}) {
  const lines = [];
  if (verification) lines.push(`Site verification (yours to do): ${verification}.`);
  const seen = new Set();
  const words = [];
  for (const i of Array.isArray(items) ? items : []) {
    const w = itemWords(i);
    if (w && !seen.has(w)) { seen.add(w); words.push(w); }
  }
  if (words.length) lines.push(`PairBrowse setup problems (PairBrowse's to fix, not the user's to work around): ${words.slice(0, 6).join("; ")}${words.length > 6 ? `; ${words.length - 6} more` : ""}.`);
  return lines.join("\n");
}
